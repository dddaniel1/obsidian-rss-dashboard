import type { SyncOperation } from "./sync-outbox";

export interface SyncRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}
export type SyncTransport = (request: SyncRequest) => Promise<{ status: number; text: string }>;
export interface RemoteFolder { id: string; name: string }
export interface RemoteSubscription { id: string; title: string; url: string; folder: string }
export interface RemoteArticle {
  id: string;
  feedId: string;
  title: string;
  link: string;
  content: string;
  published: number;
  read: boolean;
  starred: boolean;
  author: string;
  audioUrl?: string;
  videoUrl?: string;
}
export interface ArticlePage {
  articles: RemoteArticle[];
  cursor?: string;
}
export interface ArticleQuery {
  cursor?: string;
  since?: number;
  stream?: string;
}
export interface SyncProvider {
  login(username: string, password: string): Promise<void>;
  getFolders(): Promise<RemoteFolder[]>;
  getSubscriptions(): Promise<RemoteSubscription[]>;
  getArticles(query: ArticleQuery): Promise<ArticlePage>;
  getStateIds(field: "read" | "starred", cursor?: string): Promise<{ ids: string[]; cursor?: string }>;
  execute(operation: SyncOperation): Promise<void>;
}
export class SyncError extends Error {
  constructor(message: string, public readonly code: "auth" | "network" | "server" | "invalid" | "conflict", public readonly retryable = false) {
    super(message);
    this.name = "SyncError";
  }
}
