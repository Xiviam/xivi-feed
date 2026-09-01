import { db } from "./db.js";

import type { ApiAuthor, ApiComment, ApiPost, ApiUser } from "./types.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS saved_posts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, post_id)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 40),
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
    is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_saved_posts_user_created
    ON saved_posts(user_id, created_at DESC, post_id DESC);
  CREATE INDEX IF NOT EXISTS idx_saved_posts_post_id
    ON saved_posts(post_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON notifications(user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications(user_id, is_read, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_actor
    ON notifications(actor_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
    ON notifications(
      user_id,
      actor_id,
      type,
      COALESCE(post_id, 0),
      COALESCE(comment_id, 0)
    );
`);

type SqlPrimitive = string | number | bigint | Uint8Array | null;
type Row = Record<string, SqlPrimitive>;

function unicodeFold(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

db.function("dump_unicode_fold", { deterministic: true }, (value) =>
  typeof value === "string" ? unicodeFold(value) : "",
);

export interface SocialPost extends ApiPost {
  savedByMe: boolean;
  savedAt?: string;
}

export interface ApiNotification {
  id: number;
  type: string;
  postId: number | null;
  commentId: number | null;
  isRead: boolean;
  createdAt: string;
  actor: ApiAuthor;
  post: {
    id: number;
    imageUrl: string;
    caption: string;
  } | null;
}

export interface SearchResults {
  users: ApiUser[];
  posts: SocialPost[];
}

function asNumber(value: SqlPrimitive | undefined): number {
  return Number(value ?? 0);
}

function asString(value: SqlPrimitive | undefined): string {
  return String(value ?? "");
}

function nullableNumber(value: SqlPrimitive | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function nullableString(value: SqlPrimitive | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function authorFromRow(row: Row, prefix = "author_"): ApiAuthor {
  return {
    id: asNumber(row[`${prefix}id`]),
    username: asString(row[`${prefix}username`]),
    displayName: asString(row[`${prefix}display_name`]),
    avatarUrl: nullableString(row[`${prefix}avatar_url`]) ?? "",
  };
}

function getLatestComments(postId: number, viewerId: number, limit = 3): ApiComment[] {
  const rows = db
    .prepare(`
      SELECT * FROM (
        SELECT
          c.id,
          c.body,
          c.created_at,
          c.user_id,
          u.id AS author_id,
          u.username AS author_username,
          u.display_name AS author_display_name,
          u.avatar_url AS author_avatar_url
        FROM comments c
        JOIN users u ON u.id = c.user_id
        WHERE c.post_id = ?
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ?
      ) recent
      ORDER BY created_at ASC, id ASC
    `)
    .all(postId, limit) as Row[];

  return rows.map((row) => ({
    id: asNumber(row.id),
    text: asString(row.body),
    createdAt: asString(row.created_at),
    author: authorFromRow(row),
    canDelete: asNumber(row.user_id) === viewerId,
  }));
}

const postSelect = `
  SELECT
    p.id,
    p.image_url,
    p.caption,
    p.created_at,
    p.user_id,
    u.id AS author_id,
    u.username AS author_username,
    u.display_name AS author_display_name,
    u.avatar_url AS author_avatar_url,
    (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes_count,
    (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments_count,
    CASE WHEN EXISTS (
      SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?
    ) THEN 1 ELSE 0 END AS liked_by_me,
    CASE WHEN EXISTS (
      SELECT 1 FROM saved_posts sp WHERE sp.post_id = p.id AND sp.user_id = ?
    ) THEN 1 ELSE 0 END AS saved_by_me,
    sp.saved_at
  FROM posts p
  JOIN users u ON u.id = p.user_id
`;

function postFromRow(row: Row, viewerId: number): SocialPost {
  const post: SocialPost = {
    id: asNumber(row.id),
    imageUrl: asString(row.image_url),
    caption: asString(row.caption),
    createdAt: asString(row.created_at),
    author: authorFromRow(row),
    likesCount: asNumber(row.likes_count),
    commentsCount: asNumber(row.comments_count),
    likedByMe: Boolean(asNumber(row.liked_by_me)),
    savedByMe: Boolean(asNumber(row.saved_by_me)),
    canDelete: asNumber(row.user_id) === viewerId,
    comments: getLatestComments(asNumber(row.id), viewerId),
  };
  const savedAt = nullableString(row.saved_at);
  if (savedAt !== null) post.savedAt = savedAt;
  return post;
}

function userFromRow(row: Row, viewerId: number): ApiUser {
  const user: ApiUser = {
    id: asNumber(row.id),
    username: asString(row.username),
    displayName: asString(row.display_name),
    bio: asString(row.bio),
    avatarUrl: nullableString(row.avatar_url) ?? "",
    createdAt: asString(row.created_at),
    postsCount: asNumber(row.posts_count),
    followersCount: asNumber(row.followers_count),
    followingCount: asNumber(row.following_count),
    isFollowing: Boolean(asNumber(row.followed_by_me)),
    isMe: asNumber(row.id) === viewerId,
    role: asString(row.role) === "admin" ? "admin" : "user",
    emailVerified: row.email_verified_at !== null,
  };
  return user;
}

function notificationFromRow(row: Row): ApiNotification {
  const postId = nullableNumber(row.post_id);
  const imageUrl = nullableString(row.post_image_url);
  return {
    id: asNumber(row.id),
    type: asString(row.type),
    postId,
    commentId: nullableNumber(row.comment_id),
    isRead: Boolean(asNumber(row.is_read)),
    createdAt: asString(row.created_at),
    actor: authorFromRow(row),
    post:
      postId === null
        ? null
        : {
            id: postId,
            imageUrl: imageUrl ?? "",
            caption: nullableString(row.post_caption) ?? "",
          },
  };
}

const notificationSelect = `
  SELECT
    n.id,
    n.type,
    n.post_id,
    n.comment_id,
    n.is_read,
    n.created_at,
    actor.id AS author_id,
    actor.username AS author_username,
    actor.display_name AS author_display_name,
    actor.avatar_url AS author_avatar_url,
    p.image_url AS post_image_url,
    p.caption AS post_caption
  FROM notifications n
  JOIN users actor ON actor.id = n.actor_id
  LEFT JOIN posts p ON p.id = n.post_id
`;

function normalizedPage(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function normalizedLimit(value: number, maximum = 50): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(1, Math.floor(value))) : 20;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function toggleSavedPost(
  userId: number,
  postId: number,
): { saved: boolean } | null {
  if (!db.prepare("SELECT 1 FROM posts WHERE id = ?").get(postId)) return null;

  const existing = db
    .prepare("SELECT 1 FROM saved_posts WHERE user_id = ? AND post_id = ?")
    .get(userId, postId);
  if (existing) {
    db.prepare("DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?").run(userId, postId);
  } else {
    db.prepare("INSERT INTO saved_posts (user_id, post_id) VALUES (?, ?)").run(userId, postId);
  }
  return { saved: !existing };
}

export function isPostSaved(userId: number, postId: number): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM saved_posts WHERE user_id = ? AND post_id = ?")
      .get(userId, postId),
  );
}

export function getSavedPosts(
  userId: number,
  page: number,
  limit: number,
): { posts: SocialPost[]; hasMore: boolean } {
  const safePage = normalizedPage(page);
  const safeLimit = normalizedLimit(limit);
  const rows = db
    .prepare(`
      ${postSelect.replace("sp.saved_at", "saved.created_at AS saved_at")}
      JOIN saved_posts saved ON saved.post_id = p.id AND saved.user_id = ?
      ORDER BY saved.created_at DESC, p.id DESC
      LIMIT ? OFFSET ?
    `)
    .all(userId, userId, userId, safeLimit + 1, (safePage - 1) * safeLimit) as Row[];
  return {
    posts: rows.slice(0, safeLimit).map((row) => postFromRow(row, userId)),
    hasMore: rows.length > safeLimit,
  };
}

export function searchContent(viewerId: number, q: string, limit: number): SearchResults {
  const query = q.trim().replace(/^@+/, "").trim().slice(0, 100);
  if (!query) return { users: [], posts: [] };

  const safeLimit = normalizedLimit(limit);
  const foldedQuery = unicodeFold(query);
  const contains = `%${escapeLike(foldedQuery)}%`;
  const prefix = `${escapeLike(foldedQuery)}%`;
  const userRows = db
    .prepare(`
      SELECT
        u.id,
        u.username,
        u.display_name,
        u.bio,
        u.avatar_url,
        u.role,
        u.email_verified_at,
        u.created_at,
        (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS posts_count,
        (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) AS followers_count,
        (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id) AS following_count,
        CASE WHEN EXISTS (
          SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = u.id
        ) THEN 1 ELSE 0 END AS followed_by_me
      FROM users u
      WHERE dump_unicode_fold(u.username) LIKE ? ESCAPE '\\'
         OR dump_unicode_fold(u.display_name) LIKE ? ESCAPE '\\'
         OR dump_unicode_fold(u.bio) LIKE ? ESCAPE '\\'
      ORDER BY
        CASE
          WHEN dump_unicode_fold(u.username) = ? THEN 0
          WHEN dump_unicode_fold(u.username) LIKE ? ESCAPE '\\' THEN 1
          ELSE 2
        END,
        followers_count DESC,
        u.id ASC
      LIMIT ?
    `)
    .all(viewerId, contains, contains, contains, foldedQuery, prefix, safeLimit) as Row[];

  const postRows = db
    .prepare(`
      ${postSelect.replace("sp.saved_at", "NULL AS saved_at")}
      WHERE dump_unicode_fold(p.caption) LIKE ? ESCAPE '\\'
         OR dump_unicode_fold(u.username) LIKE ? ESCAPE '\\'
         OR dump_unicode_fold(u.display_name) LIKE ? ESCAPE '\\'
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ?
    `)
    .all(viewerId, viewerId, contains, contains, contains, safeLimit) as Row[];

  return {
    users: userRows.map((row) => userFromRow(row, viewerId)),
    posts: postRows.map((row) => postFromRow(row, viewerId)),
  };
}

export function createNotification(
  toUserId: number,
  actorId: number,
  type: string,
  postId?: number,
  commentId?: number,
): ApiNotification | null {
  if (toUserId === actorId) return null;
  const normalizedType = type.trim().toLowerCase();
  if (!normalizedType || normalizedType.length > 40) {
    throw new Error("Notification type must contain between 1 and 40 characters");
  }
  const normalizedPostId = postId ?? null;
  const normalizedCommentId = commentId ?? null;
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO notifications (user_id, actor_id, type, post_id, comment_id)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(toUserId, actorId, normalizedType, normalizedPostId, normalizedCommentId);

  let notificationId: number;
  if (Number(result.changes) > 0) {
    notificationId = Number(result.lastInsertRowid);
  } else {
    const existing = db
      .prepare(`
        SELECT id
        FROM notifications
        WHERE user_id = ?
          AND actor_id = ?
          AND type = ?
          AND COALESCE(post_id, 0) = COALESCE(?, 0)
          AND COALESCE(comment_id, 0) = COALESCE(?, 0)
      `)
      .get(
        toUserId,
        actorId,
        normalizedType,
        normalizedPostId,
        normalizedCommentId,
      ) as Row | undefined;
    if (!existing) return null;
    notificationId = asNumber(existing.id);
  }

  const row = db
    .prepare(`${notificationSelect} WHERE n.id = ?`)
    .get(notificationId) as Row | undefined;
  return row ? notificationFromRow(row) : null;
}

export function getNotifications(userId: number, limit: number, offset = 0): ApiNotification[] {
  const safeLimit = normalizedLimit(limit, 100);
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const rows = db
    .prepare(`
      ${notificationSelect}
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ? OFFSET ?
    `)
    .all(userId, safeLimit, safeOffset) as Row[];
  return rows.map(notificationFromRow);
}

export function markNotificationsRead(userId: number, ids?: readonly number[]): number {
  if (ids === undefined) {
    const result = db
      .prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0")
      .run(userId);
    return Number(result.changes);
  }

  const notificationIds = [...new Set(ids)].filter(
    (id) => Number.isSafeInteger(id) && id > 0,
  );
  if (notificationIds.length === 0) return 0;

  let markedRead = 0;
  const chunkSize = 500;
  for (let offset = 0; offset < notificationIds.length; offset += chunkSize) {
    const chunk = notificationIds.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = db
      .prepare(`
        UPDATE notifications
        SET is_read = 1
        WHERE user_id = ? AND is_read = 0 AND id IN (${placeholders})
      `)
      .run(userId, ...chunk);
    markedRead += Number(result.changes);
  }
  return markedRead;
}

export function getUnreadCount(userId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0")
    .get(userId) as Row;
  return asNumber(row.count);
}

export function removeNotification(
  toUserId: number,
  actorId: number,
  type: string,
  postId?: number,
  commentId?: number,
): number {
  const result = db
    .prepare(`
      DELETE FROM notifications
      WHERE user_id = ?
        AND actor_id = ?
        AND type = ?
        AND COALESCE(post_id, 0) = COALESCE(?, 0)
        AND COALESCE(comment_id, 0) = COALESCE(?, 0)
    `)
    .run(
      toUserId,
      actorId,
      type.trim().toLowerCase(),
      postId ?? null,
      commentId ?? null,
    );
  return Number(result.changes);
}

export function removeLikeNotification(
  toUserId: number,
  actorId: number,
  postId: number,
): number {
  return removeNotification(toUserId, actorId, "like", postId);
}

export function removeFollowNotification(toUserId: number, actorId: number): number {
  return removeNotification(toUserId, actorId, "follow");
}
