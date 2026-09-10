import type { SyncOperation } from "./sync-outbox";
import {
  SyncError,
  type SyncProvider,
  type SyncTransport,
  type RemoteFolder,
  type RemoteSubscription,
  type ArticlePage,
  type ArticleQuery,
} from "./sync-provider";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyncError("Invalid server response", "invalid");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new SyncError("Invalid server response", "invalid");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new SyncError("Invalid server response", "invalid");
  return value;
}
function optionalString(value: unknown): string {
  return value === undefined ? "" : string(value);
}
function cursor(value: unknown): string | undefined {
  return value === undefined ? undefined : string(value);
}
export function normalizeArticleId(value: string): string {
  const prefix = "tag:google.com,2005:reader/item/";
  const raw = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  if (value.startsWith(prefix) && /^[0-9a-f]+$/i.test(raw)) return BigInt("0x" + raw).toString();
  if (/^[0-9]+$/.test(raw)) return BigInt(raw).toString();
  throw new SyncError("Invalid article ID", "invalid");
}
const LABEL = "user/-/label/";
const STATE = "user/-/state/com.google/";

export class FreshRssProvider implements SyncProvider {
  private readonly endpoint: string;
  private auth = "";
  private token = "";

  constructor(endpoint: string, private readonly transport: SyncTransport) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash) throw new SyncError("Use an API address without credentials, query or fragment", "invalid");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw new SyncError("Use HTTPS for the sync server", "invalid");
    }
    this.endpoint = url.toString().replace(/\/+$/, "");
  }

  getSession(): string { return this.auth; }

  restoreSession(auth: string): void {
    this.auth = auth;
    this.token = "";
  }

  async login(username: string, password: string): Promise<void> {
    this.auth = "";
    this.token = "";
    const response = await this.send("/accounts/ClientLogin", new URLSearchParams({ Email: username, Passwd: password }));
    const auth = response.split(/\r?\n/).find((line) => line.startsWith("Auth="))?.slice(5);
    if (!auth) throw new SyncError("Invalid authentication response", "invalid");
    this.auth = auth;
  }

  private async send(path: string, body?: URLSearchParams): Promise<string> {
    let response: { status: number; text: string };
    try {
      response = await this.transport({
        url: this.endpoint + path,
        method: body ? "POST" : "GET",
        headers: {
          ...(this.auth ? { Authorization: "GoogleLogin auth=" + this.auth } : {}),
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(body ? { body: body.toString() } : {}),
      });
    } catch {
      throw new SyncError("Network request failed", "network", true);
    }
    if (response.status === 401 || response.status === 403) {
      this.auth = "";
      this.token = "";
      throw new SyncError("Authentication failed. Check the API credentials.", "auth");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SyncError("Sync server returned HTTP " + response.status, "server", response.status === 429 || response.status >= 500);
    }
    return response.text;
  }

  private async json(path: string): Promise<Record<string, unknown>> {
    const text = await this.send("/reader/api/0/" + path);
    try {
      return object(JSON.parse(text) as unknown);
    } catch {
      throw new SyncError("Invalid server response", "invalid");
    }
  }

  async getFolders(): Promise<RemoteFolder[]> {
    const data = await this.json("tag/list?output=json");
    return array(data.tags).map(object).flatMap((tag) => {
      const id = string(tag.id);
      if (!id.startsWith(LABEL)) return [];
      return { id, name: id.slice(LABEL.length) };
    });
  }

  async getSubscriptions(): Promise<RemoteSubscription[]> {
    const data = await this.json("subscription/list?output=json");
    return array(data.subscriptions).map((value) => {
      const feed = object(value);
      const categories = array(feed.categories).map(object);
      return { id: string(feed.id), title: string(feed.title), url: string(feed.url), folder: categories.length ? string(categories[0].id) : "" };
    });
  }

  async getArticles(query: ArticleQuery): Promise<ArticlePage> {
    const params = new URLSearchParams({ output: "json", n: "100", s: query.stream ?? STATE + "reading-list" });
    if (query.cursor) params.set("c", query.cursor);
    if (query.since !== undefined) params.set("ot", String(query.since));
    const data = await this.json("stream/contents?" + params.toString());
    const articles = array(data.items).map((value) => {
      const article = object(value);
      const states = array(article.categories).map(string);
      const origin = object(article.origin);
      const content = article.summary === undefined ? "" : optionalString(object(article.summary).content);
      const alternate = article.alternate === undefined ? [] : array(article.alternate);
      const enclosures = article.enclosure === undefined ? [] : array(article.enclosure).map(object);
      const enclosureUrl = (kind: "audio/" | "video/"): string | undefined => {
        for (const item of enclosures) {
          if (item.href === undefined) continue;
          if (optionalString(item.type).startsWith(kind)) return string(item.href);
        }
        return undefined;
      };
      const audioUrl = enclosureUrl("audio/");
      const videoUrl = enclosureUrl("video/");
      const published = article.published;
      if (typeof published !== "number" || !Number.isFinite(published)) throw new SyncError("Invalid article date", "invalid");
      return {
        id: normalizeArticleId(string(article.id)), feedId: string(origin.streamId),
        title: optionalString(article.title), link: alternate.length ? string(object(alternate[0]).href) : "",
        content, published, read: states.includes(STATE + "read"), starred: states.includes(STATE + "starred"),
        author: optionalString(article.author),
        audioUrl,
        videoUrl,
      };
    });
    return { articles, cursor: cursor(data.continuation) };
  }

  async getStateIds(field: "read" | "starred", pageCursor?: string): Promise<{ ids: string[]; cursor?: string }> {
    const params = new URLSearchParams({ output: "json", n: "1000", s: STATE + (field === "read" ? "reading-list" : "starred") });
    // Fetch unread IDs, including old articles whose state changed since last content pull.
    if (field === "read") params.set("xt", STATE + "read");
    if (pageCursor) params.set("c", pageCursor);
    const data = await this.json("stream/items/ids?" + params.toString());
    return { ids: array(data.itemRefs).map((value) => normalizeArticleId(string(object(value).id))), cursor: cursor(data.continuation) };
  }

  async execute(operation: SyncOperation): Promise<void> {
    if (!this.token) this.token = (await this.send("/reader/api/0/token")).trim();
    const params = new URLSearchParams({ T: this.token });
    let route: string;
    switch (operation.kind) {
      case "article-state":
        route = "edit-tag";
        params.set("i", operation.articleId);
        params.set(operation.value ? "a" : "r", STATE + operation.field);
        break;
      case "subscribe":
        route = "subscription/edit";
        params.set("ac", "subscribe");
        params.set("s", "feed/" + operation.url);
        params.set("t", operation.title);
        if (operation.folder) params.set("a", operation.folder);
        break;
      case "unsubscribe":
        route = "subscription/edit";
        params.set("ac", "unsubscribe");
        params.set("s", operation.feedId);
        break;
      case "edit-feed":
        route = "subscription/edit";
        params.set("ac", "edit");
        params.set("s", operation.feedId);
        params.set("t", operation.title);
        params.set("a", operation.folder || LABEL);
        break;
      case "rename-folder":
        route = "rename-tag";
        params.set("s", operation.folder);
        params.set("dest", LABEL + operation.name);
        break;
      case "delete-folder":
        route = "disable-tag";
        params.set("s", operation.folder);
        break;
    }
    if ((await this.send("/reader/api/0/" + route, params)).trim() !== "OK") {
      throw new SyncError("Sync server did not confirm the change", "invalid");
    }
  }
}


