import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

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
