import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { USDC_MINT } from './strategy';
import type { TriggerTx } from './jupiter';

// Sign a Jupiter Trigger transaction and submit it via Jupiter's /execute
// endpoint (Jupiter broadcasts & lands it). Do NOT touch the blockhash — the
// transaction is used exactly as Jupiter built it.
export async function executeTrigger(
  triggerTx: TriggerTx,
  keypair: Keypair,
): Promise<string> {
  triggerTx.tx.sign([keypair]);
  const signedTransaction = Buffer.from(triggerTx.tx.serialize()).toString('base64');

  const res = await fetch(`${location.origin}/api/trigger-execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedTransaction, requestId: triggerTx.requestId }),
  });
  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  const status = (data as { status?: string }).status;
  const signature = (data as { signature?: string }).signature;
  if (!res.ok || status !== 'Success' || !signature) {
    const err = (data as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(`Exécution Trigger échouée : ${err}`);
  }
  return signature;
}

// All RPC traffic goes through our same-origin Vercel proxy (/api/rpc),
// which fans out server-side to keyless public Solana RPC providers.
// This avoids CORS and dead public endpoints on mobile networks.
// A user-supplied dedicated RPC (e.g. Helius) is forwarded as ?upstream=.
function proxyRpcUrl(customUpstream?: string): string {
  const base = `${location.origin}/api/rpc`;
  if (customUpstream && /^https?:\/\//.test(customUpstream)) {
    return `${base}?upstream=${encodeURIComponent(customUpstream)}`;
  }
  return base;
}

// Native SOL balance (lamports) of a wallet, via the RPC proxy.
export async function getWalletSolLamports(
  pubkey: string,
  preferredRpc: string,
): Promise<number> {
  const connection = new Connection(proxyRpcUrl(preferredRpc), 'confirmed');
  return connection.getBalance(new PublicKey(pubkey), 'confirmed');
}

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Derive the associated USDC token account for an owner.
function usdcAta(owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(USDC_MINT).toBuffer()],
    ATA_PROGRAM,
  );
  return ata;
}

// USDC balance (micro-USDC) in the wallet's associated USDC account.
// Uses getTokenAccountBalance (supported by every RPC) rather than a
// jsonParsed account scan (which some public RPCs don't support).
export async function getWalletUsdcMicro(
  pubkey: string,
  preferredRpc: string,
): Promise<number> {
  const connection = new Connection(proxyRpcUrl(preferredRpc), 'confirmed');
  const ata = usdcAta(new PublicKey(pubkey));
  try {
    const bal = await connection.getTokenAccountBalance(ata, 'confirmed');
    return Number(bal.value.amount);
  } catch {
    // Account may not exist yet (never received USDC) → 0.
    return 0;
  }
}

export function keypairFromBase58(privateKeyBase58: string): Keypair {
  const secret = bs58.decode(privateKeyBase58);
  if (secret.length !== 64) {
    throw new Error('Clé privée invalide — doit faire 64 octets en base58.');
  }
  return Keypair.fromSecretKey(secret);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function signAndSendLocal(
  tx: VersionedTransaction,
  keypair: Keypair,
  preferredRpc: string, // optional dedicated RPC; else the proxy's public pool
): Promise<string> {
  const connection = new Connection(proxyRpcUrl(preferredRpc), 'confirmed');

  // Fresh 'confirmed' blockhash = maximum validity window (~60s).
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  // Sign a fresh copy with the current blockhash.
  const freshTx = VersionedTransaction.deserialize(tx.serialize());
  freshTx.message.recentBlockhash = blockhash;
  freshTx.sign([keypair]);
  const rawTx = freshTx.serialize();

  // First send WITH preflight to surface business errors (insufficient funds…).
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 5,
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (msg.includes('insufficient') || msg.includes('0x1')) {
      throw new Error(
        'Fonds insuffisants.\n' +
        '• Vérifie que le wallet a des USDC à dépenser.\n' +
        "• Assure-toi d'avoir au moins 0,01 SOL pour les frais.",
      );
    }
    throw err;
  }

  // Public RPCs drop transactions, so rebroadcast aggressively while polling.
  // We poll signature status (with history) rather than comparing block
  // heights across upstreams, which is unreliable through a fan-out proxy.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    // Rebroadcast the same signed tx to keep it alive at the leader.
    await connection
      .sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 5 })
      .catch(() => { /* transient; keep polling */ });

    const { value } = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    if (value) {
      if (value.err) {
        throw new Error(`Transaction rejetée on-chain : ${JSON.stringify(value.err)}`);
      }
      if (
        value.confirmationStatus === 'confirmed' ||
        value.confirmationStatus === 'finalized'
      ) {
        return signature;
      }
    }

    await sleep(2500);
  }

  // Final check: it may have landed just as we timed out.
  const final = await connection
    .getSignatureStatus(signature, { searchTransactionHistory: true })
    .catch(() => null);
  if (final?.value && !final.value.err) return signature;

  throw new Error(
    'Transaction non confirmée à temps. Les RPC publics gratuits abandonnent ' +
    'souvent les transactions.\nRéessaie, ou configure un RPC dédié dans Réglages.',
  );
}
