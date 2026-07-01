import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

// All RPC traffic goes through our same-origin Vercel proxy (/api/rpc),
// which fans out server-side to keyless public Solana RPC providers.
// This avoids CORS and dead public endpoints on mobile networks.
function proxyRpcUrl(): string {
  return `${location.origin}/api/rpc`;
}

export function keypairFromBase58(privateKeyBase58: string): Keypair {
  const secret = bs58.decode(privateKeyBase58);
  if (secret.length !== 64) {
    throw new Error('Clé privée invalide — doit faire 64 octets en base58.');
  }
  return Keypair.fromSecretKey(secret);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Confirm by polling signature status over HTTP (no WebSocket subscription).
async function confirmViaPolling(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<void> {
  const deadline = Date.now() + 90_000; // hard cap ~90s
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: false,
    });
    if (value) {
      if (value.err) {
        throw new Error(`Transaction rejetée on-chain : ${JSON.stringify(value.err)}`);
      }
      if (
        value.confirmationStatus === 'confirmed' ||
        value.confirmationStatus === 'finalized'
      ) {
        return;
      }
    }
    const height = await connection.getBlockHeight('confirmed');
    if (height > lastValidBlockHeight) {
      throw new Error('Transaction expirée (blockhash périmé) — réessaie.');
    }
    await sleep(2000);
  }
  throw new Error('Délai de confirmation dépassé — réessaie.');
}

export async function signAndSendLocal(
  tx: VersionedTransaction,
  keypair: Keypair,
  _preferredRpc: string, // kept for compatibility; RPC now goes through the proxy
): Promise<string> {
  const connection = new Connection(proxyRpcUrl(), 'confirmed');

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('finalized');

  // Sign a fresh copy with the current blockhash.
  const freshTx = VersionedTransaction.deserialize(tx.serialize());
  freshTx.message.recentBlockhash = blockhash;
  freshTx.sign([keypair]);

  let signature: string;
  try {
    signature = await connection.sendRawTransaction(freshTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
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

  await confirmViaPolling(connection, signature, lastValidBlockHeight);
  return signature;
}
