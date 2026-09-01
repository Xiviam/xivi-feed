import type {
  ApiErrorShape,
  Comment,
  ChatMessage,
  Conversation,
  FeedPayload,
  LoginResult,
  Notification,
  ModerationSummary,
  ModerationUser,
  Post,
  ProfilePayload,
  PostReport,
  SearchPayload,
  TwoFactorSetup,
  TwoFactorStatus,
  User,
} from "./types";

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(isForm ? {} : options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  const payload = (await response.json().catch(() => ({}))) as { data?: T } & ApiErrorShape;
  if (!response.ok) {
    throw new ApiError(payload.error?.message ?? "Что-то пошло не так. Попробуй ещё раз.", response.status, payload.error?.code);
  }
  return payload.data as T;
}

export const api = {
  me: () => request<{ user: User | null }>("/api/auth/me"),
  login: (input: { login: string; password: string }) =>
    request<LoginResult>("/api/auth/login", { method: "POST", body: JSON.stringify(input) }),
  verifyTwoFactorLogin: (challengeToken: string, code: string) =>
    request<{ user: User }>("/api/auth/2fa", { method: "POST", body: JSON.stringify({ challengeToken, code }) }),
  register: (input: { email: string; username: string; displayName: string; password: string }) =>
    request<{ user: User; verificationSent: boolean }>("/api/auth/register", { method: "POST", body: JSON.stringify(input) }),
  logout: () => request<{ success: boolean }>("/api/auth/logout", { method: "POST" }),
  feed: (scope: "all" | "following", page = 1) => request<FeedPayload>(`/api/feed?scope=${scope}&page=${page}&limit=8`),
  post: (postId: number) => request<{ post: Post }>(`/api/posts/${postId}`),
  profile: (username: string) => request<ProfilePayload>(`/api/users/${encodeURIComponent(username)}`),
  follow: (username: string) =>
    request<{ following: boolean; followersCount: number }>(`/api/users/${encodeURIComponent(username)}/follow`, { method: "POST" }),
  like: (postId: number) =>
    request<{ liked: boolean; likesCount: number }>(`/api/posts/${postId}/like`, { method: "POST" }),
  save: (postId: number) =>
    request<{ saved: boolean }>(`/api/posts/${postId}/save`, { method: "POST" }),
  saved: (page = 1) => request<FeedPayload>(`/api/saved?page=${page}&limit=12`),
  search: (query: string) => request<SearchPayload>(`/api/search?q=${encodeURIComponent(query)}&limit=12`),
  reportPost: (postId: number, input: { category: string; details: string }) =>
    request<{ report: { id: number; status: "open" } }>(`/api/posts/${postId}/report`, { method: "POST", body: JSON.stringify(input) }),
  notifications: (page = 1) => request<{ notifications: Notification[]; hasMore: boolean }>(`/api/notifications?page=${page}&limit=30`),
  unreadNotifications: () => request<{ count: number }>("/api/notifications/unread"),
  markNotificationsRead: (ids: number[]) => request<{ markedRead: number }>("/api/notifications/read", { method: "POST", body: JSON.stringify({ ids }) }),
  comment: (postId: number, text: string) =>
    request<{ comment: Comment }>(`/api/posts/${postId}/comments`, { method: "POST", body: JSON.stringify({ text }) }),
  deleteComment: (commentId: number) =>
    request<{ deleted: boolean }>(`/api/comments/${commentId}`, { method: "DELETE" }),
  createPost: (image: File, caption: string) => {
    const form = new FormData();
    form.append("image", image);
    form.append("caption", caption);
    return request<{ post: Post }>("/api/posts", { method: "POST", body: form });
  },
  deletePost: (postId: number) => request<{ deleted: boolean }>(`/api/posts/${postId}`, { method: "DELETE" }),
  updateProfile: (input: { displayName: string; bio: string }) =>
    request<{ user: User }>("/api/profile", { method: "PATCH", body: JSON.stringify(input) }),
  updateAvatar: (avatar: File) => {
    const form = new FormData();
    form.append("avatar", avatar);
    return request<{ user: User }>("/api/profile/avatar", { method: "POST", body: form });
  },
  twoFactorStatus: () => request<TwoFactorStatus>("/api/security/2fa/status"),
  beginTwoFactorSetup: (password: string) =>
    request<TwoFactorSetup>("/api/security/2fa/setup", { method: "POST", body: JSON.stringify({ password }) }),
  enableTwoFactor: (code: string) =>
    request<{ enabled: true; recoveryCodes: string[] }>("/api/security/2fa/enable", { method: "POST", body: JSON.stringify({ code }) }),
  disableTwoFactor: (password: string, code: string) =>
    request<{ enabled: false }>("/api/security/2fa/disable", { method: "POST", body: JSON.stringify({ password, code }) }),
  regenerateRecoveryCodes: (code: string) =>
    request<{ recoveryCodes: string[] }>("/api/security/2fa/recovery-codes", { method: "POST", body: JSON.stringify({ code }) }),
  sendVerificationEmail: () => request<{ sent: boolean; configured: boolean }>("/api/email/verification/send", { method: "POST" }),
  verifyEmail: (token: string) => request<{ verified: true; user: User }>("/api/email/verify", { method: "POST", body: JSON.stringify({ token }) }),
  forgotPassword: (email: string) => request<{ accepted: true }>("/api/auth/password/forgot", { method: "POST", body: JSON.stringify({ email }) }),
  resetPassword: (token: string, password: string) => request<{ user: User }>("/api/auth/password/reset", { method: "POST", body: JSON.stringify({ token, password }) }),
  conversations: () => request<{ conversations: Conversation[]; unreadTotal: number }>("/api/conversations"),
  startConversation: (username: string) => request<{ conversation: Conversation }>(`/api/conversations/direct/${encodeURIComponent(username)}`, { method: "POST" }),
  messages: (conversationId: number, before?: number) => request<{ messages: ChatMessage[]; hasMore: boolean }>(`/api/conversations/${conversationId}/messages?limit=50${before ? `&before=${before}` : ""}`),
  sendMessage: (conversationId: number, text: string) => request<{ message: ChatMessage }>(`/api/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  markConversationRead: (conversationId: number) => request<{ readThroughId: number }>(`/api/conversations/${conversationId}/read`, { method: "POST" }),
  adminSummary: () => request<ModerationSummary>("/api/admin/summary"),
  adminUsers: (query = "", page = 1) => request<{ users: ModerationUser[]; hasMore: boolean }>(`/api/admin/users?q=${encodeURIComponent(query)}&page=${page}&limit=25`),
  adminReports: (status = "open", page = 1) => request<{ reports: PostReport[]; hasMore: boolean }>(`/api/admin/reports?status=${encodeURIComponent(status)}&page=${page}&limit=25`),
  banUser: (userId: number, reason: string, durationDays: number) => request<{ banned: true; until: number | null }>(`/api/admin/users/${userId}/ban`, { method: "POST", body: JSON.stringify({ reason, durationDays }) }),
  unbanUser: (userId: number) => request<{ unbanned: boolean }>(`/api/admin/users/${userId}/unban`, { method: "POST" }),
  resolveReport: (reportId: number, status: "resolved" | "dismissed", note = "") => request<{ resolved: true }>(`/api/admin/reports/${reportId}/resolve`, { method: "POST", body: JSON.stringify({ status, note }) }),
  adminDeletePost: (postId: number, reason: string) => request<{ deleted: true }>(`/api/admin/posts/${postId}`, { method: "DELETE", body: JSON.stringify({ reason }) }),
};
