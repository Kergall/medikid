import type { SolanaProvider } from './types';

export function getProvider(): SolanaProvider | null {
  return window.solana ?? null;
}

export function isPhantomAvailable(): boolean {
  return Boolean(window.solana?.isPhantom);
}

export async function connectWallet(): Promise<string> {
  const provider = getProvider();
  if (!provider) {
    // On mobile without Phantom in-app browser → deep link
    const currentUrl = encodeURIComponent(window.location.href);
    window.location.href = `https://phantom.app/ul/browse/${currentUrl}`;
    throw new Error('Redirection vers Phantom…');
  }
  const { publicKey } = await provider.connect();
  return publicKey.toBase58();
}

export async function disconnectWallet(): Promise<void> {
  const provider = getProvider();
  if (provider) await provider.disconnect();
}

export async function signAndSend(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction: any,
): Promise<string> {
  const provider = getProvider();
  if (!provider) throw new Error('Wallet non connecté');
  const { signature } = await provider.signAndSendTransaction(transaction);
  return signature;
}

export function walletPublicKey(): string | null {
  return window.solana?.publicKey?.toBase58() ?? null;
}
