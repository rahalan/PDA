import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DEK_FILE = 'vault/dek.wrapped';
const KEK_ALGORITHM = 'RSA-OAEP-256';
const KV_PREFIX = 'kv1:';

function base64(input) {
  return Buffer.from(input).toString('base64');
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'base64');
  }
  throw new Error('Unsupported binary payload');
}

function loadDpapi() {
  if (process.platform !== 'win32') {
    throw new Error('DPAPI is only supported on Windows');
  }

  const dependencyRoot = path.resolve(
    process.env.PDA_DEPENDENCIES || path.join(process.env.LOCALAPPDATA || os.homedir(), 'PDA', 'sdk-demo', 'dependencies'),
  );

  let packageExports;
  try {
    const dependencyRequire = createRequire(path.join(dependencyRoot, 'package.json'));
    packageExports = dependencyRequire('@primno/dpapi');
  } catch {
    throw new Error(`Unable to load @primno/dpapi from ${path.join(dependencyRoot, 'node_modules', '@primno', 'dpapi')}`);
  }

  if (!packageExports?.isPlatformSupported) {
    throw new Error('DPAPI is not supported on this platform');
  }

  const bindings = packageExports.Dpapi ?? packageExports.default;
  if (!bindings || typeof bindings.protectData !== 'function' || typeof bindings.unprotectData !== 'function') {
    throw new Error('Unable to resolve DPAPI bindings');
  }

  return bindings;
}

// Windows DPAPI protector — preserves the original local-demo at-rest format.
export function createDpapiProtector() {
  const dpapi = loadDpapi();
  return {
    mode: 'dpapi',
    protect(value) {
      const sealed = dpapi.protectData(Buffer.from(String(value), 'utf8'), null, 'CurrentUser');
      return base64(toBuffer(sealed));
    },
    unprotect(value) {
      const decrypted = dpapi.unprotectData(toBuffer(value), null, 'CurrentUser');
      const text = Buffer.from(decrypted).toString('utf8');
      try {
        const parsed = JSON.parse(text);
        return typeof parsed === 'string' ? parsed : text;
      } catch {
        return text;
      }
    },
  };
}

// Azure Key Vault protector — envelope encryption. A locally generated AES-256-GCM
// data key is wrapped by a Key Vault key. Only the wrap/unwrap of the data key
// touches Key Vault (once at startup); per-value protect/unprotect stays local and
// synchronous so the storage layer keeps its synchronous contract.
export async function createKeyVaultProtector(stateDir) {
  const vaultUri = process.env.AZURE_KEY_VAULT_URI || process.env.KEY_VAULT_URI;
  if (!vaultUri) {
    throw new Error('AZURE_KEY_VAULT_URI is required for the Key Vault protector');
  }
  const keyName = process.env.PDA_KEK_NAME || 'pda-kek';

  const { DefaultAzureCredential } = await import('@azure/identity');
  const { KeyClient, CryptographyClient } = await import('@azure/keyvault-keys');

  const credential = new DefaultAzureCredential();
  const keyClient = new KeyClient(vaultUri, credential);
  const dekPath = path.join(stateDir, DEK_FILE);
  let dek;
  if (fs.existsSync(dekPath)) {
    let envelope;
    try { envelope = JSON.parse(fs.readFileSync(dekPath, 'utf8')); }
    catch { throw new Error('Legacy wrapped DEK has no key version. Recover its original Key Vault key ID before migrating; no key was replaced.'); }
    const keyId = new URL(envelope.keyId);
    if (keyId.origin !== new URL(vaultUri).origin || keyId.search || keyId.hash
      || !keyId.pathname.startsWith(`/keys/${keyName}/`) || keyId.pathname.split('/').length !== 4
      || !keyId.pathname.split('/')[3] || envelope.algorithm !== KEK_ALGORITHM || envelope.version !== 1) {
      throw new Error('Invalid wrapped data key envelope');
    }
    const cryptoClient = new CryptographyClient(keyId.href, credential);
    const wrapped = toBuffer(envelope.wrappedKey);
    const { result } = await cryptoClient.unwrapKey(KEK_ALGORITHM, wrapped);
    dek = Buffer.from(result);
  } else {
    const kek = await keyClient.getKey(keyName);
    const cryptoClient = new CryptographyClient(kek.id, credential);
    dek = crypto.randomBytes(32);
    const { result } = await cryptoClient.wrapKey(KEK_ALGORITHM, dek);
    fs.mkdirSync(path.dirname(dekPath), { recursive: true });
    const tempPath = `${dekPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ version: 1, keyId: kek.id, algorithm: KEK_ALGORITHM, wrappedKey: base64(toBuffer(result)) }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, dekPath);
  }
  if (dek.length !== 32) {
    throw new Error('Data encryption key is not 256 bits');
  }

  return {
    mode: 'keyvault',
    protect(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(String(value), 'utf8')), cipher.final()]);
      const tag = cipher.getAuthTag();
      return KV_PREFIX + base64(Buffer.concat([iv, tag, ciphertext]));
    },
    unprotect(value) {
      const text = String(value);
      if (!text.startsWith(KV_PREFIX)) {
        throw new Error('Unsupported protected payload');
      }
      const raw = Buffer.from(text.slice(KV_PREFIX.length), 'base64');
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const ciphertext = raw.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
}

// Selects the at-rest protector. Defaults to DPAPI on Windows (unchanged local demo)
// and Key Vault elsewhere. Override explicitly with PDA_PROTECTOR=dpapi|keyvault.
export async function createProtector(stateDir) {
  const mode = (process.env.PDA_PROTECTOR || (process.platform === 'win32' ? 'dpapi' : 'keyvault')).toLowerCase();
  if (mode === 'dpapi') {
    return createDpapiProtector();
  }
  if (mode === 'keyvault') {
    return createKeyVaultProtector(stateDir);
  }
  throw new Error(`Unknown PDA_PROTECTOR mode: ${mode}`);
}

// Plaintext fallback, used only when a Store is created without an explicit protector and DPAPI is
// unavailable (tests, non-Windows dev). Never reached in cloud, where PDA_PROTECTOR=keyvault passes
// the Key Vault protector to the Store explicitly.
export function createPassthroughProtector() {
  return {
    mode: 'plaintext',
    protect(value) { return String(value); },
    unprotect(value) { return String(value); },
  };
}

// Default protector for a Store when the caller passes none: DPAPI when it loads, else plaintext.
export function createDefaultProtector() {
  try {
    return createDpapiProtector();
  } catch {
    return createPassthroughProtector();
  }
}
