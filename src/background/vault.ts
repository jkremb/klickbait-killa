import { PBKDF2_ITERATIONS } from "../shared/config";
import type { ProviderId } from "../shared/types";

export type VaultKeys = Partial<Record<ProviderId, string>>;

export interface EncryptedVault {
  salt: string;
  iv: string;
  data: string;
  iterations: number;
}

const toBase64 = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptVault(keys: VaultKeys, passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<EncryptedVault> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(keys)));
  return { salt: toBase64(salt), iv: toBase64(iv), data: toBase64(data), iterations };
}

/** Returns undefined for a wrong passphrase or tampered data; AES-GCM can't tell them apart. */
export async function decryptVault(vault: EncryptedVault, passphrase: string): Promise<VaultKeys | undefined> {
  try {
    const key = await deriveKey(passphrase, fromBase64(vault.salt), vault.iterations);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(vault.iv) as BufferSource }, key, fromBase64(vault.data) as BufferSource);
    return JSON.parse(new TextDecoder().decode(plain)) as VaultKeys;
  } catch {
    return undefined;
  }
}

const VAULT_KEY = "vault";
const SESSION_KEY = "unlockedKeys";

/** Encrypted at rest in storage.local; decrypted keys live only in memory-backed storage.session. */
export const vaultStore = {
  async hasVault(): Promise<boolean> {
    return VAULT_KEY in (await browser.storage.local.get(VAULT_KEY));
  },

  async unlockedKeys(): Promise<VaultKeys | undefined> {
    return (await browser.storage.session.get(SESSION_KEY))[SESSION_KEY] as VaultKeys | undefined;
  },

  async create(keys: VaultKeys, passphrase: string): Promise<void> {
    await browser.storage.local.set({ [VAULT_KEY]: await encryptVault(keys, passphrase) });
    await browser.storage.session.set({ [SESSION_KEY]: keys });
  },

  async open(passphrase: string): Promise<VaultKeys | undefined> {
    const vault = (await browser.storage.local.get(VAULT_KEY))[VAULT_KEY] as EncryptedVault | undefined;
    return vault ? decryptVault(vault, passphrase) : undefined;
  },

  async unlock(passphrase: string): Promise<boolean> {
    const keys = await this.open(passphrase);
    if (!keys) return false;
    await browser.storage.session.set({ [SESSION_KEY]: keys });
    return true;
  },

  async lock(): Promise<void> {
    await browser.storage.session.remove(SESSION_KEY);
  },
};
