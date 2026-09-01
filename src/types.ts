export type User = {
  id: number;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string;
  postsCount?: number;
  followersCount?: number;
  followingCount?: number;
  isFollowing?: boolean;
  isMe?: boolean;
  role?: "user" | "admin";
  emailVerified?: boolean;
  isBanned?: boolean;
};

export type Comment = {
  id: number;
  text: string;
  createdAt: string;
  author: User;
  canDelete?: boolean;
};

export type Post = {
  id: number;
  caption: string;
  imageUrl: string;
  createdAt: string;
  author: User;
  likesCount: number;
  commentsCount: number;
  likedByMe: boolean;
  savedByMe?: boolean;
  canDelete?: boolean;
  comments: Comment[];
};

export type LoginResult =
  | { user: User; requiresTwoFactor?: false }
  | { requiresTwoFactor: true; challengeToken: string; expiresAt: number };

export type TwoFactorStatus = {
  enabled: boolean;
  setupPending: boolean;
  recoveryCodesRemaining: number;
};

export type TwoFactorSetup = {
  secret: string;
  otpauthUri: string;
  expiresAt: number;
};

export type Notification = {
  id: number;
  type: "like" | "comment" | "follow" | string;
  postId: number | null;
  commentId: number | null;
  isRead: boolean;
  createdAt: string;
  actor: User;
  post: { id: number; imageUrl: string; caption: string } | null;
};

export type SearchPayload = {
  users: User[];
  posts: Post[];
};

export type Conversation = {
  id: number;
  otherUser: User;
  lastMessage: string;
  lastMessageAt: string;
  lastMessageMine: boolean;
  unreadCount: number;
};

export type ChatMessage = {
  id: number;
  conversationId: number;
  body: string;
  createdAt: string;
  mine: boolean;
  sender: User;
};

export type ModerationUser = {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  email: string;
  role: "user" | "admin";
  isBanned: boolean;
  bannedReason: string;
  bannedUntil: number | null;
  createdAt: string;
  postsCount: number;
  reportsCount: number;
};

export type PostReport = {
  id: number;
  category: string;
  details: string;
  status: "open" | "resolved" | "dismissed";
  createdAt: string;
  resolutionNote: string;
  reporter: User;
  post: { id: number; imageUrl: string; caption: string; author: User };
};

export type ModerationSummary = {
  openReports: number;
  bannedUsers: number;
  totalUsers: number;
};

export type FeedPayload = {
  posts: Post[];
  hasMore: boolean;
};

export type ProfilePayload = {
  user: User;
  posts: Post[];
};

export type ApiErrorShape = {
  error?: {
    code?: string;
    message?: string;
    issues?: Array<{ path?: string[]; message: string }>;
  };
};
