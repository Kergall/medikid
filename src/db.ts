// IndexedDB wrapper — used for secure key storage (accessible by service worker)

const DB_NAME = 'sol_dca_secure';
const DB_VERSION = 1;
const STORE = 'kv';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      (e.target as IDBOpenDBRequest).result.createObjectStore(STORE);
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror   = (e) => reject((e.target as IDBOpenDBRequest).error);
  });
}

export async function dbSet(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

export async function dbGet<T>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror   = () => reject(req.error);
  });
}

export async function dbDel(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ─── Typed accessors ─────────────────────────────────────────────────────────

import type { EncryptedBlob } from './crypto';

export interface StoredKey {
  ciphertext: ArrayBuffer;
  salt: ArrayBuffer;
  iv: ArrayBuffer;
}

export async function saveEncryptedKey(blob: EncryptedBlob): Promise<void> {
  await dbSet('enc_key', {
    ciphertext: blob.ciphertext,
    salt: blob.salt.buffer as ArrayBuffer,
    iv: blob.iv.buffer as ArrayBuffer,
  });
}

export async function loadEncryptedKey(): Promise<EncryptedBlob | null> {
  const stored = await dbGet<StoredKey>('enc_key');
  if (!stored) return null;
  return {
    ciphertext: stored.ciphertext,
    salt: new Uint8Array(stored.salt) as Uint8Array<ArrayBuffer>,
    iv: new Uint8Array(stored.iv) as Uint8Array<ArrayBuffer>,
  };
}

export async function saveAutoKey(raw: ArrayBuffer): Promise<void> {
  await dbSet('auto_key', raw);
}

export async function loadAutoKey(): Promise<ArrayBuffer | null> {
  return dbGet<ArrayBuffer>('auto_key');
}

export async function clearAutoKey(): Promise<void> {
  await dbDel('auto_key');
}

export async function saveWalletAddress(addr: string): Promise<void> {
  await dbSet('wallet_addr', addr);
}

export async function loadWalletAddress(): Promise<string | null> {
  return dbGet<string>('wallet_addr');
}

/** Mirror lastDCADate in IndexedDB so the SW can read it. */
export async function saveLastDCADate(date: string | null): Promise<void> {
  await dbSet('last_dca_date', date);
}
