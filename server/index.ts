import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { compare, hash } from "bcryptjs";
import compression from "compression";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import multer from "multer";
import { z } from "zod";

import {
  createComment,
  createPost,
  createSession,
  createUser,
  deleteComment,
  deletePost,
  deleteSession,
  deleteSessionsForUser,
  findCredentials,
  getFeed,
  getPost,
  getProfile,
  getSession,
  getUserById,
  getUserByUsername,
  toggleFollow,
  toggleLike,
  updateAvatar,
  updateProfile,
  uploadsDirectory,
} from "./db.js";
import {
  createNotification,
  getNotifications,
  getSavedPosts,
  getUnreadCount,
  isPostSaved,
  markNotificationsRead,
  removeFollowNotification,
  removeLikeNotification,
  searchContent,
  toggleSavedPost,
} from "./social-features.js";
import {
  beginSetup,
  createLoginChallenge,
  disableTwoFactor,
  enableTwoFactor,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
  TwoFactorError,
  verifyLoginChallenge,
} from "./two-factor.js";
import {
  banUser,
  createPostReport,
  deletePostAsModerator,
  getAccessState,
  listModerationUsers,
  listReports,
  moderationSummary,
  resolveReport,
  syncConfiguredAdmin,
  unbanUser,
} from "./moderation.js";
import {
  conversationRecipient,
  getMessages,
  listConversations,
  markConversationRead,
  sendMessage,
  startDirectConversation,
} from "./messaging.js";
import {
  consumePasswordResetToken,
  emailIsConfigured,
  sendPasswordResetEmail,
  sendVerificationEmail,
  verifyEmailToken,
} from "./email.js";
import type { ApiPost } from "./types.js";
import type { ApiUser } from "./types.js";

const app = express();
const sessionCookieName = "xivi_session";
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const isProduction = process.env.NODE_ENV === "production";

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
  }
}

const asyncRoute =
  (handler: (request: Request, response: Response, next: NextFunction) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };

function sendData(response: Response, data: unknown, status = 200): void {
  response.status(status).json({ data });
}

function runNotificationSideEffect(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    // The user's like/follow/comment already succeeded; a notification must not turn it into a false 500.
    console.error("Notification side effect failed", error);
  }
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Данные не прошли проверку. Где-то ошибка, подробности ниже.",
      result.error.flatten(),
    );
  }
  return result.data;
}

function parsePositiveInteger(value: unknown, label = "id"): number {
  const parsed = z.coerce.number().int().positive().safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, "INVALID_ID", `Некорректный ${label}.`);
  }
  return parsed.data;
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    path: "/",
    maxAge: sessionLifetimeMs,
  };
}

function clearSessionCookie(response: Response): void {
  response.clearCookie(sessionCookieName, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
  });
}

function issueSession(response: Response, userId: number): void {
  const token = randomBytes(32).toString("base64url");
  createSession(hashSessionToken(token), userId, Date.now() + sessionLifetimeMs);
  response.cookie(sessionCookieName, token, sessionCookieOptions());
}

function withSavedState(post: ApiPost, viewerId: number | null): ApiPost & { savedByMe: boolean } {
  return {
    ...post,
    savedByMe: viewerId === null ? false : isPostSaved(viewerId, post.id),
  };
}

async function verifyCurrentPassword(userId: number, password: string): Promise<void> {
  const user = getUserById(userId);
  const credentials = user ? findCredentials(user.username) : null;
  const valid = credentials ? await compare(password, String(credentials.password_hash)) : false;
  if (!valid) {
    throw new ApiError(401, "INVALID_PASSWORD", "Текущий пароль неверный.");
  }
}

function requireUser(request: Request): number {
  if (!request.auth) {
    throw new ApiError(401, "AUTH_REQUIRED", "Сначала войди в XIVI.");
  }
  const access = getAccessState(request.auth.userId);
  if (!access) throw new ApiError(401, "AUTH_REQUIRED", "Сессия больше не действует.");
  if (access.banned) {
    const until = access.until ? ` до ${new Date(access.until).toLocaleDateString("ru-RU")}` : " бессрочно";
    throw new ApiError(403, "ACCOUNT_BANNED", `Аккаунт заблокирован${until}. ${access.reason}`.trim());
  }
  return request.auth.userId;
}

function requireAdmin(request: Request): number {
  const userId = requireUser(request);
  if (getAccessState(userId)?.role !== "admin") {
    throw new ApiError(403, "ADMIN_REQUIRED", "Этот раздел доступен только администратору.");
  }
  return userId;
}

function requireAuthMiddleware(request: Request, _response: Response, next: NextFunction): void {
  try {
    requireUser(request);
    next();
  } catch (error) {
    next(error);
  }
}

const authRateWindowMs = 15 * 60 * 1000;
const authRateLimit = 20;
const authRateBuckets = new Map<string, { attempts: number; resetsAt: number }>();

function limitAuthAttempts(request: Request, response: Response, next: NextFunction): void {
  const now = Date.now();
  const key = request.ip || request.socket.remoteAddress || "unknown";
  const current = authRateBuckets.get(key);
  const bucket = !current || current.resetsAt <= now
    ? { attempts: 0, resetsAt: now + authRateWindowMs }
    : current;

  bucket.attempts += 1;
  authRateBuckets.set(key, bucket);

  if (authRateBuckets.size > 10_000) {
    for (const [bucketKey, value] of authRateBuckets) {
      if (value.resetsAt <= now) authRateBuckets.delete(bucketKey);
    }
  }

  if (bucket.attempts > authRateLimit) {
    response.setHeader("Retry-After", Math.ceil((bucket.resetsAt - now) / 1000));
    response.status(429).json({
      error: {
        code: "TOO_MANY_AUTH_ATTEMPTS",
        message: "Слишком много попыток. Пауза на несколько минут.",
      },
    });
    return;
  }

  next();
}

const imageMimeExtensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, uploadsDirectory),
    filename: (_request, file, callback) => {
      callback(null, `${randomUUID()}${imageMimeExtensions[file.mimetype] ?? ""}`);
    },
  }),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_request, file, callback) => {
    if (!imageMimeExtensions[file.mimetype]) {
      callback(new ApiError(415, "UNSUPPORTED_IMAGE", "Формат не подходит. Нужен JPEG, PNG или WebP."));
      return;
    }
    callback(null, true);
  },
});

async function removeLocalUpload(url: string | null | undefined): Promise<void> {
  if (!url?.startsWith("/uploads/")) return;
  const filename = path.basename(url);
  if (!filename) return;
  await unlink(path.join(uploadsDirectory, filename)).catch(() => undefined);
}

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://images.unsplash.com",
          "https://i.pravatar.cc",
        ],
        connectSrc: ["'self'", ...(isProduction ? [] : ["ws:"])],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: isProduction ? [] : null,
      },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "128kb" }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));
app.use(
  "/uploads",
  express.static(uploadsDirectory, {
    fallthrough: false,
    immutable: true,
    maxAge: "30d",
    index: false,
  }),
);

const configuredOrigin = process.env.CORS_ORIGIN?.trim();
if (configuredOrigin) {
  app.use((request, response, next) => {
    if (request.headers.origin === configuredOrigin) {
      response.header("Access-Control-Allow-Origin", configuredOrigin);
      response.header("Access-Control-Allow-Credentials", "true");
      response.header("Vary", "Origin");
      response.header("Access-Control-Allow-Headers", "Content-Type");
      response.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    }
    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }
    next();
  });
}

app.use("/api", (request, response, next) => {
  request.auth = null;
  const token = request.cookies?.[sessionCookieName];
  if (typeof token !== "string" || token.length < 32 || token.length > 128) {
    next();
    return;
  }

  const sessionHash = hashSessionToken(token);
  const session = getSession(sessionHash);
  if (!session) {
    clearSessionCookie(response);
    next();
    return;
  }

  request.auth = { userId: session.userId, sessionHash };
  next();
});

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Минимум 3 символа")
  .max(24, "Максимум 24 символа")
  .regex(/^[a-z0-9._]+$/, "Только латиница, цифры, точка и подчёркивание");
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(8).max(72);
const displayNameSchema = z.string().trim().min(1).max(50);

const registrationSchema = z
  .object({
    username: usernameSchema,
    email: emailSchema,
    password: passwordSchema,
    displayName: displayNameSchema.optional(),
  })
  .strict();

const loginSchema = z
  .object({
    login: z.string().trim().min(1).max(254).optional(),
    identity: z.string().trim().min(1).max(254).optional(),
    email: z.string().trim().min(1).max(254).optional(),
    username: z.string().trim().min(1).max(254).optional(),
    password: passwordSchema,
  })
  .strict()
  .refine((value) => Boolean(value.login ?? value.identity ?? value.email ?? value.username), {
    message: "Укажи email или username",
    path: ["login"],
  });

const profileSchema = z
  .object({
    username: usernameSchema.optional(),
    displayName: displayNameSchema.optional(),
    bio: z.string().trim().max(160).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Нет изменений для сохранения");

const captionSchema = z.string().trim().max(500).default("");
const commentSchema = z.object({ text: z.string().trim().min(1).max(300) }).strict();
const twoFactorCodeSchema = z.string().trim().min(6).max(32);
const twoFactorChallengeSchema = z
  .object({ challengeToken: z.string().trim().min(32).max(200), code: twoFactorCodeSchema })
  .strict();
const passwordConfirmationSchema = z.object({ password: passwordSchema }).strict();
const twoFactorCodeBodySchema = z.object({ code: twoFactorCodeSchema }).strict();
const disableTwoFactorSchema = z
  .object({ password: passwordSchema, code: twoFactorCodeSchema })
  .strict();
const reportSchema = z.object({
  category: z.enum(["spam", "abuse", "nudity", "violence", "copyright", "other"]),
  details: z.string().trim().max(500).default(""),
}).strict();
const messageSchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
const tokenSchema = z.object({ token: z.string().trim().min(32).max(200) }).strict();
const resetPasswordSchema = tokenSchema.extend({ password: passwordSchema }).strict();
const banSchema = z.object({
  reason: z.string().trim().min(3).max(300),
  durationDays: z.number().int().min(0).max(3650).default(0),
}).strict();
const resolveReportSchema = z.object({
  status: z.enum(["resolved", "dismissed"]),
  note: z.string().trim().max(500).default(""),
}).strict();

app.get("/api/health", (_request, response) => {
  sendData(response, {
    status: "ok",
    service: "xivi-feed-api",
    encryptedMessaging: true,
    emailConfigured: emailIsConfigured(),
  });
});

app.post(
  "/api/auth/register",
  limitAuthAttempts,
  asyncRoute(async (request, response) => {
    const input = parseInput(registrationSchema, request.body);
    const passwordHash = await hash(input.password, 12);
    const createdUser = createUser({
      username: input.username,
      email: input.email,
      passwordHash,
      displayName: input.displayName ?? input.username,
    });
    syncConfiguredAdmin(createdUser.id, createdUser.username);
    const user = getUserById(createdUser.id)!;
    issueSession(response, user.id);
    const verificationSent = await sendVerificationEmail(user.id).catch(() => false);
    sendData(response, { user, verificationSent }, 201);
  }),
);

app.post(
  "/api/auth/login",
  limitAuthAttempts,
  asyncRoute(async (request, response) => {
    const input = parseInput(loginSchema, request.body);
    const identity = (input.login ?? input.identity ?? input.email ?? input.username ?? "").replace(/^@/, "");
    const credentials = findCredentials(identity);
    const validPassword = credentials
      ? await compare(input.password, String(credentials.password_hash))
      : false;
    if (!credentials || !validPassword) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Логин или пароль неверный. Один из них точно.");
    }

    const userId = Number(credentials.id);
    syncConfiguredAdmin(userId, String(credentials.username));
    const access = getAccessState(userId);
    if (access?.banned) {
      throw new ApiError(403, "ACCOUNT_BANNED", `Аккаунт заблокирован. ${access.reason}`.trim());
    }
    const user = getUserById(userId);
    if (!user) throw new ApiError(401, "INVALID_CREDENTIALS", "Логин или пароль неверный. Один из них точно.");
    if (getTwoFactorStatus(user.id).enabled) {
      const challenge = createLoginChallenge(user.id);
      sendData(response, {
        requiresTwoFactor: true,
        challengeToken: challenge.token,
        expiresAt: challenge.expiresAt,
      });
      return;
    }
    issueSession(response, user.id);
    sendData(response, { user });
  }),
);

app.post("/api/auth/2fa", limitAuthAttempts, (request, response) => {
  const input = parseInput(twoFactorChallengeSchema, request.body);
  const challenge = verifyLoginChallenge(input.challengeToken, input.code);
  const access = getAccessState(challenge.userId);
  if (access?.banned) throw new ApiError(403, "ACCOUNT_BANNED", `Аккаунт заблокирован. ${access.reason}`.trim());
  const user = getUserById(challenge.userId);
  if (!user) throw new ApiError(401, "CHALLENGE_INVALID", "Проверка входа больше не действует.");
  issueSession(response, user.id);
  sendData(response, { user });
});

app.post("/api/auth/logout", (request, response) => {
  if (request.auth) deleteSession(request.auth.sessionHash);
  clearSessionCookie(response);
  sendData(response, { success: true, user: null });
});

app.get("/api/auth/me", (request, response) => {
  const user = request.auth ? getUserById(request.auth.userId) : null;
  sendData(response, { user });
});

app.get("/api/feed", (request, response) => {
  const query = parseInput(
    z.object({
      scope: z.enum(["all", "following"]).default("all"),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(12),
    }),
    request.query,
  );
  if (query.scope === "following" && !request.auth) {
    throw new ApiError(401, "AUTH_REQUIRED", "Сначала войди. Подписки сами себя не покажут.");
  }
  const feed = getFeed({
      viewerId: request.auth?.userId ?? null,
      scope: query.scope,
      page: query.page,
      limit: query.limit,
    });
  sendData(response, {
    ...feed,
    posts: feed.posts.map((post) => withSavedState(post, request.auth?.userId ?? null)),
  });
});

app.get("/api/users/:username", (request, response) => {
  const profile = getProfile(request.params.username, request.auth?.userId ?? null);
  if (!profile) throw new ApiError(404, "USER_NOT_FOUND", "Профиль не найден. База пожала плечами.");
  sendData(response, {
    ...profile,
    posts: profile.posts.map((post) => withSavedState(post, request.auth?.userId ?? null)),
  });
});

app.post("/api/users/:username/follow", (request, response) => {
  const userId = requireUser(request);
  const target = getUserByUsername(request.params.username, userId);
  if (!target) throw new ApiError(404, "USER_NOT_FOUND", "Профиль не найден. База пожала плечами.");
  if (target.id === userId) {
    throw new ApiError(400, "SELF_FOLLOW", "Подписаться на себя нельзя. Даже здесь.");
  }
  const result = toggleFollow(userId, target.id);
  runNotificationSideEffect(() => result.following
    ? createNotification(target.id, userId, "follow")
    : removeFollowNotification(target.id, userId));
  sendData(response, result);
});

app.get("/api/posts/:id", (request, response) => {
  const postId = parsePositiveInteger(request.params.id, "id публикации");
  const post = getPost(postId, request.auth?.userId ?? null);
  if (!post) throw new ApiError(404, "POST_NOT_FOUND", "Публикация не найдена. Интернет переживёт.");
  sendData(response, { post: withSavedState(post, request.auth?.userId ?? null) });
});

app.post(
  "/api/posts",
  requireAuthMiddleware,
  upload.single("image"),
  asyncRoute(async (request, response) => {
    const userId = requireUser(request);
    if (!request.file) {
      throw new ApiError(400, "IMAGE_REQUIRED", "Без изображения публикации не будет. Радикальное правило.");
    }
    const imageUrl = `/uploads/${request.file.filename}`;
    try {
      const caption = parseInput(captionSchema, request.body.caption ?? "");
      const post = createPost(userId, imageUrl, caption);
      sendData(response, { post: withSavedState(post, userId) }, 201);
    } catch (error) {
      await removeLocalUpload(imageUrl);
      throw error;
    }
  }),
);

app.delete(
  "/api/posts/:id",
  asyncRoute(async (request, response) => {
    const userId = requireUser(request);
    const postId = parsePositiveInteger(request.params.id, "id публикации");
    const imageUrl = deletePost(postId, userId);
    if (!imageUrl) {
      throw new ApiError(404, "POST_NOT_FOUND", "Публикация не найдена или уже удалена. Результат одинаковый.");
    }
    await removeLocalUpload(imageUrl);
    sendData(response, { deleted: true });
  }),
);

app.post("/api/posts/:id/like", (request, response) => {
  const userId = requireUser(request);
  const postId = parsePositiveInteger(request.params.id, "id публикации");
  const post = getPost(postId, userId);
  const result = toggleLike(postId, userId);
  if (!result || !post) throw new ApiError(404, "POST_NOT_FOUND", "Публикация не найдена. Лайк остался без работы.");
  runNotificationSideEffect(() => result.liked
    ? createNotification(post.author.id, userId, "like", postId)
    : removeLikeNotification(post.author.id, userId, postId));
  sendData(response, result);
});

app.post("/api/posts/:id/save", (request, response) => {
  const userId = requireUser(request);
  const postId = parsePositiveInteger(request.params.id, "id публикации");
  const result = toggleSavedPost(userId, postId);
  if (!result) throw new ApiError(404, "POST_NOT_FOUND", "Публикация не найдена. Сохранять нечего.");
  sendData(response, result);
});

app.post("/api/posts/:id/report", (request, response) => {
  const userId = requireUser(request);
  const postId = parsePositiveInteger(request.params.id, "id публикации");
  const input = parseInput(reportSchema, request.body);
  const report = createPostReport(userId, postId, input.category, input.details);
  if (!report) throw new ApiError(404, "POST_NOT_FOUND", "Публикация не найдена.");
  sendData(response, { report }, 201);
});

app.post("/api/posts/:id/comments", (request, response) => {
  const userId = requireUser(request);
  const postId = parsePositiveInteger(request.params.id, "id публикации");
  const post = getPost(postId, userId);
  const input = parseInput(commentSchema, request.body);
  const comment = createComment(postId, userId, input.text);
  if (!comment || !post) throw new ApiError(404, "POST_NOT_FOUND", "Публикация не найдена. Комментировать нечего.");
  runNotificationSideEffect(() => createNotification(post.author.id, userId, "comment", postId, comment.id));
  sendData(response, { comment }, 201);
});

app.get("/api/saved", (request, response) => {
  const userId = requireUser(request);
  const query = parseInput(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(12),
    }),
    request.query,
  );
  sendData(response, getSavedPosts(userId, query.page, query.limit));
});

app.get("/api/search", (request, response) => {
  const query = parseInput(
    z.object({
      q: z.string().trim().max(100).default(""),
      limit: z.coerce.number().int().min(1).max(30).default(12),
    }),
    request.query,
  );
  sendData(response, searchContent(request.auth?.userId ?? 0, query.q, query.limit));
});

app.get("/api/notifications", (request, response) => {
  const userId = requireUser(request);
  const query = parseInput(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(30),
    }),
    request.query,
  );
  const notifications = getNotifications(userId, query.limit + 1, (query.page - 1) * query.limit);
  sendData(response, {
    notifications: notifications.slice(0, query.limit),
    hasMore: notifications.length > query.limit,
  });
});

app.get("/api/notifications/unread", (request, response) => {
  const userId = requireUser(request);
  sendData(response, { count: getUnreadCount(userId) });
});

app.post("/api/notifications/read", (request, response) => {
  const userId = requireUser(request);
  const input = parseInput(
    z.object({ ids: z.array(z.number().int().positive()).max(100).default([]) }).strict(),
    request.body,
  );
  sendData(response, { markedRead: markNotificationsRead(userId, input.ids) });
});

app.get("/api/security/2fa/status", (request, response) => {
  const userId = requireUser(request);
  sendData(response, getTwoFactorStatus(userId));
});

app.post(
  "/api/security/2fa/setup",
  limitAuthAttempts,
  asyncRoute(async (request, response) => {
    const userId = requireUser(request);
    const input = parseInput(passwordConfirmationSchema, request.body);
    await verifyCurrentPassword(userId, input.password);
    const user = getUserById(userId);
    if (!user) throw new ApiError(404, "USER_NOT_FOUND", "Аккаунт не найден.");
    sendData(response, beginSetup(userId, user.email ?? user.username));
  }),
);

app.post("/api/security/2fa/enable", limitAuthAttempts, (request, response) => {
  const userId = requireUser(request);
  const input = parseInput(twoFactorCodeBodySchema, request.body);
  const recoveryCodes = enableTwoFactor(userId, input.code);
  deleteSessionsForUser(userId);
  issueSession(response, userId);
  sendData(response, { enabled: true, recoveryCodes });
});

app.post(
  "/api/security/2fa/disable",
  limitAuthAttempts,
  asyncRoute(async (request, response) => {
    const userId = requireUser(request);
    const input = parseInput(disableTwoFactorSchema, request.body);
    await verifyCurrentPassword(userId, input.password);
    disableTwoFactor(userId, input.code);
    deleteSessionsForUser(userId);
    issueSession(response, userId);
    sendData(response, { enabled: false });
  }),
);

app.post("/api/security/2fa/recovery-codes", limitAuthAttempts, (request, response) => {
  const userId = requireUser(request);
  const input = parseInput(twoFactorCodeBodySchema, request.body);
  const recoveryCodes = regenerateRecoveryCodes(userId, input.code);
  sendData(response, { recoveryCodes });
});

app.delete("/api/comments/:id", (request, response) => {
  const userId = requireUser(request);
  const commentId = parsePositiveInteger(request.params.id, "id комментария");
  if (!deleteComment(commentId, userId)) {
    throw new ApiError(404, "COMMENT_NOT_FOUND", "Комментарий не найден или уже удалён.");
  }
  sendData(response, { deleted: true });
});

app.patch("/api/profile", (request, response) => {
  const userId = requireUser(request);
  const input = parseInput(profileSchema, request.body);
  const user = updateProfile(userId, input);
  sendData(response, { user });
});

app.post(
  "/api/profile/avatar",
  requireAuthMiddleware,
  upload.single("avatar"),
  asyncRoute(async (request, response) => {
    const userId = requireUser(request);
    if (!request.file) throw new ApiError(400, "AVATAR_REQUIRED", "Изображение для аватара не приложено.");
    const avatarUrl = `/uploads/${request.file.filename}`;
    try {
      const result = updateAvatar(userId, avatarUrl);
      await removeLocalUpload(result.oldAvatarUrl);
      sendData(response, { user: result.user });
    } catch (error) {
      await removeLocalUpload(avatarUrl);
      throw error;
    }
  }),
);

app.post("/api/email/verification/send", limitAuthAttempts, asyncRoute(async (request, response) => {
  const userId = requireUser(request);
  const sent = await sendVerificationEmail(userId);
  sendData(response, { sent, configured: emailIsConfigured() });
}));

app.post("/api/email/verify", limitAuthAttempts, (request, response) => {
  const input = parseInput(tokenSchema, request.body);
  const userId = verifyEmailToken(input.token);
  if (!userId) throw new ApiError(400, "TOKEN_INVALID", "Ссылка недействительна или уже истекла.");
  sendData(response, { verified: true, user: getUserById(userId) });
});

app.post("/api/auth/password/forgot", limitAuthAttempts, asyncRoute(async (request, response) => {
  const input = parseInput(z.object({ email: emailSchema }).strict(), request.body);
  await sendPasswordResetEmail(input.email);
  sendData(response, { accepted: true });
}));

app.post("/api/auth/password/reset", limitAuthAttempts, asyncRoute(async (request, response) => {
  const input = parseInput(resetPasswordSchema, request.body);
  const passwordHash = await hash(input.password, 12);
  const userId = consumePasswordResetToken(input.token, passwordHash);
  if (!userId) throw new ApiError(400, "TOKEN_INVALID", "Ссылка недействительна или уже истекла.");
  issueSession(response, userId);
  sendData(response, { user: getUserById(userId) });
}));

app.get("/api/conversations", (request, response) => {
  const userId = requireUser(request);
  sendData(response, listConversations(userId));
});

app.post("/api/conversations/direct/:username", (request, response) => {
  const userId = requireUser(request);
  sendData(response, { conversation: startDirectConversation(userId, request.params.username) }, 201);
});

app.get("/api/conversations/:id/messages", (request, response) => {
  const userId = requireUser(request);
  const conversationId = parsePositiveInteger(request.params.id, "id диалога");
  const query = parseInput(z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }), request.query);
  sendData(response, getMessages(userId, conversationId, query.before ?? null, query.limit));
});

app.post("/api/conversations/:id/messages", (request, response) => {
  const userId = requireUser(request);
  const conversationId = parsePositiveInteger(request.params.id, "id диалога");
  const input = parseInput(messageSchema, request.body);
  const message = sendMessage(userId, conversationId, input.text);
  const recipientId = conversationRecipient(userId, conversationId);
  if (recipientId) runNotificationSideEffect(() => createNotification(recipientId, userId, "message"));
  sendData(response, { message }, 201);
});

app.post("/api/conversations/:id/read", (request, response) => {
  const userId = requireUser(request);
  const conversationId = parsePositiveInteger(request.params.id, "id диалога");
  sendData(response, { readThroughId: markConversationRead(userId, conversationId) });
});

app.get("/api/admin/summary", (request, response) => {
  requireAdmin(request);
  sendData(response, moderationSummary());
});

app.get("/api/admin/users", (request, response) => {
  requireAdmin(request);
  const query = parseInput(z.object({
    q: z.string().trim().max(100).default(""),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  }), request.query);
  sendData(response, listModerationUsers(query.q, query.page, query.limit));
});

app.post("/api/admin/users/:id/ban", (request, response) => {
  const moderatorId = requireAdmin(request);
  const targetUserId = parsePositiveInteger(request.params.id, "id пользователя");
  const input = parseInput(banSchema, request.body);
  const until = input.durationDays === 0 ? null : Date.now() + input.durationDays * 24 * 60 * 60 * 1_000;
  if (!banUser(moderatorId, targetUserId, input.reason, until)) {
    throw new ApiError(404, "USER_NOT_FOUND", "Пользователь не найден.");
  }
  sendData(response, { banned: true, until });
});

app.post("/api/admin/users/:id/unban", (request, response) => {
  const moderatorId = requireAdmin(request);
  const targetUserId = parsePositiveInteger(request.params.id, "id пользователя");
  sendData(response, { unbanned: unbanUser(moderatorId, targetUserId) });
});

app.get("/api/admin/reports", (request, response) => {
  requireAdmin(request);
  const query = parseInput(z.object({
    status: z.enum(["open", "resolved", "dismissed", "all"]).default("open"),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  }), request.query);
  sendData(response, listReports(query.status, query.page, query.limit));
});

app.post("/api/admin/reports/:id/resolve", (request, response) => {
  const moderatorId = requireAdmin(request);
  const reportId = parsePositiveInteger(request.params.id, "id жалобы");
  const input = parseInput(resolveReportSchema, request.body);
  if (!resolveReport(moderatorId, reportId, input.status, input.note)) {
    throw new ApiError(404, "REPORT_NOT_FOUND", "Жалоба не найдена или уже обработана.");
  }
  sendData(response, { resolved: true });
});

app.delete("/api/admin/posts/:id", asyncRoute(async (request, response) => {
  const moderatorId = requireAdmin(request);
  const postId = parsePositiveInteger(request.params.id, "id публикации");
  const reason = parseInput(z.string().trim().min(3).max(300), request.body?.reason ?? "Нарушение правил");
  const result = deletePostAsModerator(moderatorId, postId, reason);
  if (!result) throw new ApiError(404, "POST_NOT_FOUND", "Публикация не найдена.");
  await removeLocalUpload(result.imageUrl);
  sendData(response, { deleted: true });
}));

app.use("/api", (_request, _response, next) => {
  next(new ApiError(404, "ROUTE_NOT_FOUND", "Маршрут не найден. API тоже не знает, куда вы шли."));
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof TwoFactorError) {
    const statuses: Partial<Record<typeof error.code, number>> = {
      ALREADY_ENABLED: 409,
      NOT_ENABLED: 409,
      INVALID_CODE: 401,
      CHALLENGE_INVALID: 401,
      SETUP_NOT_FOUND: 404,
      SETUP_EXPIRED: 410,
      CHALLENGE_EXPIRED: 410,
      TOO_MANY_ATTEMPTS: 429,
      USER_NOT_FOUND: 404,
      CODE_REQUIRED: 400,
    };
    response.status(statuses[error.code] ?? 400).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }

  if (error instanceof ApiError) {
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.issues === undefined ? {} : { issues: error.issues }),
      },
    });
    return;
  }

  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE" ? "Изображение больше 10 МБ. Сеть не резиновая." : "Изображение не загрузилось. Ничего героического.";
    response.status(400).json({ error: { code: error.code, message } });
    return;
  }

  if (
    error instanceof SyntaxError &&
    typeof error === "object" &&
    "type" in error &&
    error.type === "entity.parse.failed"
  ) {
    response.status(400).json({
      error: { code: "INVALID_JSON", message: "JSON сломан. Сервер не стал угадывать." },
    });
    return;
  }

  const sqliteMessage = error instanceof Error ? error.message : "";
  if (sqliteMessage.includes("UNIQUE constraint failed: users.username")) {
    response.status(409).json({ error: { code: "USERNAME_TAKEN", message: "Этот username занят. Очередь не ведём." } });
    return;
  }
  if (sqliteMessage.includes("UNIQUE constraint failed: users.email")) {
    response.status(409).json({ error: { code: "EMAIL_TAKEN", message: "Аккаунт с таким email уже есть. Второй не нужен." } });
    return;
  }
  if (sqliteMessage.includes("UNIQUE constraint failed: post_reports.post_id, post_reports.reporter_id")) {
    response.status(409).json({ error: { code: "REPORT_EXISTS", message: "Ты уже отправлял жалобу на эту публикацию." } });
    return;
  }

  const domainErrors: Record<string, { status: number; code: string; message: string }> = {
    CANNOT_REPORT_OWN_POST: { status: 400, code: "CANNOT_REPORT_OWN_POST", message: "На свою публикацию пожаловаться нельзя." },
    CANNOT_BAN_SELF: { status: 400, code: "CANNOT_BAN_SELF", message: "Себя заблокировать нельзя." },
    CANNOT_BAN_ADMIN: { status: 403, code: "CANNOT_BAN_ADMIN", message: "Другого администратора блокировать нельзя." },
    CONVERSATION_NOT_FOUND: { status: 404, code: "CONVERSATION_NOT_FOUND", message: "Диалог не найден." },
    CANNOT_MESSAGE_SELF: { status: 400, code: "CANNOT_MESSAGE_SELF", message: "Диалог с собой пока не поддерживается." },
    USER_NOT_FOUND: { status: 404, code: "USER_NOT_FOUND", message: "Пользователь не найден." },
  };
  const domainError = domainErrors[sqliteMessage];
  if (domainError) {
    response.status(domainError.status).json({ error: { code: domainError.code, message: domainError.message } });
    return;
  }

  console.error(error);
  response.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "XIVI упал. Сервер уже знает, мы тоже.",
    },
  });
});

const port = Number(process.env.PORT ?? 3000);
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

async function mountFrontend(): Promise<void> {
  if (!isProduction) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      appType: "spa",
      server: { middlewareMode: true },
    });
    app.use(vite.middlewares);
    return;
  }

  const distDirectory = path.resolve(process.cwd(), "dist");
  const indexTemplate = await readFile(path.join(distDirectory, "index.html"), "utf8");

  app.use(
    express.static(distDirectory, {
      index: false,
      maxAge: "1y",
      immutable: true,
    }),
  );

  app.use((request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      next();
      return;
    }

    const requestHost = request.get("host") ?? "localhost";
    const safeHost = /^[a-z0-9.-]+(?::\d+)?$/i.test(requestHost) ? requestHost : "localhost";
    const publicOrigin = process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") ?? `${request.protocol}://${safeHost}`;
    response.type("html").send(indexTemplate.replaceAll("__SITE_ORIGIN__", publicOrigin));
  });
}

async function start(): Promise<void> {
  await mountFrontend();
  app.listen(port, "0.0.0.0", () => {
    console.log(`XIVI слушает http://0.0.0.0:${port}`);
  });
}

if (isDirectRun) {
  void start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { app };
