// AES-GCM key derived from a PIN via PBKDF2

const PBKDF2_ITERATIONS = 200_000;

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(n));
  crypto.getRandomValues(buf);
  return buf;
}

async function deriveAESKey(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export interface EncryptedBlob {
  ciphertext: ArrayBuffer;
  salt: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
}

export async function encryptKey(plaintext: string, pin: string): Promise<EncryptedBlob> {
  const salt = randomBytes(16);
  const iv   = randomBytes(12);
  const key  = await deriveAESKey(pin, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext, salt, iv };
}

export async function decryptKey(blob: EncryptedBlob, pin: string): Promise<string> {
  const key = await deriveAESKey(pin, blob.salt);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: blob.iv },
    key,
    blob.ciphertext,
  );
  return new TextDecoder().decode(plain);
}

export async function exportAutoKey(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const key = await deriveAESKey(pin, salt);
  return crypto.subtle.exportKey('raw', key);
}

export async function importAutoKey(raw: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

export async function decryptWithAutoKey(
  aesKey: CryptoKey,
  blob: Pick<EncryptedBlob, 'ciphertext' | 'iv'>,
): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: blob.iv },
    aesKey,
    blob.ciphertext,
  );
  return new TextDecoder().decode(plain);
}
