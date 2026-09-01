import { db } from "./db.js";
import type { ApiAuthor } from "./types.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS post_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolution_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    resolved_at TEXT,
    UNIQUE(post_id, reporter_id)
  );

  CREATE TABLE IF NOT EXISTS moderation_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    moderator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_post_reports_status_created
    ON post_reports(status, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_post_reports_post
    ON post_reports(post_id, status);
  CREATE INDEX IF NOT EXISTS idx_moderation_actions_created
    ON moderation_actions(created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_users_banned
    ON users(is_banned, banned_until);
`);

type SqlValue = string | number | bigint | Uint8Array | null;
type Row = Record<string, SqlValue>;

export type ModerationRole = "user" | "admin";

export interface AccessState {
  role: ModerationRole;
  banned: boolean;
  reason: string;
  until: number | null;
}

export interface ModerationUser {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  email: string;
  role: ModerationRole;
  isBanned: boolean;
  bannedReason: string;
  bannedUntil: number | null;
  createdAt: string;
  postsCount: number;
  reportsCount: number;
}

export interface PostReport {
  id: number;
  category: string;
  details: string;
  status: "open" | "resolved" | "dismissed";
  createdAt: string;
  resolutionNote: string;
  reporter: ApiAuthor;
  post: {
    id: number;
    imageUrl: string;
    caption: string;
    author: ApiAuthor;
  };
}

function asNumber(value: SqlValue | undefined): number {
  return Number(value ?? 0);
}

function asString(value: SqlValue | undefined): string {
  return String(value ?? "");
}

function nullableNumber(value: SqlValue | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function author(row: Row, prefix: string): ApiAuthor {
  return {
    id: asNumber(row[`${prefix}_id`]),
    username: asString(row[`${prefix}_username`]),
    displayName: asString(row[`${prefix}_display_name`]),
    avatarUrl: asString(row[`${prefix}_avatar_url`]),
  };
}

function audit(
  moderatorId: number,
  action: string,
  reason: string,
  targetUserId?: number,
  postId?: number,
): void {
  db.prepare(`
    INSERT INTO moderation_actions (moderator_id, target_user_id, post_id, action, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(moderatorId, targetUserId ?? null, postId ?? null, action, reason);
}

export function syncConfiguredAdmin(userId: number, username: string): void {
  const configured = process.env.ADMIN_USERNAME?.trim().replace(/^@/, "").toLowerCase();
  if (configured && configured === username.toLowerCase()) {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId);
  }
}

export function getAccessState(userId: number): AccessState | null {
  const row = db.prepare(`
    SELECT role, is_banned, banned_reason, banned_until
    FROM users
    WHERE id = ?
  `).get(userId) as Row | undefined;
  if (!row) return null;

  const until = nullableNumber(row.banned_until);
  let banned = Boolean(asNumber(row.is_banned));
  if (banned && until !== null && until <= Date.now()) {
    db.prepare(`
      UPDATE users
      SET is_banned = 0, banned_reason = NULL, banned_until = NULL, banned_at = NULL, banned_by = NULL
      WHERE id = ?
    `).run(userId);
    banned = false;
  }
  return {
    role: asString(row.role) === "admin" ? "admin" : "user",
    banned,
    reason: banned ? asString(row.banned_reason) : "",
    until: banned ? until : null,
  };
}

export function createPostReport(
  reporterId: number,
  postId: number,
  category: string,
  details: string,
): { id: number; status: "open" } | null {
  const post = db.prepare("SELECT user_id FROM posts WHERE id = ?").get(postId) as Row | undefined;
  if (!post) return null;
  if (asNumber(post.user_id) === reporterId) {
    throw new Error("CANNOT_REPORT_OWN_POST");
  }
  const result = db.prepare(`
    INSERT INTO post_reports (post_id, reporter_id, category, details)
    VALUES (?, ?, ?, ?)
  `).run(postId, reporterId, category, details);
  return { id: Number(result.lastInsertRowid), status: "open" };
}

export function listReports(
  status: "open" | "resolved" | "dismissed" | "all",
  page: number,
  limit: number,
): { reports: PostReport[]; hasMore: boolean } {
  const where = status === "all" ? "" : "WHERE r.status = ?";
  const params = status === "all" ? [] : [status];
  const rows = db.prepare(`
    SELECT
      r.id, r.category, r.details, r.status, r.created_at, r.resolution_note,
      reporter.id AS reporter_id,
      reporter.username AS reporter_username,
      reporter.display_name AS reporter_display_name,
      COALESCE(reporter.avatar_url, '') AS reporter_avatar_url,
      p.id AS post_id, p.image_url, p.caption,
      post_author.id AS post_author_id,
      post_author.username AS post_author_username,
      post_author.display_name AS post_author_display_name,
      COALESCE(post_author.avatar_url, '') AS post_author_avatar_url
    FROM post_reports r
    JOIN users reporter ON reporter.id = r.reporter_id
    JOIN posts p ON p.id = r.post_id
    JOIN users post_author ON post_author.id = p.user_id
    ${where}
    ORDER BY CASE WHEN r.status = 'open' THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit + 1, (page - 1) * limit) as Row[];

  return {
    reports: rows.slice(0, limit).map((row) => ({
      id: asNumber(row.id),
      category: asString(row.category),
      details: asString(row.details),
      status: asString(row.status) as PostReport["status"],
      createdAt: asString(row.created_at),
      resolutionNote: asString(row.resolution_note),
      reporter: author(row, "reporter"),
      post: {
        id: asNumber(row.post_id),
        imageUrl: asString(row.image_url),
        caption: asString(row.caption),
        author: author(row, "post_author"),
      },
    })),
    hasMore: rows.length > limit,
  };
}

export function resolveReport(
  moderatorId: number,
  reportId: number,
  status: "resolved" | "dismissed",
  note: string,
): boolean {
  const report = db.prepare("SELECT post_id FROM post_reports WHERE id = ?").get(reportId) as Row | undefined;
  if (!report) return false;
  const result = db.prepare(`
    UPDATE post_reports
    SET status = ?, resolved_by = ?, resolution_note = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND status = 'open'
  `).run(status, moderatorId, note, reportId);
  if (Number(result.changes) > 0) audit(moderatorId, `report_${status}`, note, undefined, asNumber(report.post_id));
  return Number(result.changes) > 0;
}

export function listModerationUsers(query: string, page: number, limit: number): {
  users: ModerationUser[];
  hasMore: boolean;
} {
  const normalized = `%${query.trim().replace(/^@/, "")}%`;
  const rows = db.prepare(`
    SELECT
      u.id, u.username, u.display_name, COALESCE(u.avatar_url, '') AS avatar_url,
      u.email, u.role, u.is_banned, COALESCE(u.banned_reason, '') AS banned_reason,
      u.banned_until, u.created_at,
      (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS posts_count,
      (SELECT COUNT(*) FROM post_reports r JOIN posts p ON p.id = r.post_id WHERE p.user_id = u.id AND r.status = 'open') AS reports_count
    FROM users u
    WHERE u.username LIKE ? COLLATE NOCASE OR u.display_name LIKE ? COLLATE NOCASE OR u.email LIKE ? COLLATE NOCASE
    ORDER BY u.is_banned DESC, reports_count DESC, u.created_at DESC, u.id DESC
    LIMIT ? OFFSET ?
  `).all(normalized, normalized, normalized, limit + 1, (page - 1) * limit) as Row[];
  return {
    users: rows.slice(0, limit).map((row) => ({
      id: asNumber(row.id),
      username: asString(row.username),
      displayName: asString(row.display_name),
      avatarUrl: asString(row.avatar_url),
      email: asString(row.email),
      role: asString(row.role) === "admin" ? "admin" : "user",
      isBanned: Boolean(asNumber(row.is_banned)),
      bannedReason: asString(row.banned_reason),
      bannedUntil: nullableNumber(row.banned_until),
      createdAt: asString(row.created_at),
      postsCount: asNumber(row.posts_count),
      reportsCount: asNumber(row.reports_count),
    })),
    hasMore: rows.length > limit,
  };
}

export function banUser(
  moderatorId: number,
  targetUserId: number,
  reason: string,
  until: number | null,
): boolean {
  if (moderatorId === targetUserId) throw new Error("CANNOT_BAN_SELF");
  const target = db.prepare("SELECT role FROM users WHERE id = ?").get(targetUserId) as Row | undefined;
  if (!target) return false;
  if (asString(target.role) === "admin") throw new Error("CANNOT_BAN_ADMIN");
  db.prepare(`
    UPDATE users
    SET is_banned = 1, banned_reason = ?, banned_until = ?, banned_at = ?, banned_by = ?
    WHERE id = ?
  `).run(reason, until, Date.now(), moderatorId, targetUserId);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(targetUserId);
  audit(moderatorId, "ban_user", reason, targetUserId);
  return true;
}

export function unbanUser(moderatorId: number, targetUserId: number): boolean {
  const result = db.prepare(`
    UPDATE users
    SET is_banned = 0, banned_reason = NULL, banned_until = NULL, banned_at = NULL, banned_by = NULL
    WHERE id = ? AND is_banned = 1
  `).run(targetUserId);
  if (Number(result.changes) > 0) audit(moderatorId, "unban_user", "", targetUserId);
  return Number(result.changes) > 0;
}

export function deletePostAsModerator(
  moderatorId: number,
  postId: number,
  reason: string,
): { imageUrl: string; authorId: number } | null {
  const post = db.prepare("SELECT image_url, user_id FROM posts WHERE id = ?").get(postId) as Row | undefined;
  if (!post) return null;
  db.prepare("DELETE FROM posts WHERE id = ?").run(postId);
  audit(moderatorId, "delete_post", reason, asNumber(post.user_id), postId);
  return { imageUrl: asString(post.image_url), authorId: asNumber(post.user_id) };
}

export function moderationSummary(): { openReports: number; bannedUsers: number; totalUsers: number } {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM post_reports WHERE status = 'open') AS open_reports,
      (SELECT COUNT(*) FROM users WHERE is_banned = 1 AND (banned_until IS NULL OR banned_until > ?)) AS banned_users,
      (SELECT COUNT(*) FROM users) AS total_users
  `).get(Date.now()) as Row;
  return {
    openReports: asNumber(row.open_reports),
    bannedUsers: asNumber(row.banned_users),
    totalUsers: asNumber(row.total_users),
  };
}
