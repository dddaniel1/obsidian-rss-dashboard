import type { ArticleUserState } from "../../types/types";
import type { SyncOperation } from "./sync-outbox";
import { SyncError, type SyncProvider, type RemoteArticle, type RemoteFolder, type RemoteSubscription } from "./sync-provider";

export interface SyncState {
  version: 1;
  accountId: string;
  folders: (RemoteFolder & { pending?: boolean })[];
  subscriptions: RemoteSubscription[];
  articles: Record<string, RemoteArticle & ArticleUserState>;
  operations: SyncOperation[];
  conflicts: { operation: SyncOperation; reason: string }[];
  contentCursor?: string;
  contentSince?: number;
  contentStartedAt?: number;
  /** Set once older states have been re-fetched to backfill media enclosures. */
  mediaEnclosureBackfill?: boolean;
  lastSuccess?: number;
  /** Number of read+unstarred articles kept per feed after pruning. */
  cachedReadArticlesPerFeed?: number;
}
export function emptySyncState(accountId: string): SyncState {
  return { version: 1, accountId, folders: [], subscriptions: [], articles: {}, operations: [], conflicts: [] };
}
type OperationInput = SyncOperation extends infer T ? T extends SyncOperation ? Omit<T, "id" | "accountId"> : never : never;
const LABEL = "user/-/label/";
const DEFAULT_CACHED_READ_PER_FEED = 20;

export class SyncService {
  private state: SyncState;
  private writes: Promise<void> = Promise.resolve();
  private running: Promise<void> | undefined;

  constructor(initial: SyncState, private readonly persist: (state: SyncState) => Promise<void>) {
    this.state = structuredClone(initial);
  }

  snapshot(): SyncState {
    const state = structuredClone(this.state);
    for (const op of state.operations) {
      if (op.kind === "edit-feed") {
        const feed = state.subscriptions.find((item) => item.id === op.feedId);
        if (feed) { feed.title = op.title; feed.folder = op.folder; }
      } else if (op.kind === "unsubscribe") {
        state.subscriptions = state.subscriptions.filter((item) => item.id !== op.feedId);
      } else if (op.kind === "subscribe") {
        if (!state.subscriptions.some((feed) => feed.url === op.url)) {
          state.subscriptions.push({ id: op.localId, url: op.url, title: op.title, folder: op.folder });
        }
      } else if (op.kind === "rename-folder") {
        const folder = state.folders.find((item) => item.id === op.folder);
        if (folder) folder.name = op.name;
      } else if (op.kind === "delete-folder") {
        state.folders = state.folders.filter((item) => item.id !== op.folder);
        for (const feed of state.subscriptions) if (feed.folder === op.folder) feed.folder = "";
      } else if (op.kind === "article-state") {
        const article = state.articles[op.articleId];
        if (article) article[op.field] = op.value;
      }
    }
    return state;
  }

  /**
   * Prune cached articles to keep the state file small.
   * Keeps unread, starred, saved, and the newest N read articles per feed.
   */
  private pruneArticles(state: SyncState): void {
    const limit = state.cachedReadArticlesPerFeed ?? DEFAULT_CACHED_READ_PER_FEED;
    const totalLimit = limit * 2;
    const byFeed = new Map<string, (RemoteArticle & ArticleUserState)[]>();
    for (const article of Object.values(state.articles)) {
      const list = byFeed.get(article.feedId) ?? [];
      list.push(article);
      byFeed.set(article.feedId, list);
    }
    for (const [feedId, articles] of byFeed) {
      const keep = new Set<string>();
      const unread = articles.filter((a) => !a.read);
      const recentUnread = unread
        .sort((a, b) => b.published - a.published)
        .slice(0, limit);
      for (const a of recentUnread) keep.add(a.id);
      const read = articles.filter((a) => a.read);
      const recentRead = read
        .sort((a, b) => b.published - a.published)
        .slice(0, limit);
      for (const a of recentRead) keep.add(a.id);
      // Hard cap: if still over totalLimit, keep only newest
      if (keep.size > totalLimit) {
        const all = articles
          .filter((a) => keep.has(a.id))
          .sort((a, b) => b.published - a.published)
          .slice(0, totalLimit);
        keep.clear();
        for (const a of all) keep.add(a.id);
      }
      for (const a of articles) {
        if (a.starred || a.saved || keep.has(a.id)) continue;
        delete state.articles[a.id];
      }
      void feedId;
    }
  }

  private change(edit: (state: SyncState) => void): Promise<void> {
    const task = this.writes.then(async () => {
      // Shallow-copy the shell; articles are keyed by ID so the map reference
      // can be copied without cloning every article body.
      const next: SyncState = {
        ...this.state,
        folders: [...this.state.folders],
        subscriptions: [...this.state.subscriptions],
        operations: [...this.state.operations],
        articles: { ...this.state.articles },
      };
      edit(next);
      await this.persist(next);
      this.state = next;
    });
    this.writes = task.catch(() => {});
    return task;
  }

  private operation(input: OperationInput): SyncOperation {
    return { ...input, id: window.crypto.randomUUID(), accountId: this.state.accountId };
  }

  async setArticleState(articleId: string, field: "read" | "starred", value: boolean): Promise<void> {
    await this.change((state) => {
      if (!state.articles[articleId]) throw new SyncError("Article is no longer cached", "conflict");
      state.operations.push(this.operation({ kind: "article-state", articleId, field, value }));
      state.articles[articleId][field] = value;
    });
  }

  async setManyArticleStates(ids: string[], field: "read" | "starred", value: boolean): Promise<void> {
    await this.change((state) => {
      for (const id of new Set(ids)) {
        if (!state.articles[id]) continue;
        state.operations.push(this.operation({ kind: "article-state", articleId: id, field, value }));
        state.articles[id][field] = value;
      }
    });
  }

  updateLocalArticle(id: string, updates: Pick<ArticleUserState, "tags" | "saved" | "savedFilePath" | "playbackProgress">): Promise<void> {
    return this.change((state) => {
      const article = state.articles[id];
      if (article) Object.assign(article, updates);
    });
  }

  createFolder(name: string): Promise<void> {
    return this.change((state) => {
      if (!name.trim() || state.folders.some((folder) => folder.name === name.trim())) throw new SyncError("Choose a unique folder name", "invalid");
      state.folders.push({ id: LABEL + name.trim(), name: name.trim(), pending: true });
    });
  }

  renameFolder(id: string, name: string): Promise<void> {
    return this.change((state) => {
      const folder = state.folders.find((item) => item.id === id);
      if (!folder || !name.trim() || state.folders.some((item) => item.id !== id && item.name === name.trim())) throw new SyncError("Choose a unique folder name", "invalid");
      if (folder.pending) {
        folder.name = name.trim();
        folder.id = LABEL + name.trim();
        for (const op of state.operations) {
          if ((op.kind === "subscribe" || op.kind === "edit-feed") && op.folder === id) op.folder = folder.id;
        }
      } else state.operations.push(this.operation({ kind: "rename-folder", folder: id, name: name.trim() }));
    });
  }

  deleteFolder(id: string): Promise<void> {
    return this.change((state) => {
      const folder = state.folders.find((item) => item.id === id);
      if (!folder) return;
      if (folder.pending) state.folders = state.folders.filter((item) => item.id !== id);
      else state.operations.push(this.operation({ kind: "delete-folder", folder: id }));
      for (const op of state.operations) {
        if ((op.kind === "subscribe" || op.kind === "edit-feed") && op.folder === id) op.folder = "";
      }
    });
  }

  subscribe(url: string, title: string, folder: string): Promise<void> {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) return Promise.reject(new SyncError("Use an HTTP or HTTPS feed URL", "invalid"));
    return this.change((state) => {
      if (state.subscriptions.some((feed) => feed.url === url) || state.operations.some((op) => op.kind === "subscribe" && op.url === url)) throw new SyncError("Already subscribed to this feed", "invalid");
      state.operations.push(this.operation({ kind: "subscribe", localId: "local/" + window.crypto.randomUUID(), url, title, folder }));
    });
  }

  editFeed(feedId: string, title: string, folder: string): Promise<void> {
    return this.change((state) => {
      const pending = state.operations.find((op) => op.kind === "subscribe" && op.localId === feedId);
      if (pending?.kind === "subscribe") { pending.title = title; pending.folder = folder; }
      else state.operations.push(this.operation({ kind: "edit-feed", feedId, title, folder }));
    });
  }

  unsubscribe(feedId: string): Promise<void> {
    return this.change((state) => {
      if (feedId.startsWith("local/")) {
        state.operations = state.operations.filter((op) => !(op.kind === "subscribe" && op.localId === feedId));
      } else state.operations.push(this.operation({ kind: "unsubscribe", feedId }));
    });
  }

  dismissConflict(operationId: string): Promise<void> {
    return this.change((state) => { state.conflicts = state.conflicts.filter((item) => item.operation.id !== operationId); });
  }

  synchronize(provider: SyncProvider): Promise<void> {
    if (this.running) return this.running;
    const task = this.run(provider);
    this.running = task;
    void task.finally(() => { this.running = undefined; }).catch(() => {});
    return task;
  }

  private async run(provider: SyncProvider): Promise<void> {
    let folders = await provider.getFolders();
    let feeds = await provider.getSubscriptions();
    // Only complete snapshots are used to infer absence.
    for (const op of this.state.operations.slice()) {
      let absent = false;
      let alreadyDone = false;
      if (op.kind === "edit-feed" || op.kind === "unsubscribe") {
        absent = !feeds.some((feed) => feed.id === op.feedId);
        alreadyDone = absent && op.kind === "unsubscribe";
      } else if (op.kind === "rename-folder" || op.kind === "delete-folder") {
        absent = !folders.some((folder) => folder.id === op.folder);
        alreadyDone = absent && (op.kind === "delete-folder" || folders.some((folder) => folder.id === LABEL + op.name));
      } else if (op.kind === "subscribe") {
        alreadyDone = feeds.some((feed) => feed.url === op.url);
      } else if (op.kind === "article-state") {
        const article = this.state.articles[op.articleId];
        absent = !!article && !feeds.some((feed) => feed.id === article.feedId);
      }
      if (absent && !alreadyDone) {
        await this.change((state) => {
          state.conflicts.push({ operation: op, reason: "The remote object was removed or renamed. The local operation was not replayed." });
          state.operations = state.operations.filter((item) => item.id !== op.id);
        });
        continue;
      }
      if (!alreadyDone) {
        await provider.execute(op);
        folders = await provider.getFolders();
        feeds = await provider.getSubscriptions();
      }
      await this.change((state) => { state.operations = state.operations.filter((item) => item.id !== op.id); });
    }
    await this.change((state) => {
      state.folders = [...folders, ...state.folders.filter((folder) => folder.pending && !folders.some((remote) => remote.id === folder.id))];
      state.subscriptions = feeds;
      state.contentStartedAt ??= Math.floor(Date.now() / 1000);
      if (!state.mediaEnclosureBackfill) {
        // States saved before enclosure capture lack media URLs; re-fetch once.
        state.contentSince = undefined;
        state.mediaEnclosureBackfill = true;
      }
      state.cachedReadArticlesPerFeed ??= DEFAULT_CACHED_READ_PER_FEED;
    });
    const seen = new Set<string>();
    do {
      const current = this.state.contentCursor;
      if (current && seen.has(current)) throw new SyncError("Server repeated a pagination cursor", "invalid");
      if (current) seen.add(current);
      const page = await provider.getArticles({ cursor: current, since: this.state.contentSince });
      await this.change((state) => {
        for (const incoming of page.articles) {
          const old = state.articles[incoming.id];
          state.articles[incoming.id] = { ...old, ...incoming };
        }
        state.contentCursor = page.cursor;
        if (!page.cursor) {
          state.contentSince = Math.max(0, (state.contentStartedAt ?? 0) - 60);
          state.contentStartedAt = undefined;
        }
      });
    } while (this.state.contentCursor);

    const unread = await this.collectState(provider, "read");
    const starred = await this.collectState(provider, "starred");
    await this.change((state) => {
      for (const article of Object.values(state.articles)) {
        article.read = !unread.has(article.id);
        article.starred = starred.has(article.id);
      }
      for (const op of state.operations) {
        if (op.kind === "article-state" && state.articles[op.articleId]) state.articles[op.articleId][op.field] = op.value;
      }
      state.lastSuccess = Date.now();
      this.pruneArticles(state);
    });
  }

  private async collectState(provider: SyncProvider, field: "read" | "starred"): Promise<Set<string>> {
    const ids = new Set<string>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await provider.getStateIds(field, cursor);
      for (const id of page.ids) ids.add(id);
      cursor = page.cursor;
      if (cursor && seen.has(cursor)) throw new SyncError("Server repeated a pagination cursor", "invalid");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return ids;
  }
}
