import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashSync } from "bcryptjs";

import type { ApiAuthor, ApiComment, ApiPost, ApiUser } from "./types.js";

const dataDirectory = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
export const uploadsDirectory = path.join(dataDirectory, "uploads");
mkdirSync(uploadsDirectory, { recursive: true });

const databasePath = path.resolve(
  process.env.DATABASE_PATH ?? path.join(dataDirectory, "xivi.sqlite"),
);

export const db = new DatabaseSync(databasePath);

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    is_banned INTEGER NOT NULL DEFAULT 0,
    banned_reason TEXT,
    banned_until INTEGER,
    banned_at INTEGER,
    banned_by INTEGER,
    email_verified_at INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 300),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, post_id)
  );

  CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (follower_id, following_id),
    CHECK (follower_id <> following_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_likes_post_id ON likes(post_id);
  CREATE INDEX IF NOT EXISTS idx_follows_following_id ON follows(following_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`);

const existingUserColumns = new Set(
  (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((column) => column.name),
);
const userColumnMigrations = [
  ["role", "TEXT NOT NULL DEFAULT 'user'"],
  ["is_banned", "INTEGER NOT NULL DEFAULT 0"],
  ["banned_reason", "TEXT"],
  ["banned_until", "INTEGER"],
  ["banned_at", "INTEGER"],
  ["banned_by", "INTEGER"],
  ["email_verified_at", "INTEGER"],
] as const;
for (const [column, definition] of userColumnMigrations) {
  if (!existingUserColumns.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
}

type SqlPrimitive = string | number | bigint | Uint8Array | null;
type Row = Record<string, SqlPrimitive>;

function asNumber(value: SqlPrimitive | undefined): number {
  return Number(value ?? 0);
}

function asString(value: SqlPrimitive | undefined): string {
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

const seedUsers = [
  ["kotleta.jpg", "kotleta@xivi.local", "Лера Котлета", "Сначала фотографирую еду, потом ем холодной.", "https://i.pravatar.cc/240?img=47"],
  ["metro_mood", "metro@xivi.local", "Маша Пересадка", "Красота между двумя пересадками.", "https://i.pravatar.cc/240?img=32"],
  ["dachny_dragon", "dragon@xivi.local", "Дачный Дракон", "Огурцы, мангал и немного магии.", "https://i.pravatar.cc/240?img=12"],
  ["babushka_online", "babulya@xivi.local", "Галина Онлайн", "Админ семейного чата. Баню за мат.", "https://i.pravatar.cc/240?img=44"],
  ["office_plankton", "office@xivi.local", "Антон Дедлайн", "Работаю над видом, что работаю.", "https://i.pravatar.cc/240?img=11"],
  ["pixel_galya", "pixel@xivi.local", "Галя Пиксель", "Делаю кнопки крупнее с 2018 года.", "https://i.pravatar.cc/240?img=25"],
  ["zavtrak_v_17", "breakfast@xivi.local", "Соня Завтракова", "Завтраки в любое время. Режим — никогда.", "https://i.pravatar.cc/240?img=49"],
  ["sergey_golub", "golub@xivi.local", "Сергей Голуб", "Орнитолог выходного дня без лицензии.", "https://i.pravatar.cc/240?img=68"],
] as const;

const seedPosts = [
  [0, "https://images.unsplash.com/photo-1551183053-bf91a1d81141?auto=format&fit=crop&w=1200&q=82", "Паста ждала съёмку дольше, чем я отпуск."],
  [1, "https://images.unsplash.com/photo-1511818966892-d7d671e672a2?auto=format&fit=crop&w=1200&q=82", "Панельки поймали золотой час. Теперь официально красиво."],
  [2, "https://images.unsplash.com/photo-1416879595882-3373a0480b5b?auto=format&fit=crop&w=1200&q=82", "Охрана рассады заступила на смену."],
  [3, "https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=1200&q=82", "Семейный совет постановил: всем надеть шапки."],
  [4, "https://images.unsplash.com/photo-1497215728101-856f4ea42174?auto=format&fit=crop&w=1200&q=82", "Совещание могло быть сообщением. Тапочки — нет."],
  [5, "https://images.unsplash.com/photo-1559028012-481c04fa702d?auto=format&fit=crop&w=1200&q=82", "Кнопка стала крупнее. Счастье не стало."],
  [6, "https://images.unsplash.com/photo-1533089860892-a7c6f0a88666?auto=format&fit=crop&w=1200&q=82", "Завтрак в 17:43 считается поздним только для слабых."],
  [7, "https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=1200&q=82", "Голубь посмотрел так, будто квартира теперь его."],
  [0, "https://images.unsplash.com/photo-1525351484163-7529414344d8?auto=format&fit=crop&w=1200&q=82", "Одинокий тост ищет серьёзные отношения с авокадо."],
  [1, "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?auto=format&fit=crop&w=1200&q=82", "Вышла за хлебом, вернулась с архитектурным исследованием."],
  [2, "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1200&q=82", "Пять звёзд. Удобства во дворе, зато закат включён."],
  [3, "https://images.unsplash.com/photo-1484480974693-6ca0a78fb36b?auto=format&fit=crop&w=1200&q=82", "Список дел на день: 1. Составить новый список."],
  [4, "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1200&q=82", "Удалёнка: далеко от работы, близко к холодильнику."],
  [5, "https://images.unsplash.com/photo-1558655146-d09347e92766?auto=format&fit=crop&w=1200&q=82", "Макет согласован. Это не учебная тревога."],
  [6, "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1200&q=82", "Кофе настолько красивый, что пить неловко. Но я справилась."],
  [7, "https://images.unsplash.com/photo-1522926193341-e9ffd686c60f?auto=format&fit=crop&w=1200&q=82", "Переговоры прошли успешно: семечки остались у голубя."],
] as const;

function seedDatabase(): void {
  if (process.env.SEED_DATABASE === "false") return;

  const count = db.prepare("SELECT COUNT(*) AS count FROM users").get() as Row;
  if (asNumber(count.count) > 0) return;

  inTransaction(() => {
    const passwordHash = hashSync("demo12345", 10);
    const insertUser = db.prepare(`
      INSERT INTO users (username, email, password_hash, display_name, bio, avatar_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))
    `);

    seedUsers.forEach((user, index) => {
      insertUser.run(...user.slice(0, 2), passwordHash, ...user.slice(2), `-${30 - index * 2} days`);
    });

    const userRows = db.prepare("SELECT id, username FROM users").all() as Row[];
    const userIds = new Map(userRows.map((row) => [asString(row.username), asNumber(row.id)]));
    const insertPost = db.prepare(`
      INSERT INTO posts (user_id, image_url, caption, created_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))
    `);

    const postIds: number[] = [];
    seedPosts.forEach(([userIndex, imageUrl, caption], index) => {
      const userId = userIds.get(seedUsers[userIndex][0]);
      if (!userId) throw new Error("Seed user is missing");
      const result = insertPost.run(userId, imageUrl, caption, `-${47 - index * 3} hours`);
      postIds.push(Number(result.lastInsertRowid));
    });

    const insertFollow = db.prepare("INSERT INTO follows (follower_id, following_id) VALUES (?, ?)");
    for (let follower = 0; follower < seedUsers.length; follower += 1) {
      for (const offset of [1, 2, 4]) {
        const following = (follower + offset) % seedUsers.length;
        insertFollow.run(
          userIds.get(seedUsers[follower][0])!,
          userIds.get(seedUsers[following][0])!,
        );
      }
    }

    const insertLike = db.prepare("INSERT INTO likes (user_id, post_id) VALUES (?, ?)");
    postIds.forEach((postId, postIndex) => {
      seedUsers.forEach((user, userIndex) => {
        if ((postIndex + userIndex * 2) % 5 !== 0) {
          insertLike.run(userIds.get(user[0])!, postId);
        }
      });
    });

    const commentBodies = [
      "Это обложка моего понедельника.",
      "Сохраняю в папку «важные исследования».",
      "Уровень эстетики: вышел за хлебом.",
      "Наконец-то полезный контент в интернете.",
      "Срочно нужен мастер-класс.",
      "XIVI это принял. Зачем — неясно.",
      "У меня было так же, но без золотого часа.",
      "Смотрю уже минуту и полностью согласен.",
    ];
    const insertComment = db.prepare(
      "INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))",
    );
    postIds.forEach((postId, postIndex) => {
      const commentsForPost = 1 + (postIndex % 3);
      for (let index = 0; index < commentsForPost; index += 1) {
        const authorIndex = (postIndex + index + 2) % seedUsers.length;
        insertComment.run(
          postId,
          userIds.get(seedUsers[authorIndex][0])!,
          commentBodies[(postIndex + index) % commentBodies.length],
          `-${postIndex * 3 + index + 1} hours`,
        );
      }
    });
  });
}

seedDatabase();

function authorFromRow(row: Row, prefix = "author_"): ApiAuthor {
  return {
    id: asNumber(row[`${prefix}id`]),
    username: asString(row[`${prefix}username`]),
    displayName: asString(row[`${prefix}display_name`]),
    avatarUrl: row[`${prefix}avatar_url`] === null ? "" : asString(row[`${prefix}avatar_url`]),
  };
}

const userSelect = `
  SELECT
    u.id,
    u.username,
    u.email,
    u.display_name,
    u.bio,
    u.avatar_url,
    u.role,
    u.is_banned,
    u.email_verified_at,
    u.created_at,
    (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS posts_count,
    (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) AS followers_count,
    (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id) AS following_count,
    CASE WHEN ? IS NOT NULL AND EXISTS (
      SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = u.id
    ) THEN 1 ELSE 0 END AS followed_by_me
  FROM users u
`;

function userFromRow(row: Row, viewerId: number | null): ApiUser {
  const isMe = viewerId !== null && asNumber(row.id) === viewerId;
  const user: ApiUser = {
    id: asNumber(row.id),
    username: asString(row.username),
    displayName: asString(row.display_name),
    bio: asString(row.bio),
    avatarUrl: row.avatar_url === null ? "" : asString(row.avatar_url),
    createdAt: asString(row.created_at),
    postsCount: asNumber(row.posts_count),
    followersCount: asNumber(row.followers_count),
    followingCount: asNumber(row.following_count),
    isFollowing: Boolean(asNumber(row.followed_by_me)),
    isMe,
    role: asString(row.role) === "admin" ? "admin" : "user",
    emailVerified: row.email_verified_at !== null,
    ...(isMe ? { isBanned: Boolean(asNumber(row.is_banned)) } : {}),
  };
  if (isMe) user.email = asString(row.email);
  return user;
}

export function getUserById(userId: number, viewerId: number | null = userId): ApiUser | null {
  const row = db
    .prepare(`${userSelect} WHERE u.id = ?`)
    .get(viewerId, viewerId, userId) as Row | undefined;
  return row ? userFromRow(row, viewerId) : null;
}

export function getUserByUsername(username: string, viewerId: number | null): ApiUser | null {
  const row = db
    .prepare(`${userSelect} WHERE u.username = ? COLLATE NOCASE`)
    .get(viewerId, viewerId, username) as Row | undefined;
  return row ? userFromRow(row, viewerId) : null;
}

export function findCredentials(identity: string): Row | null {
  const row = db
    .prepare(`
      SELECT id, username, email, password_hash
      FROM users
      WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE
    `)
    .get(identity, identity) as Row | undefined;
  return row ?? null;
}

export function createUser(input: {
  username: string;
  email: string;
  passwordHash: string;
  displayName: string;
}): ApiUser {
  const result = db
    .prepare(`
      INSERT INTO users (username, email, password_hash, display_name)
      VALUES (?, ?, ?, ?)
    `)
    .run(input.username, input.email, input.passwordHash, input.displayName);
  return getUserById(Number(result.lastInsertRowid))!;
}

export function createSession(tokenHash: string, userId: number, expiresAt: number): void {
  const now = Date.now();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(tokenHash, userId, now, expiresAt);
}

export function getSession(tokenHash: string): { userId: number; expiresAt: number } | null {
  const row = db
    .prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .get(tokenHash, Date.now()) as Row | undefined;
  return row ? { userId: asNumber(row.user_id), expiresAt: asNumber(row.expires_at) } : null;
}

export function deleteSession(tokenHash: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function deleteSessionsForUser(userId: number): number {
  const result = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return Number(result.changes);
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
    CASE WHEN ? IS NOT NULL AND EXISTS (
      SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?
    ) THEN 1 ELSE 0 END AS liked_by_me
  FROM posts p
  JOIN users u ON u.id = p.user_id
`;

function getLatestComments(postId: number, viewerId: number | null, limit = 3): ApiComment[] {
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
    canDelete: viewerId !== null && asNumber(row.user_id) === viewerId,
  }));
}

function postFromRow(row: Row, viewerId: number | null, commentLimit = 3): ApiPost {
  return {
    id: asNumber(row.id),
    imageUrl: asString(row.image_url),
    caption: asString(row.caption),
    createdAt: asString(row.created_at),
    author: authorFromRow(row),
    likesCount: asNumber(row.likes_count),
    commentsCount: asNumber(row.comments_count),
    likedByMe: Boolean(asNumber(row.liked_by_me)),
    canDelete: viewerId !== null && asNumber(row.user_id) === viewerId,
    comments: getLatestComments(asNumber(row.id), viewerId, commentLimit),
  };
}

export function getPost(postId: number, viewerId: number | null, commentLimit = 50): ApiPost | null {
  const row = db
    .prepare(`${postSelect} WHERE p.id = ?`)
    .get(viewerId, viewerId, postId) as Row | undefined;
  return row ? postFromRow(row, viewerId, commentLimit) : null;
}

export function getFeed(input: {
  viewerId: number | null;
  scope: "all" | "following";
  page: number;
  limit: number;
}): { posts: ApiPost[]; hasMore: boolean } {
  const where =
    input.scope === "following"
      ? `WHERE p.user_id = ? OR EXISTS (
           SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = p.user_id
         )`
      : "";
  const paginationParams = [input.limit + 1, (input.page - 1) * input.limit];
  const params =
    input.scope === "following"
      ? [input.viewerId, input.viewerId, input.viewerId, input.viewerId, ...paginationParams]
      : [input.viewerId, input.viewerId, ...paginationParams];

  const rows = db
    .prepare(`${postSelect} ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`)
    .all(...params) as Row[];
  const hasMore = rows.length > input.limit;
  return {
    posts: rows.slice(0, input.limit).map((row) => postFromRow(row, input.viewerId)),
    hasMore,
  };
}

export function getProfile(username: string, viewerId: number | null): {
  user: ApiUser;
  posts: ApiPost[];
} | null {
  const user = getUserByUsername(username, viewerId);
  if (!user) return null;
  const rows = db
    .prepare(`${postSelect} WHERE p.user_id = ? ORDER BY p.created_at DESC, p.id DESC`)
    .all(viewerId, viewerId, user.id) as Row[];
  return { user, posts: rows.map((row) => postFromRow(row, viewerId)) };
}

export function toggleFollow(followerId: number, followingId: number): {
  following: boolean;
  followersCount: number;
} {
  return inTransaction(() => {
    const existing = db
      .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?")
      .get(followerId, followingId);
    if (existing) {
      db.prepare("DELETE FROM follows WHERE follower_id = ? AND following_id = ?").run(
        followerId,
        followingId,
      );
    } else {
      db.prepare("INSERT INTO follows (follower_id, following_id) VALUES (?, ?)").run(
        followerId,
        followingId,
      );
    }
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM follows WHERE following_id = ?")
      .get(followingId) as Row;
    return { following: !existing, followersCount: asNumber(count.count) };
  });
}

export function createPost(userId: number, imageUrl: string, caption: string): ApiPost {
  const result = db
    .prepare("INSERT INTO posts (user_id, image_url, caption) VALUES (?, ?, ?)")
    .run(userId, imageUrl, caption);
  return getPost(Number(result.lastInsertRowid), userId)!;
}

export function deletePost(postId: number, userId: number): string | null {
  const row = db
    .prepare("SELECT image_url FROM posts WHERE id = ? AND user_id = ?")
    .get(postId, userId) as Row | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM posts WHERE id = ? AND user_id = ?").run(postId, userId);
  return asString(row.image_url);
}

export function toggleLike(postId: number, userId: number): {
  liked: boolean;
  likesCount: number;
} | null {
  const post = db.prepare("SELECT 1 FROM posts WHERE id = ?").get(postId);
  if (!post) return null;

  return inTransaction(() => {
    const existing = db
      .prepare("SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?")
      .get(userId, postId);
    if (existing) {
      db.prepare("DELETE FROM likes WHERE user_id = ? AND post_id = ?").run(userId, postId);
    } else {
      db.prepare("INSERT INTO likes (user_id, post_id) VALUES (?, ?)").run(userId, postId);
    }
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM likes WHERE post_id = ?")
      .get(postId) as Row;
    return { liked: !existing, likesCount: asNumber(count.count) };
  });
}

export function createComment(postId: number, userId: number, body: string): ApiComment | null {
  const post = db.prepare("SELECT 1 FROM posts WHERE id = ?").get(postId);
  if (!post) return null;
  const result = db
    .prepare("INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)")
    .run(postId, userId, body);
  const row = db
    .prepare(`
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
      WHERE c.id = ?
    `)
    .get(Number(result.lastInsertRowid)) as Row;
  return {
    id: asNumber(row.id),
    text: asString(row.body),
    createdAt: asString(row.created_at),
    author: authorFromRow(row),
    canDelete: true,
  };
}

export function deleteComment(commentId: number, userId: number): boolean {
  const result = db
    .prepare("DELETE FROM comments WHERE id = ? AND user_id = ?")
    .run(commentId, userId);
  return Number(result.changes) > 0;
}

export function updateProfile(
  userId: number,
  input: { username?: string; displayName?: string; bio?: string },
): ApiUser {
  const current = db.prepare("SELECT username, display_name, bio FROM users WHERE id = ?").get(userId) as Row;
  db.prepare("UPDATE users SET username = ?, display_name = ?, bio = ? WHERE id = ?").run(
    input.username ?? asString(current.username),
    input.displayName ?? asString(current.display_name),
    input.bio ?? asString(current.bio),
    userId,
  );
  return getUserById(userId)!;
}

export function updateAvatar(userId: number, avatarUrl: string): { user: ApiUser; oldAvatarUrl: string | null } {
  const row = db.prepare("SELECT avatar_url FROM users WHERE id = ?").get(userId) as Row;
  const oldAvatarUrl = row.avatar_url === null ? null : asString(row.avatar_url);
  db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(avatarUrl, userId);
  return { user: getUserById(userId)!, oldAvatarUrl };
}
