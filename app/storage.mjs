import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createDefaultProtector } from './protector.mjs';

const PRIVATE_KEY_FILE = 'vault/signing-key.bin';
const PUBLIC_KEY_FILE = 'vault/signing-key.public';
const LEDGER_FILE = 'ledger.jsonl';
const CHECKPOINT_FILE = 'ledger.checkpoint.json';
const SECRET_MAX_LENGTH = 8192;
const MAX_LEDGER_RECORDS = 20000;
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function structuredCloneFallback(value) {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }

  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') {
      return JSON.stringify(value.toString());
    }
    if (value === undefined) {
      return 'null';
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }

  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function deepClone(value) {
  return structuredCloneFallback(value);
}

function normalizePem(value) {
  return String(value ?? '').trim();
}

function normalizeSecretText(value) {
  if (typeof value !== 'string') {
    throw new Error('Secrets must be strings');
  }

  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > SECRET_MAX_LENGTH) {
    throw new Error('Secret length is out of bounds');
  }

  return normalized;
}

function isSamePathOrDescendant(candidate, ancestor) {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedAncestor = path.resolve(ancestor);
  const candidateLower = normalizedCandidate.toLowerCase();
  const ancestorLower = normalizedAncestor.toLowerCase();
  return candidateLower === ancestorLower || candidateLower.startsWith(`${ancestorLower}${path.sep}`);
}

function findRepoRoot() {
  return MODULE_ROOT;
}

function deepestExistingParent(targetPath) {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return current;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function atomicWriteJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tempPath, 'w');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // ignore cleanup failures for temp files
      }
    }
    throw error;
  }
}

function readJson(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(text);
}

function recordBody(entry) {
  const { hash, signature, publicKey, algorithm, issuer, ...body } = entry;
  return body;
}

function sortLedgerRecords(records) {
  return records.slice().sort((left, right) => left.seq - right.seq);
}

function _lockPath(stateDir) {
  const root = Store.prototype._resolveRoot.call({ repoRoot: MODULE_ROOT }, stateDir);
  ensureDir(root);
  return path.join(root, 'writer.lock');
}

// The lock holder refreshes its heartbeat on this cadence; a starter reclaims a lock whose heartbeat
// is older than the stale window (i.e. the previous holder terminated without releasing it).
const LOCK_HEARTBEAT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

function _writeLock(lockPath, owner, flags) {
  const descriptor = fs.openSync(lockPath, flags, 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(owner)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function _claimLock(lockPath) {
  const token = crypto.randomUUID();
  const owner = { host: os.hostname(), pid: process.pid, token, heartbeat: Date.now() };
  _writeLock(lockPath, owner, 'wx'); // 'wx' fails if a lock file already exists
  const heartbeat = setInterval(() => {
    try { owner.heartbeat = Date.now(); _writeLock(lockPath, owner, 'w'); }
    catch { /* transient share error; the next tick retries */ }
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  return () => {
    clearInterval(heartbeat);
    try {
      if (!fs.existsSync(lockPath)) return;
      if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).token === token) fs.unlinkSync(lockPath);
    } catch { /* released concurrently or torn read; nothing to clean up */ }
  };
}

// A lock is reclaimable only when its holder has stopped refreshing the heartbeat. A torn read during a
// heartbeat write, or a lock that just disappeared, is treated as not-stale so a live holder is never
// displaced (two concurrent writers would corrupt the append-only ledger). Locks written before the
// heartbeat existed fall back to file mtime.
function _lockIsStale(lockPath) {
  try {
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const last = typeof held.heartbeat === 'number' ? held.heartbeat : fs.statSync(lockPath).mtimeMs;
    return Date.now() - last > LOCK_STALE_MS;
  } catch { return false; }
}

const LOCK_HELD_MESSAGE = 'State is locked. Stop the previous writer; after a crash, an operator must verify it is stopped before removing writer.lock.';

// Fail-fast, single attempt. The repository-root check throws synchronously.
export function acquireStateLock(stateDir) {
  const lockPath = _lockPath(stateDir);
  try { return _claimLock(lockPath); }
  catch {
    if (_lockIsStale(lockPath)) {
      try { fs.unlinkSync(lockPath); return _claimLock(lockPath); } catch { /* fall through */ }
    }
    throw new Error(LOCK_HELD_MESSAGE);
  }
}

// Non-blocking acquisition. A rolling Container Apps deploy briefly overlaps old and new revisions on
// the shared state volume; in remote mode wait (without freezing the event loop, so /healthz keeps
// answering) for the previous writer to release its lock on graceful shutdown. A holder that dies
// ungracefully leaves an orphaned lock; reclaim it once its heartbeat goes stale so the app self-heals
// instead of crash-looping forever.
export async function acquireStateLockAsync(stateDir) {
  const lockPath = _lockPath(stateDir);
  const deadline = Date.now() + (process.env.PDA_ALLOW_REMOTE === '1' ? 120_000 : 0);
  for (;;) {
    try { return _claimLock(lockPath); }
    catch {
      if (_lockIsStale(lockPath)) {
        try { fs.unlinkSync(lockPath); } catch { /* another starter reclaimed it first */ }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(LOCK_HELD_MESSAGE);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

export class Store {
  constructor(stateDir, options = {}) {
    this.repoRoot = findRepoRoot();
    this.root = this._resolveRoot(stateDir);
    this._protector = options.protector || createDefaultProtector();
    // Optional, non-authoritative mirror of ledger appends (e.g. OpenTelemetry). Never load-bearing.
    this._onAppend = typeof options.onAppend === 'function' ? options.onAppend : null;
    this._ledgerPath = path.join(this.root, LEDGER_FILE);
    this._checkpointPath = path.join(this.root, CHECKPOINT_FILE);
    this._privateKeyPath = path.join(this.root, PRIVATE_KEY_FILE);
    this._publicKeyPath = path.join(this.root, PUBLIC_KEY_FILE);
    this._ledger = [];
    this._privateKey = undefined;
    this._publicKey = undefined;
    this._poisonedError = undefined;

    ensureDir(this.root);
    ensureDir(path.dirname(this._privateKeyPath));
    ensureDir(path.dirname(this._publicKeyPath));

    this._loadOrCreateKeyPair();
    this._ledger = this._loadLedger();
    if (!fs.existsSync(this._checkpointPath)) {
      if (this._ledger.length > 0) {
        throw new Error('Missing ledger checkpoint');
      }
      this._writeCheckpoint(this._genesisCheckpoint());
    }

    this._verifyLedgerOrThrow();
  }

  seal(value) {
    this._assertHealthy();
    const payload = deepClone(value);
    const payloadDigest = sha256Hex(canonicalize(payload));
    const signature = crypto.sign(null, Buffer.from(payloadDigest, 'utf8'), this._privateKey).toString('base64');

    return {
      payload,
      digest: payloadDigest,
      signature,
      publicKey: this._publicKey,
      algorithm: 'Ed25519',
      issuer: 'CG Demo Authority',
      demo: true,
    };
  }

  verify(sealed) {
    const publicKey = normalizePem(sealed?.publicKey);
    if (!sealed || sealed.algorithm !== 'Ed25519' || sealed.issuer !== 'CG Demo Authority' || sealed.demo !== true) {
      return false;
    }

    if (sealed.payload === undefined || sealed.payload === null || typeof sealed.digest !== 'string' || typeof sealed.signature !== 'string' || publicKey !== this._publicKey) {
      return false;
    }

    const expectedDigest = sha256Hex(canonicalize(sealed.payload));
    if (expectedDigest !== sealed.digest) {
      return false;
    }

    try {
      return crypto.verify(
        null,
        Buffer.from(sealed.digest, 'utf8'),
        sealed.publicKey,
        Buffer.from(sealed.signature, 'base64'),
      );
    } catch {
      return false;
    }
  }

  append(kind, data = {}) {
    this._assertHealthy();
    this.assertLedgerCapacity(1);

    const previousHash = this._ledger.at(-1)?.hash ?? 'GENESIS';
    const base = {
      ...deepClone(data),
      seq: this._ledger.length + 1,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind,
      previousHash,
      demoCredentials: true,
    };

    const hash = sha256Hex(canonicalize(base));
    const signature = crypto.sign(null, Buffer.from(hash, 'utf8'), this._privateKey).toString('base64');
    const record = {
      ...base,
      hash,
      signature,
      publicKey: this._publicKey,
      algorithm: 'Ed25519',
      issuer: 'CG Demo Authority',
    };

    this._appendLedgerRecord(record);
    if (this._onAppend) {
      try {
        this._onAppend(record);
      } catch {
        // A telemetry mirror must never break or slow the authoritative ledger.
      }
    }
    return record;
  }

  records() {
    this._assertHealthy();
    return deepClone(this._ledger);
  }

  capacity() {
    this._assertHealthy();
    return {
      used: this._ledger.length,
      limit: MAX_LEDGER_RECORDS,
      remaining: Math.max(0, MAX_LEDGER_RECORDS - this._ledger.length),
    };
  }

  assertLedgerCapacity(required = 1) {
    this._assertHealthy();
    const count = Number(required);
    if (!Number.isInteger(count) || count < 0) throw new Error('Invalid ledger capacity request');
    if (this._ledger.length + count > MAX_LEDGER_RECORDS) {
      const error = new Error('Ledger limit reached');
      error.code = 'ledger_capacity';
      throw error;
    }
    return this.capacity();
  }

  verifyLedger() {
    try {
      this._assertHealthy();
      this._verifyLedgerOrThrow();
      return {
        ok: true,
        checked: this._loadLedger().length,
        storage: 'signed append-only file; not immutable storage',
      };
    } catch (error) {
      return {
        ok: false,
        checked: this._ledger.length,
        error: error instanceof Error ? error.message : String(error),
        storage: 'signed append-only file; not immutable storage',
      };
    }
  }

  save(name, value) {
    this._assertHealthy();
    this._assertSafeName(name);
    const filePath = path.join(this.root, `${name}.json`);
    atomicWriteJson(filePath, value);
    return deepClone(value);
  }

  load(name, fallback) {
    this._assertHealthy();
    this._assertSafeName(name);
    const filePath = path.join(this.root, `${name}.json`);

    if (!fs.existsSync(filePath)) {
      return fallback === undefined ? undefined : deepClone(fallback);
    }

    try {
      return readJson(filePath);
    } catch (error) {
      throw new Error(`Corrupt JSON in ${name}.json`);
    }
  }

  setSecret(name, value) {
    this._assertHealthy();
    this._assertSafeName(name);
    const filePath = path.join(this.root, 'secrets', `${name}.bin`);

    if (value === undefined) {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
      return undefined;
    }

    ensureDir(path.dirname(filePath));
    const protectedText = this._protector.protect(normalizeSecretText(value));
    fs.writeFileSync(filePath, protectedText, 'utf8');
    return value;
  }

  getSecret(name) {
    this._assertHealthy();
    this._assertSafeName(name);
    const filePath = path.join(this.root, 'secrets', `${name}.bin`);
    if (!fs.existsSync(filePath)) {
      return undefined;
    }

    try {
      const secret = this._protector.unprotect(fs.readFileSync(filePath, 'utf8'));
      return normalizeSecretText(secret);
    } catch {
      throw new Error(`Corrupt secret ${name}`);
    }
  }

  secretPresent(name) {
    this._assertHealthy();
    this._assertSafeName(name);
    return fs.existsSync(path.join(this.root, 'secrets', `${name}.bin`));
  }

  _resolveRoot(stateDir) {
    const defaultRoot = path.join(process.env.LOCALAPPDATA || os.homedir(), 'PDA', 'sdk-demo', 'state');
    const candidate = path.resolve(stateDir || process.env.PDA_STATE_DIR || defaultRoot);
    const repoRoot = this.repoRoot;

    if (isSamePathOrDescendant(candidate, repoRoot)) {
      throw new Error('State directory must be outside the repository');
    }

    const existingParent = deepestExistingParent(candidate);
    if (existingParent) {
      let realExisting;
      try {
        realExisting = fs.realpathSync(existingParent);
      } catch {
        realExisting = undefined;
      }
      if (realExisting && isSamePathOrDescendant(realExisting, repoRoot)) {
        throw new Error('State directory must be outside the repository');
      }
    }

    return candidate;
  }

  _loadOrCreateKeyPair() {
    const hasPrivate = fs.existsSync(this._privateKeyPath);
    const hasPublic = fs.existsSync(this._publicKeyPath);
    const hasPersistentState = this._hasPersistentState();

    if (hasPrivate !== hasPublic) {
      throw new Error('Corrupt key pair');
    }

    if (hasPrivate && hasPublic) {
      const privatePem = normalizePem(this._protector.unprotect(fs.readFileSync(this._privateKeyPath, 'utf8')));
      const publicPem = normalizePem(fs.readFileSync(this._publicKeyPath, 'utf8'));
      this._privateKey = crypto.createPrivateKey(privatePem);
      this._publicKey = publicPem;
      const derivedPublic = normalizePem(crypto.createPublicKey(this._privateKey).export({ format: 'pem', type: 'spki' }).toString());
      if (derivedPublic !== publicPem) {
        throw new Error('Corrupt key pair');
      }
      return;
    }

    if (hasPersistentState) {
      throw new Error('Missing key pair for existing storage');
    }

    const pair = crypto.generateKeyPairSync('ed25519');
    this._privateKey = pair.privateKey;
    this._publicKey = normalizePem(pair.publicKey.export({ format: 'pem', type: 'spki' }).toString());
    fs.writeFileSync(this._publicKeyPath, `${this._publicKey}\n`, 'utf8');
    fs.writeFileSync(this._privateKeyPath, this._protector.protect(pair.privateKey.export({ format: 'pem', type: 'pkcs8' })), 'utf8');
  }

  _loadLedger() {
    if (!fs.existsSync(this._ledgerPath)) {
      return [];
    }

    const content = fs.readFileSync(this._ledgerPath, 'utf8').trim();
    if (!content) {
      return [];
    }

    return content.split(/\r?\n/).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error('Corrupt ledger file');
      }
    });
  }

  _verifyLedgerOrThrow() {
    const ordered = this._loadLedger();
    for (let index = 0; index < ordered.length; index += 1) {
      const record = ordered[index];
      if (record.seq !== index + 1) {
        throw new Error('Ledger sequence mismatch');
      }
      const body = recordBody(record);
      const expectedPrevious = index === 0 ? 'GENESIS' : ordered[index - 1].hash;
      if (record.previousHash !== expectedPrevious) {
        throw new Error('Ledger chain mismatch');
      }
      if (record.hash !== sha256Hex(canonicalize(body))) {
        throw new Error('Ledger hash mismatch');
      }
      if (!this.verify({ payload: body, digest: record.hash, signature: record.signature, publicKey: record.publicKey, algorithm: record.algorithm, issuer: record.issuer, demo: true })) {
        throw new Error('Ledger signature mismatch');
      }
    }

    const checkpoint = this._loadCheckpoint();
    const lastRecord = ordered.at(-1) ?? this._genesisCheckpoint();
    if (checkpoint.seq !== lastRecord.seq || checkpoint.hash !== lastRecord.hash || checkpoint.previousHash !== lastRecord.previousHash) {
      throw new Error('Ledger checkpoint mismatch');
    }
    if (!this.verify(checkpoint.sealed)) {
      throw new Error('Ledger checkpoint signature mismatch');
    }
    this._ledger = ordered;
  }

  _genesisCheckpoint() {
    return {
      seq: 0,
      id: 'checkpoint-0',
      timestamp: new Date(0).toISOString(),
      kind: 'checkpoint',
      previousHash: 'GENESIS',
      hash: 'GENESIS',
      demoCredentials: true,
    };
  }

  _loadCheckpoint() {
    if (!fs.existsSync(this._checkpointPath)) {
      throw new Error('Missing ledger checkpoint');
    }

    const checkpoint = readJson(this._checkpointPath);
    if (!checkpoint || !checkpoint.sealed) {
      throw new Error('Corrupt ledger checkpoint');
    }

    if (!this.verify(checkpoint.sealed)) {
      throw new Error('Invalid ledger checkpoint signature');
    }

    const payload = checkpoint.sealed.payload;
    return {
      ...payload,
      sealed: checkpoint.sealed,
    };
  }

  _writeCheckpoint(record) {
    const checkpointRecord = this.seal({
      seq: record.seq,
      id: record.id,
      timestamp: record.timestamp,
      kind: 'checkpoint',
      previousHash: record.previousHash,
      hash: record.hash,
      demoCredentials: true,
    });
    atomicWriteJson(this._checkpointPath, { sealed: checkpointRecord });
  }

  _appendLedgerRecord(record) {
    let appended = false;
    try {
      const serialized = `${JSON.stringify(record)}\n`;
      const fd = fs.openSync(this._ledgerPath, 'a');
      try {
        fs.writeSync(fd, serialized, null, 'utf8');
        appended = true;
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      this._writeCheckpoint(record);
      this._verifyLedgerOrThrow();
      this._ledger = this._loadLedger();
    } catch (error) {
      this._poison(error);
      if (!appended && fs.existsSync(this._ledgerPath)) {
        try {
          this._ledger = this._loadLedger();
        } catch {
          // leave cache poisoned; disk state is authoritative
        }
      }
      throw error;
    }
  }

  _assertSafeName(name) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error('Invalid storage name');
    }
  }

  _hasPersistentState() {
    if (fs.existsSync(this._ledgerPath) || fs.existsSync(this._checkpointPath)) {
      return true;
    }

    for (const fileName of ['policies.json', 'policy-draft.json', 'settings.json', 'credentials.json', 'chats.json']) {
      if (fs.existsSync(path.join(this.root, fileName))) {
        return true;
      }
    }

    const secretsDir = path.join(this.root, 'secrets');
    return fs.existsSync(secretsDir) && fs.readdirSync(secretsDir).length > 0;
  }

  _assertHealthy() {
    if (this._poisonedError) {
      throw this._poisonedError;
    }
  }

  _poison(error) {
    if (!this._poisonedError) {
      this._poisonedError = error instanceof Error ? error : new Error(String(error));
    }
    return this._poisonedError;
  }
}
