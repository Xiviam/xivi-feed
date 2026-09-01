import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { db } from "./db.js";
import type { ApiAuthor } from "./types.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direct_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id INTEGER,
    joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (conversation_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_conversation_members_user
    ON conversation_members(user_id, conversation_id);
  CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_conversations_updated
    ON conversations(updated_at DESC, id DESC);
`);

type SqlValue = string | number | bigint | Uint8Array | null;
type Row = Record<string, SqlValue>;

export interface ConversationSummary {
  id: number;
  otherUser: ApiAuthor;
  lastMessage: string;
  lastMessageAt: string;
  lastMessageMine: boolean;
  unreadCount: number;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  body: string;
  createdAt: string;
  mine: boolean;
  sender: ApiAuthor;
}

function asNumber(value: SqlValue | undefined): number {
  return Number(value ?? 0);
}

function asString(value: SqlValue | undefined): string {
  return String(value ?? "");
}

function loadChatKey(): Buffer {
  const configured = process.env.CHAT_ENCRYPTION_KEY?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CHAT_ENCRYPTION_KEY is required in production");
    }
    return createHash("sha256").update("XIVI development-only chat encryption key").digest();
  }
  let material: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(configured)) material = Buffer.from(configured, "hex");
  else if (configured.startsWith("base64:")) material = Buffer.from(configured.slice(7), "base64url");
  else material = Buffer.from(configured, "utf8");
  if (material.length < 24) throw new Error("CHAT_ENCRYPTION_KEY must contain at least 24 bytes");
  return createHash("sha256").update(material).digest();
}

const chatKey = loadChatKey();

function encryptBody(body: string, conversationId: number): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", chatKey, iv);
  cipher.setAAD(Buffer.from(`xivi-conversation:${conversationId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

function decryptBody(payload: string, conversationId: number): string {
  const [version, ivPart, ciphertextPart, tagPart, extra] = payload.split(".");
  if (version !== "v1" || !ivPart || !ciphertextPart || !tagPart || extra !== undefined) {
    throw new Error("Invalid encrypted message");
  }
  const decipher = createDecipheriv("aes-256-gcm", chatKey, Buffer.from(ivPart, "base64url"));
  decipher.setAAD(Buffer.from(`xivi-conversation:${conversationId}`, "utf8"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function directKey(firstUserId: number, secondUserId: number): string {
  return [firstUserId, secondUserId].sort((left, right) => left - right).join(":");
}

function authorFromRow(row: Row, prefix: string): ApiAuthor {
  return {
    id: asNumber(row[`${prefix}_id`]),
    username: asString(row[`${prefix}_username`]),
    displayName: asString(row[`${prefix}_display_name`]),
    avatarUrl: asString(row[`${prefix}_avatar_url`]),
  };
}

function assertMember(userId: number, conversationId: number): void {
  const member = db.prepare(`
    SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?
  `).get(conversationId, userId);
  if (!member) throw new Error("CONVERSATION_NOT_FOUND");
}

export function startDirectConversation(userId: number, username: string): ConversationSummary {
  const target = db.prepare(`
    SELECT id FROM users WHERE username = ? COLLATE NOCASE
  `).get(username.replace(/^@/, "")) as Row | undefined;
  if (!target) throw new Error("USER_NOT_FOUND");
  const targetId = asNumber(target.id);
  if (targetId === userId) throw new Error("CANNOT_MESSAGE_SELF");

  const key = directKey(userId, targetId);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO conversations (direct_key) VALUES (?)
      ON CONFLICT(direct_key) DO NOTHING
    `).run(key);
    const conversation = db.prepare("SELECT id FROM conversations WHERE direct_key = ?").get(key) as Row;
    const conversationId = asNumber(conversation.id);
    const insertMember = db.prepare(`
      INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)
      ON CONFLICT(conversation_id, user_id) DO NOTHING
    `);
    insertMember.run(conversationId, userId);
    insertMember.run(conversationId, targetId);
    db.exec("COMMIT");
    return getConversationSummary(userId, conversationId)!;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getConversationSummary(userId: number, conversationId: number): ConversationSummary | null {
  const row = db.prepare(`
    SELECT
      c.id,
      other.id AS other_id,
      other.username AS other_username,
      other.display_name AS other_display_name,
      COALESCE(other.avatar_url, '') AS other_avatar_url,
      last_message.id AS last_message_id,
      last_message.encrypted_body AS last_message_body,
      last_message.created_at AS last_message_at,
      last_message.sender_id AS last_message_sender_id,
      (
        SELECT COUNT(*)
        FROM messages unread
        WHERE unread.conversation_id = c.id
          AND unread.sender_id != ?
          AND unread.id > COALESCE(mine.last_read_message_id, 0)
      ) AS unread_count
    FROM conversations c
    JOIN conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = ?
    JOIN conversation_members theirs ON theirs.conversation_id = c.id AND theirs.user_id != ?
    JOIN users other ON other.id = theirs.user_id
    LEFT JOIN messages last_message ON last_message.id = (
      SELECT id FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1
    )
    WHERE c.id = ?
  `).get(userId, userId, userId, conversationId) as Row | undefined;
  if (!row) return null;
  const encrypted = row.last_message_body === null ? "" : asString(row.last_message_body);
  return {
    id: asNumber(row.id),
    otherUser: authorFromRow(row, "other"),
    lastMessage: encrypted ? decryptBody(encrypted, asNumber(row.id)) : "Начните диалог",
    lastMessageAt: asString(row.last_message_at),
    lastMessageMine: asNumber(row.last_message_sender_id) === userId,
    unreadCount: asNumber(row.unread_count),
  };
}

export function listConversations(userId: number): { conversations: ConversationSummary[]; unreadTotal: number } {
  const rows = db.prepare(`
    SELECT c.id
    FROM conversations c
    JOIN conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = ?
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT 100
  `).all(userId) as Row[];
  const conversations = rows
    .map((row) => getConversationSummary(userId, asNumber(row.id)))
    .filter((conversation): conversation is ConversationSummary => conversation !== null);
  return {
    conversations,
    unreadTotal: conversations.reduce((total, conversation) => total + conversation.unreadCount, 0),
  };
}

export function getMessages(
  userId: number,
  conversationId: number,
  beforeId: number | null,
  limit: number,
): { messages: ChatMessage[]; hasMore: boolean } {
  assertMember(userId, conversationId);
  const rows = db.prepare(`
    SELECT
      m.id, m.conversation_id, m.encrypted_body, m.created_at, m.sender_id,
      sender.id AS sender_id_value,
      sender.username AS sender_username,
      sender.display_name AS sender_display_name,
      COALESCE(sender.avatar_url, '') AS sender_avatar_url
    FROM messages m
    JOIN users sender ON sender.id = m.sender_id
    WHERE m.conversation_id = ? AND (? IS NULL OR m.id < ?)
    ORDER BY m.id DESC
    LIMIT ?
  `).all(conversationId, beforeId, beforeId, limit + 1) as Row[];
  return {
    messages: rows.slice(0, limit).reverse().map((row) => ({
      id: asNumber(row.id),
      conversationId: asNumber(row.conversation_id),
      body: decryptBody(asString(row.encrypted_body), conversationId),
      createdAt: asString(row.created_at),
      mine: asNumber(row.sender_id) === userId,
      sender: {
        id: asNumber(row.sender_id_value),
        username: asString(row.sender_username),
        displayName: asString(row.sender_display_name),
        avatarUrl: asString(row.sender_avatar_url),
      },
    })),
    hasMore: rows.length > limit,
  };
}

export function sendMessage(userId: number, conversationId: number, body: string): ChatMessage {
  assertMember(userId, conversationId);
  const encrypted = encryptBody(body, conversationId);
  const result = db.prepare(`
    INSERT INTO messages (conversation_id, sender_id, encrypted_body)
    VALUES (?, ?, ?)
  `).run(conversationId, userId, encrypted);
  db.prepare(`
    UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
  `).run(conversationId);
  const row = db.prepare(`
    SELECT m.id AS message_id, m.created_at, u.id AS sender_id_value, u.username, u.display_name, COALESCE(u.avatar_url, '') AS avatar_url
    FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?
  `).get(Number(result.lastInsertRowid)) as Row;
  return {
    id: asNumber(row.message_id),
    conversationId,
    body,
    createdAt: asString(row.created_at),
    mine: true,
    sender: {
      id: asNumber(row.sender_id_value),
      username: asString(row.username),
      displayName: asString(row.display_name),
      avatarUrl: asString(row.avatar_url),
    },
  };
}

export function markConversationRead(userId: number, conversationId: number): number {
  assertMember(userId, conversationId);
  const latest = db.prepare(`
    SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?
  `).get(conversationId) as Row;
  const latestId = asNumber(latest.id);
  db.prepare(`
    UPDATE conversation_members SET last_read_message_id = ?
    WHERE conversation_id = ? AND user_id = ?
  `).run(latestId || null, conversationId, userId);
  return latestId;
}

export function conversationRecipient(userId: number, conversationId: number): number | null {
  const row = db.prepare(`
    SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ? LIMIT 1
  `).get(conversationId, userId) as Row | undefined;
  return row ? asNumber(row.user_id) : null;
}
