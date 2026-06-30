import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

export function keypairFromBase58(privateKeyBase58: string): Keypair {
  const secret = bs58.decode(privateKeyBase58);
  if (secret.length !== 64) {
    throw new Error('Clé privée invalide — doit faire 64 octets en base58.');
  }
  return Keypair.fromSecretKey(secret);
}

export async function signAndSendLocal(
  tx: VersionedTransaction,
  keypair: Keypair,
  rpcEndpoint: string,
): Promise<string> {
  const connection = new Connection(rpcEndpoint, 'confirmed');

  // Refresh blockhash to avoid expiry
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('finalized');

  tx.message.recentBlockhash = blockhash;
  tx.sign([keypair]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );

  return signature;
}
