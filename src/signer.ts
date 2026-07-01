import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

// RPC endpoints de secours si le principal échoue
const FALLBACK_RPCS = [
  'https://rpc.ankr.com/solana',
  'https://api.mainnet-beta.solana.com',
  'https://solana-mainnet.rpc.extrnode.com',
];

export function keypairFromBase58(privateKeyBase58: string): Keypair {
  const secret = bs58.decode(privateKeyBase58);
  if (secret.length !== 64) {
    throw new Error('Clé privée invalide — doit faire 64 octets en base58.');
  }
  return Keypair.fromSecretKey(secret);
}

async function trySignAndSend(
  tx: VersionedTransaction,
  keypair: Keypair,
  rpcEndpoint: string,
): Promise<string> {
  const connection = new Connection(rpcEndpoint, 'confirmed');

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('finalized');

  // Signer une copie fraîche (le blockhash change à chaque tentative)
  const freshTx = VersionedTransaction.deserialize(tx.serialize());
  freshTx.message.recentBlockhash = blockhash;
  freshTx.sign([keypair]);

  const signature = await connection.sendRawTransaction(freshTx.serialize(), {
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

export async function signAndSendLocal(
  tx: VersionedTransaction,
  keypair: Keypair,
  preferredRpc: string,
): Promise<string> {
  // Essaie le RPC préféré en premier, puis les fallbacks
  const rpcs = [preferredRpc, ...FALLBACK_RPCS.filter(r => r !== preferredRpc)];
  const errors: string[] = [];

  for (const rpc of rpcs) {
    try {
      return await trySignAndSend(tx, keypair, rpc);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // Ne pas réessayer sur erreur métier (fonds insuffisants, etc.)
      if (
        msg.includes('insufficient') ||
        msg.includes('insufficient lamports') ||
        msg.includes('0x1') // InsufficientFunds
      ) {
        throw new Error(
          `Fonds insuffisants.\n` +
          `• Vérifie que le wallet a des USDC à dépenser.\n` +
          `• Assure-toi d'avoir au moins 0,01 SOL pour les frais de transaction.`,
        );
      }
      errors.push(`${rpc}: ${msg}`);
    }
  }

  throw new Error(
    `Transaction échouée sur tous les RPC.\n` +
    `Vérifie ta connexion internet et réessaie.\n` +
    `Détails : ${errors[0]}`,
  );
}
