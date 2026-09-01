export interface AuthContext {
  userId: number;
  sessionHash: string;
}

export interface ApiUser {
  id: number;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string;
  createdAt: string;
  postsCount: number;
  followersCount: number;
  followingCount: number;
  isFollowing: boolean;
  isMe: boolean;
  role: "user" | "admin";
  emailVerified: boolean;
  isBanned?: boolean;
  email?: string;
}

export interface ApiAuthor {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string;
}

export interface ApiComment {
  id: number;
  text: string;
  createdAt: string;
  author: ApiAuthor;
  canDelete: boolean;
}

export interface ApiPost {
  id: number;
  imageUrl: string;
  caption: string;
  createdAt: string;
  author: ApiAuthor;
  likesCount: number;
  commentsCount: number;
  likedByMe: boolean;
  canDelete: boolean;
  comments: ApiComment[];
}

declare global {
  namespace Express {
    interface Request {
      auth: AuthContext | null;
    }
  }
}

export {};
