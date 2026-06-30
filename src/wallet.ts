import type { SolanaProvider } from './types';

// ─── Phantom (mode manuel) ───────────────────────────────────────────────────

export function getPhantomProvider(): SolanaProvider | null {
  return window.solana ?? null;
}

export function isPhantomAvailable(): boolean {
  return Boolean(window.solana?.isPhantom);
}

export async function connectPhantom(): Promise<string> {
  const p = getPhantomProvider();
  if (!p) {
    const url = encodeURIComponent(window.location.href);
    window.location.href = `https://phantom.app/ul/browse/${url}`;
    throw new Error('Redirection vers Phantom…');
  }
  const { publicKey } = await p.connect();
  return publicKey.toBase58();
}

export async function disconnectPhantom(): Promise<void> {
  await getPhantomProvider()?.disconnect();
}

export async function phantomSignAndSend(tx: unknown): Promise<string> {
  const p = getPhantomProvider();
  if (!p) throw new Error('Phantom non disponible');
  const { signature } = await p.signAndSendTransaction(tx);
  return signature;
}

export function phantomPublicKey(): string | null {
  return window.solana?.publicKey?.toBase58() ?? null;
}
