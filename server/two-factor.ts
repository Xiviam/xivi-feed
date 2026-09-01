import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { db } from "./db.js";

const ISSUER = "XIVI";
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_WINDOW = 1;
const SECRET_BYTES = 20;
const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const SETUP_TTL_MS = 5 * 60 * 1_000;
const MAX_ATTEMPTS = 5;
const USER_FAILURE_WINDOW_MS = 15 * 60 * 1_000;
const USER_MAX_FAILURES = 10;
const USER_LOCKOUT_MS = 15 * 60 * 1_000;
const RECOVERY_CODE_COUNT = 10;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEVELOPMENT_KEY_MATERIAL = "XIVI development-only two-factor encryption key";

export type TwoFactorStatus = Readonly<{
  enabled: boolean;
  setupPending: boolean;
  recoveryCodesRemaining: number;
}>;

export type TwoFactorSetup = Readonly<{
  secret: string;
  otpauthUri: string;
  expiresAt: number;
}>;

export type LoginChallenge = Readonly<{
  token: string;
  expiresAt: number;
}>;

export type LoginChallengeVerification = Readonly<{
  userId: number;
}>;

export type TwoFactorErrorCode =
  | "ALREADY_ENABLED"
  | "NOT_ENABLED"
  | "CODE_REQUIRED"
  | "INVALID_CODE"
  | "SETUP_NOT_FOUND"
  | "SETUP_EXPIRED"
  | "CHALLENGE_INVALID"
  | "CHALLENGE_EXPIRED"
  | "TOO_MANY_ATTEMPTS"
  | "USER_NOT_FOUND";

export class TwoFactorError extends Error {
  readonly code: TwoFactorErrorCode;

  constructor(code: TwoFactorErrorCode, message: string) {
    super(message);
    this.name = "TwoFactorError";
    this.code = code;
  }
}

type SqlValue = string | number | bigint | Uint8Array | null;
type SqlRow = Record<string, SqlValue>;

db.exec(`
  CREATE TABLE IF NOT EXISTS two_factor_credentials (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    encrypted_secret TEXT NOT NULL,
    enabled_at INTEGER NOT NULL,
    last_used_counter INTEGER
  );

  CREATE TABLE IF NOT EXISTS two_factor_pending (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    encrypted_secret TEXT NOT NULL,
    account_label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts_remaining INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS two_factor_login_challenges (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts_remaining INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS two_factor_recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS two_factor_attempt_limits (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    window_started_at INTEGER NOT NULL,
    failed_attempts INTEGER NOT NULL,
    locked_until INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_two_factor_pending_expires
    ON two_factor_pending(expires_at);
  CREATE INDEX IF NOT EXISTS idx_two_factor_challenges_user
    ON two_factor_login_challenges(user_id, expires_at);
  CREATE INDEX IF NOT EXISTS idx_two_factor_challenges_expires
    ON two_factor_login_challenges(expires_at);
  CREATE INDEX IF NOT EXISTS idx_two_factor_recovery_user
    ON two_factor_recovery_codes(user_id, used_at);
  CREATE INDEX IF NOT EXISTS idx_two_factor_attempt_limits_locked
    ON two_factor_attempt_limits(locked_until);
`);

// SQLite's CREATE TABLE IF NOT EXISTS does not add columns to an existing table.
// Keep this migration local and idempotent so old installations upgrade on startup.
const credentialColumns = db.prepare("PRAGMA table_info(two_factor_credentials)").all() as SqlRow[];
if (!credentialColumns.some((column) => String(column.name) === "last_used_counter")) {
  try {
    db.exec("ALTER TABLE two_factor_credentials ADD COLUMN last_used_counter INTEGER");
  } catch (error) {
    // A second process may have completed the same idempotent migration first.
    const message = error instanceof Error ? error.message : "";
    if (!message.toLowerCase().includes("duplicate column name")) throw error;
  }
}

const encryptionKey = loadEncryptionKey();

function loadEncryptionKey(): Buffer {
  const configured = process.env.TWO_FACTOR_ENCRYPTION_KEY?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("TWO_FACTOR_ENCRYPTION_KEY is required in production");
    }
    return sha256Buffer(Buffer.from(DEVELOPMENT_KEY_MATERIAL, "utf8"));
  }

  let material: Buffer;
  if (configured.startsWith("hex:")) {
    material = decodeHex(configured.slice(4));
  } else if (configured.startsWith("base64:")) {
    material = decodeBase64(configured.slice(7));
  } else if (configured.startsWith("string:")) {
    material = Buffer.from(configured.slice(7), "utf8");
  } else if (/^[0-9a-fA-F]{64}$/.test(configured)) {
    material = Buffer.from(configured, "hex");
  } else if (looksLikeStrongBase64(configured)) {
    material = Buffer.from(configured, "base64url");
  } else {
    material = Buffer.from(configured, "utf8");
  }

  if (material.length === 0) {
    throw new Error("TWO_FACTOR_ENCRYPTION_KEY must not be empty");
  }
  return sha256Buffer(material);
}

function decodeHex(value: string): Buffer {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error("TWO_FACTOR_ENCRYPTION_KEY has invalid hex encoding");
  }
  return Buffer.from(value, "hex");
}

function decodeBase64(value: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(normalized)) {
    throw new Error("TWO_FACTOR_ENCRYPTION_KEY has invalid base64 encoding");
  }
  const result = Buffer.from(normalized, "base64url");
  if (result.length === 0) {
    throw new Error("TWO_FACTOR_ENCRYPTION_KEY has invalid base64 encoding");
  }
  return result;
}

function looksLikeStrongBase64(value: string): boolean {
  if (value.length < 43 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").length >= 32;
  } catch {
    return false;
  }
}

function sha256Buffer(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${tag.toString("base64url")}`;
}

function decryptSecret(payload: string): string {
  const [version, ivPart, ciphertextPart, tagPart, extra] = payload.split(".");
  if (version !== "v1" || !ivPart || !ciphertextPart || !tagPart || extra !== undefined) {
    throw new Error("Invalid encrypted two-factor secret");
  }

  const iv = Buffer.from(ivPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Invalid encrypted two-factor secret");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function base32Encode(input: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }

  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  const normalized = input.toUpperCase().replace(/=+$/g, "").replace(/[\s-]/g, "");
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new Error("Invalid base32 two-factor secret");
  }

  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(output);
}

function totpForCounter(secret: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) >>> 0;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function matchingTotpCounter(secretBase32: string, code: string, now = Date.now()): number | null {
  const normalized = code.trim();
  if (!/^\d{6}$/.test(normalized)) return null;

  const secret = base32Decode(secretBase32);
  const counter = Math.floor(now / 1_000 / TOTP_PERIOD_SECONDS);
  const supplied = Buffer.from(normalized, "ascii");
  let matchedCounter: number | null = null;

  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const candidateCounter = counter + offset;
    const candidate = Buffer.from(totpForCounter(secret, candidateCounter), "ascii");
    if (timingSafeEqual(candidate, supplied)) matchedCounter = candidateCounter;
  }
  return matchedCounter;
}

function challengeHash(token: string): string {
  return sha256Hex(`challenge:${token}`);
}

function normalizeRecoveryCode(code: string): string | null {
  const normalized = code.toUpperCase().replace(/[^A-Z2-7]/g, "");
  return /^[A-Z2-7]{16}$/.test(normalized) ? normalized : null;
}

function recoveryHash(code: string): string {
  return sha256Hex(`recovery:${code}`);
}

function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) {
    const raw = base32Encode(randomBytes(10)).slice(0, 16);
    codes.add(raw.match(/.{1,4}/g)!.join("-"));
  }
  return [...codes];
}

function asNumber(value: SqlValue | undefined): number {
  return Number(value ?? 0);
}

function asString(value: SqlValue | undefined): string {
  return String(value ?? "");
}

function inTransaction<T>(operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function attemptLimitRow(userId: number): SqlRow | undefined {
  return db.prepare(`
    SELECT window_started_at, failed_attempts, locked_until
    FROM two_factor_attempt_limits
    WHERE user_id = ?
  `).get(userId) as SqlRow | undefined;
}

function isUserLocked(userId: number, now: number): boolean {
  const row = attemptLimitRow(userId);
  return Boolean(row && asNumber(row.locked_until) > now);
}

function lockedOutError(): TwoFactorError {
  return new TwoFactorError(
    "TOO_MANY_ATTEMPTS",
    "Too many authentication failures; try again later",
  );
}

function assertUserNotLocked(userId: number, now = Date.now()): void {
  if (isUserLocked(userId, now)) throw lockedOutError();
}

// Must be called while a write transaction is held. Returns true when this
// failure starts (or observes) the persistent per-user lockout.
function recordUserFailureInTransaction(userId: number, now: number): boolean {
  const row = attemptLimitRow(userId);
  if (row && asNumber(row.locked_until) > now) return true;

  const previousWindowStartedAt = row ? asNumber(row.window_started_at) : 0;
  const windowExpired = !row || previousWindowStartedAt + USER_FAILURE_WINDOW_MS <= now;
  const previousLockExpired = Boolean(row && asNumber(row.locked_until) > 0);
  const windowStartedAt = windowExpired || previousLockExpired ? now : previousWindowStartedAt;
  const failedAttempts = windowExpired || previousLockExpired
    ? 1
    : asNumber(row?.failed_attempts) + 1;
  const lockedUntil = failedAttempts >= USER_MAX_FAILURES ? now + USER_LOCKOUT_MS : 0;

  db.prepare(`
    INSERT INTO two_factor_attempt_limits (
      user_id, window_started_at, failed_attempts, locked_until
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      window_started_at = excluded.window_started_at,
      failed_attempts = excluded.failed_attempts,
      locked_until = excluded.locked_until
  `).run(userId, windowStartedAt, failedAttempts, lockedUntil);
  return lockedUntil > now;
}

function recordUserFailure(userId: number, now: number): boolean {
  return inTransaction(() => recordUserFailureInTransaction(userId, now));
}

function clearUserFailuresInTransaction(userId: number): void {
  db.prepare("DELETE FROM two_factor_attempt_limits WHERE user_id = ?").run(userId);
}

function assertUserExists(userId: number): void {
  const row = db.prepare("SELECT 1 AS present FROM users WHERE id = ?").get(userId) as
    | SqlRow
    | undefined;
  if (!row) throw new TwoFactorError("USER_NOT_FOUND", "User does not exist");
}

function insertRecoveryCodes(userId: number, codes: readonly string[], now: number): void {
  const insert = db.prepare(`
    INSERT INTO two_factor_recovery_codes (user_id, code_hash, created_at)
    VALUES (?, ?, ?)
  `);
  for (const code of codes) {
    const normalized = normalizeRecoveryCode(code);
    if (!normalized) throw new Error("Generated an invalid recovery code");
    insert.run(userId, recoveryHash(normalized), now);
  }
}

function recordPendingFailure(userId: number, attemptsRemaining: number): never {
  if (attemptsRemaining <= 1) {
    db.prepare("DELETE FROM two_factor_pending WHERE user_id = ?").run(userId);
    throw new TwoFactorError("TOO_MANY_ATTEMPTS", "Two-factor setup attempt limit reached");
  }
  db.prepare(`
    UPDATE two_factor_pending
    SET attempts_remaining = attempts_remaining - 1
    WHERE user_id = ?
  `).run(userId);
  throw new TwoFactorError("INVALID_CODE", "Invalid authentication code");
}

function recordChallengeFailure(tokenHash: string, attemptsRemaining: number): never {
  if (attemptsRemaining <= 1) {
    db.prepare("DELETE FROM two_factor_login_challenges WHERE token_hash = ?").run(tokenHash);
    throw new TwoFactorError("TOO_MANY_ATTEMPTS", "Login challenge attempt limit reached");
  }
  db.prepare(`
    UPDATE two_factor_login_challenges
    SET attempts_remaining = attempts_remaining - 1
    WHERE token_hash = ?
  `).run(tokenHash);
  throw new TwoFactorError("INVALID_CODE", "Invalid authentication code");
}

export function getTwoFactorStatus(userId: number): TwoFactorStatus {
  const now = Date.now();
  const credential = db.prepare(`
    SELECT 1 AS present FROM two_factor_credentials WHERE user_id = ?
  `).get(userId) as SqlRow | undefined;
  const pending = db.prepare(`
    SELECT 1 AS present
    FROM two_factor_pending
    WHERE user_id = ? AND expires_at > ? AND attempts_remaining > 0
  `).get(userId, now) as SqlRow | undefined;
  const recovery = db.prepare(`
    SELECT COUNT(*) AS count
    FROM two_factor_recovery_codes
    WHERE user_id = ? AND used_at IS NULL
  `).get(userId) as SqlRow;

  return {
    enabled: Boolean(credential),
    setupPending: Boolean(pending),
    recoveryCodesRemaining: asNumber(recovery.count),
  };
}

export function beginSetup(userId: number, accountLabel: string): TwoFactorSetup {
  assertUserExists(userId);
  assertUserNotLocked(userId);
  if (getTwoFactorStatus(userId).enabled) {
    throw new TwoFactorError("ALREADY_ENABLED", "Two-factor authentication is already enabled");
  }

  const label = accountLabel.trim();
  if (!label || label.length > 254) throw new TypeError("accountLabel must be 1-254 characters");

  const now = Date.now();
  const expiresAt = now + SETUP_TTL_MS;
  const secret = base32Encode(randomBytes(SECRET_BYTES));
  db.prepare(`
    INSERT INTO two_factor_pending (
      user_id, encrypted_secret, account_label, created_at, expires_at, attempts_remaining
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      encrypted_secret = excluded.encrypted_secret,
      account_label = excluded.account_label,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      attempts_remaining = excluded.attempts_remaining
  `).run(userId, encryptSecret(secret), label, now, expiresAt, MAX_ATTEMPTS);

  const encodedIssuer = encodeURIComponent(ISSUER);
  const otpauthUri =
    `otpauth://totp/${encodedIssuer}:${encodeURIComponent(label)}` +
    `?secret=${encodeURIComponent(secret)}` +
    `&issuer=${encodedIssuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
  return { secret, otpauthUri, expiresAt };
}

export function enableTwoFactor(userId: number, code: string): string[] {
  const pending = db.prepare(`
    SELECT encrypted_secret, expires_at, attempts_remaining
    FROM two_factor_pending
    WHERE user_id = ?
  `).get(userId) as SqlRow | undefined;
  if (!pending) throw new TwoFactorError("SETUP_NOT_FOUND", "No two-factor setup is pending");

  const now = Date.now();
  assertUserNotLocked(userId, now);
  if (asNumber(pending.expires_at) <= now) {
    db.prepare("DELETE FROM two_factor_pending WHERE user_id = ?").run(userId);
    throw new TwoFactorError("SETUP_EXPIRED", "Two-factor setup has expired");
  }

  const encryptedSecret = asString(pending.encrypted_secret);
  const secret = decryptSecret(encryptedSecret);
  const matchedCounter = matchingTotpCounter(secret, code, now);
  if (matchedCounter === null) {
    if (recordUserFailure(userId, now)) throw lockedOutError();
    return recordPendingFailure(userId, asNumber(pending.attempts_remaining));
  }

  const recoveryCodes = generateRecoveryCodes();
  inTransaction(() => {
    db.prepare(`
      INSERT INTO two_factor_credentials (
        user_id, encrypted_secret, enabled_at, last_used_counter
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        encrypted_secret = excluded.encrypted_secret,
        enabled_at = excluded.enabled_at,
        last_used_counter = excluded.last_used_counter
    `).run(userId, encryptedSecret, now, matchedCounter);
    db.prepare("DELETE FROM two_factor_recovery_codes WHERE user_id = ?").run(userId);
    insertRecoveryCodes(userId, recoveryCodes, now);
    db.prepare("DELETE FROM two_factor_pending WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM two_factor_login_challenges WHERE user_id = ?").run(userId);
    clearUserFailuresInTransaction(userId);
  });
  return recoveryCodes;
}

export function disableTwoFactor(userId: number, code?: string): void {
  const status = getTwoFactorStatus(userId);
  if (!status.enabled) {
    db.prepare("DELETE FROM two_factor_pending WHERE user_id = ?").run(userId);
    return;
  }
  if (!code) throw new TwoFactorError("CODE_REQUIRED", "An authentication code is required");
  if (!verifyUserCode(userId, code)) {
    throw new TwoFactorError("INVALID_CODE", "Invalid authentication code");
  }

  inTransaction(() => {
    db.prepare("DELETE FROM two_factor_login_challenges WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM two_factor_recovery_codes WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM two_factor_pending WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM two_factor_credentials WHERE user_id = ?").run(userId);
  });
}

export function createLoginChallenge(userId: number): LoginChallenge {
  const credential = db.prepare(`
    SELECT 1 AS present FROM two_factor_credentials WHERE user_id = ?
  `).get(userId) as SqlRow | undefined;
  if (!credential) {
    throw new TwoFactorError("NOT_ENABLED", "Two-factor authentication is not enabled");
  }

  const now = Date.now();
  assertUserNotLocked(userId, now);
  const expiresAt = now + CHALLENGE_TTL_MS;
  const token = randomBytes(32).toString("base64url");
  inTransaction(() => {
    db.prepare("DELETE FROM two_factor_login_challenges WHERE expires_at <= ?").run(now);
    // Only the newest password-authenticated challenge for an account remains valid.
    db.prepare("DELETE FROM two_factor_login_challenges WHERE user_id = ?").run(userId);
    db.prepare(`
      INSERT INTO two_factor_login_challenges (
        token_hash, user_id, created_at, expires_at, attempts_remaining
      ) VALUES (?, ?, ?, ?, ?)
    `).run(challengeHash(token), userId, now, expiresAt, MAX_ATTEMPTS);
  });
  return { token, expiresAt };
}

export function verifyLoginChallenge(token: string, code: string): LoginChallengeVerification {
  const normalizedToken = token.trim();
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(normalizedToken)) {
    throw new TwoFactorError("CHALLENGE_INVALID", "Invalid login challenge");
  }

  const tokenHash = challengeHash(normalizedToken);
  const challenge = db.prepare(`
    SELECT user_id, expires_at, attempts_remaining
    FROM two_factor_login_challenges
    WHERE token_hash = ?
  `).get(tokenHash) as SqlRow | undefined;
  if (!challenge) throw new TwoFactorError("CHALLENGE_INVALID", "Invalid login challenge");

  const now = Date.now();
  if (asNumber(challenge.expires_at) <= now) {
    db.prepare("DELETE FROM two_factor_login_challenges WHERE token_hash = ?").run(tokenHash);
    throw new TwoFactorError("CHALLENGE_EXPIRED", "Login challenge has expired");
  }

  const userId = asNumber(challenge.user_id);
  if (!verifyUserCode(userId, code)) {
    return recordChallengeFailure(tokenHash, asNumber(challenge.attempts_remaining));
  }

  const consumed = db.prepare(`
    DELETE FROM two_factor_login_challenges
    WHERE token_hash = ? AND expires_at > ?
  `).run(tokenHash, now);
  if (Number(consumed.changes) !== 1) {
    throw new TwoFactorError("CHALLENGE_INVALID", "Invalid login challenge");
  }
  return { userId };
}

export function regenerateRecoveryCodes(userId: number, code: string): string[] {
  if (!getTwoFactorStatus(userId).enabled) {
    throw new TwoFactorError("NOT_ENABLED", "Two-factor authentication is not enabled");
  }
  if (!verifyUserCode(userId, code)) {
    throw new TwoFactorError("INVALID_CODE", "Invalid authentication code");
  }

  const now = Date.now();
  const recoveryCodes = generateRecoveryCodes();
  inTransaction(() => {
    db.prepare("DELETE FROM two_factor_recovery_codes WHERE user_id = ?").run(userId);
    insertRecoveryCodes(userId, recoveryCodes, now);
  });
  return recoveryCodes;
}

export function verifyUserCode(userId: number, code: string): boolean {
  const now = Date.now();
  assertUserNotLocked(userId, now);

  const outcome = inTransaction<"valid" | "invalid" | "locked">(() => {
    // BEGIN IMMEDIATE serializes the counter read/update across Node processes.
    if (isUserLocked(userId, now)) return "locked";

    const credential = db.prepare(`
      SELECT encrypted_secret, last_used_counter
      FROM two_factor_credentials
      WHERE user_id = ?
    `).get(userId) as SqlRow | undefined;
    if (!credential) return "invalid";

    const secret = decryptSecret(asString(credential.encrypted_secret));
    const matchedCounter = matchingTotpCounter(secret, code, now);
    if (matchedCounter !== null) {
      const accepted = db.prepare(`
        UPDATE two_factor_credentials
        SET last_used_counter = ?
        WHERE user_id = ?
          AND (last_used_counter IS NULL OR last_used_counter < ?)
      `).run(matchedCounter, userId, matchedCounter);
      if (Number(accepted.changes) === 1) {
        clearUserFailuresInTransaction(userId);
        return "valid";
      }
    }

    const normalizedRecovery = normalizeRecoveryCode(code);
    if (normalizedRecovery) {
      const consumed = db.prepare(`
        UPDATE two_factor_recovery_codes
        SET used_at = ?
        WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
      `).run(now, userId, recoveryHash(normalizedRecovery));
      if (Number(consumed.changes) === 1) {
        clearUserFailuresInTransaction(userId);
        return "valid";
      }
    }

    return recordUserFailureInTransaction(userId, now) ? "locked" : "invalid";
  });

  if (outcome === "locked") throw lockedOutError();
  return outcome === "valid";
}
