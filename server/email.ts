import { createHash, randomBytes } from "node:crypto";

import { db } from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS account_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_account_tokens_user_type
    ON account_tokens(user_id, type, expires_at);
  CREATE INDEX IF NOT EXISTS idx_account_tokens_expires
    ON account_tokens(expires_at);
`);

type SqlValue = string | number | bigint | Uint8Array | null;
type Row = Record<string, SqlValue>;

const verificationTtlMs = 24 * 60 * 60 * 1_000;
const resetTtlMs = 30 * 60 * 1_000;

function asNumber(value: SqlValue | undefined): number {
  return Number(value ?? 0);
}

function asString(value: SqlValue | undefined): string {
  return String(value ?? "");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(`xivi-account-token:${token}`).digest("hex");
}

function publicOrigin(): string {
  return (process.env.PUBLIC_ORIGIN?.trim() || "http://localhost:3000").replace(/\/$/, "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]!);
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM?.trim() || "XIVI <no-reply@xivici.space>",
      to: [to],
      subject,
      html,
    }),
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    console.error("Resend delivery failed", response.status, message.slice(0, 300));
    return false;
  }
  return true;
}

function createToken(userId: number, type: "verify_email" | "reset_password", ttlMs: number): string {
  const now = Date.now();
  const token = randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM account_tokens WHERE user_id = ? AND type = ?").run(userId, type);
  db.prepare(`
    INSERT INTO account_tokens (user_id, type, token_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, type, tokenHash(token), now, now + ttlMs);
  return token;
}

export function emailIsConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export async function sendVerificationEmail(userId: number): Promise<boolean> {
  const user = db.prepare(`
    SELECT email, display_name, email_verified_at FROM users WHERE id = ?
  `).get(userId) as Row | undefined;
  if (!user || user.email_verified_at !== null) return true;
  const token = createToken(userId, "verify_email", verificationTtlMs);
  const link = `${publicOrigin()}/verify-email?token=${encodeURIComponent(token)}`;
  const name = escapeHtml(asString(user.display_name));
  return sendEmail(
    asString(user.email),
    "Подтверди почту в XIVI",
    `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#171717"><h1>XIVI</h1><p>Привет, ${name}.</p><p>Подтверди почту, чтобы защитить аккаунт и восстановить доступ при необходимости.</p><p><a href="${link}" style="display:inline-block;padding:12px 18px;background:#171717;color:#fff;border-radius:10px;text-decoration:none">Подтвердить почту</a></p><p style="color:#777;font-size:12px">Ссылка действует 24 часа.</p></div>`,
  );
}

export function verifyEmailToken(token: string): number | null {
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`
      SELECT id, user_id FROM account_tokens
      WHERE token_hash = ? AND type = 'verify_email' AND used_at IS NULL AND expires_at > ?
    `).get(tokenHash(token), now) as Row | undefined;
    if (!row) {
      db.exec("ROLLBACK");
      return null;
    }
    const userId = asNumber(row.user_id);
    db.prepare("UPDATE account_tokens SET used_at = ? WHERE id = ?").run(now, asNumber(row.id));
    db.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?").run(now, userId);
    db.exec("COMMIT");
    return userId;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function sendPasswordResetEmail(email: string): Promise<boolean> {
  const user = db.prepare(`
    SELECT id, email, display_name FROM users WHERE email = ? COLLATE NOCASE
  `).get(email) as Row | undefined;
  if (!user) return true;
  const token = createToken(asNumber(user.id), "reset_password", resetTtlMs);
  const link = `${publicOrigin()}/reset-password?token=${encodeURIComponent(token)}`;
  const name = escapeHtml(asString(user.display_name));
  await sendEmail(
    asString(user.email),
    "Сброс пароля XIVI",
    `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#171717"><h1>XIVI</h1><p>Привет, ${name}.</p><p>Кто-то запросил новый пароль. Если это ты — продолжай по кнопке.</p><p><a href="${link}" style="display:inline-block;padding:12px 18px;background:#171717;color:#fff;border-radius:10px;text-decoration:none">Сменить пароль</a></p><p style="color:#777;font-size:12px">Ссылка действует 30 минут. Если запрос не твой, просто проигнорируй письмо.</p></div>`,
  );
  return true;
}

export function consumePasswordResetToken(token: string, passwordHash: string): number | null {
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`
      SELECT id, user_id FROM account_tokens
      WHERE token_hash = ? AND type = 'reset_password' AND used_at IS NULL AND expires_at > ?
    `).get(tokenHash(token), now) as Row | undefined;
    if (!row) {
      db.exec("ROLLBACK");
      return null;
    }
    const userId = asNumber(row.user_id);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
    db.prepare("UPDATE account_tokens SET used_at = ? WHERE id = ?").run(now, asNumber(row.id));
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM two_factor_login_challenges WHERE user_id = ?").run(userId);
    db.exec("COMMIT");
    return userId;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
