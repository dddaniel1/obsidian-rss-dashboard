import { describe, expect, it } from "vitest";
import { SyncService, emptySyncState } from "../../../../src/services/sync/sync-service";
import type { SyncProvider } from "../../../../src/services/sync/sync-provider";

function provider(overrides: Partial<SyncProvider> = {}): SyncProvider {
  return {
    login: () => Promise.resolve(),
    getFolders: () => Promise.resolve([{ id: "user/-/label/科技", name: "科技" }]),
    getSubscriptions: () => Promise.resolve([{ id: "feed/1", title: "News", url: "https://example.com/rss", folder: "user/-/label/科技" }]),
    getArticles: () => Promise.resolve({ articles: [{ id: "123", feedId: "feed/1", title: "Article", link: "https://example.com/1", content: "Hello", published: 1, read: false, starred: false, author: "" }] }),
    getStateIds: () => Promise.resolve({ ids: ["123"] }),
    execute: () => Promise.resolve(),
    ...overrides,
  };
}

describe("Sync service", () => {
  it("keeps state and pending changes through restart without touching local article metadata", async () => {
    let durable = emptySyncState("a");
    const service = new SyncService(durable, async (state) => { durable = state; });
    await service.synchronize(provider());
    await service.updateLocalArticle("123", { tags: [{ name: "Local", color: "red" }], saved: true, savedFilePath: "Notes/a.md" });
    await service.setArticleState("123", "read", true);
    const restored = new SyncService(durable, async (state) => { durable = state; });
    expect(restored.snapshot().operations).toHaveLength(1);
    await restored.synchronize(provider({ getStateIds: () => Promise.resolve({ ids: [] }) }));
    expect(restored.snapshot().articles["123"]).toMatchObject({ read: true, starred: false, saved: true, savedFilePath: "Notes/a.md", tags: [{ name: "Local" }] });
  });

  it("does not remove feeds on incomplete remote snapshots", async () => {
    const service = new SyncService(emptySyncState("a"), () => Promise.resolve());
    await service.synchronize(provider());
    await expect(service.synchronize(provider({ getSubscriptions: () => Promise.reject(new Error("offline")) }))).rejects.toThrow();
    expect(service.snapshot().subscriptions).toHaveLength(1);
  });

  it("records a conflict instead of recreating a remotely deleted feed", async () => {
    const service = new SyncService(emptySyncState("a"), () => Promise.resolve());
    await service.synchronize(provider());
    await service.editFeed("feed/1", "Renamed", "user/-/label/科技");
    let writes = 0;
    await service.synchronize(provider({ getSubscriptions: () => Promise.resolve([]), execute: () => { writes++; return Promise.resolve(); }, getArticles: () => Promise.resolve({ articles: [] }) }));
    expect(writes).toBe(0);
    expect(service.snapshot().conflicts).toHaveLength(1);
  });

  it("retains page progress after a later page fails and resumes with the cursor", async () => {
    let durable = emptySyncState("a");
    const service = new SyncService(durable, async (state) => { durable = state; });
    const base = provider();
    await expect(service.synchronize(provider({
      getArticles: (query) => query.cursor ? Promise.reject(new Error("offline")) : base.getArticles(query).then((page) => ({ ...page, cursor: "next" })),
    }))).rejects.toThrow();
    expect(durable.contentCursor).toBe("next");
    let requested: string | undefined;
    const restored = new SyncService(durable, () => Promise.resolve());
    await restored.synchronize(provider({ getArticles: (query) => { requested = query.cursor; return Promise.resolve({ articles: [] }); } }));
    expect(requested).toBe("next");
    expect(restored.snapshot().articles["123"]).toBeDefined();
  });

  it("keeps empty folders local until a feed is added", async () => {
    const service = new SyncService(emptySyncState("a"), () => Promise.resolve());
    await service.createFolder("中文");
    await service.synchronize(provider());
    expect(service.snapshot().folders.find((folder) => folder.name === "中文")).toMatchObject({ pending: true });
  });

  it("re-fetches the full stream once after upgrade so media enclosures backfill", async () => {
    let durable = emptySyncState("a");
    // A pre-enclosure state: incremental sync finished, but audio URLs are absent.
    durable.articles["123"] = { id: "123", feedId: "feed/1", title: "Article", link: "", content: "", published: 1, read: false, starred: false, author: "" };
    durable.contentSince = 1000;
    let requestedSince: number | undefined;
    const service = new SyncService(durable, async (state) => { durable = state; });
    await service.synchronize(provider({
      getArticles: (query) => {
        requestedSince = query.since;
        return Promise.resolve({ articles: [{ id: "123", feedId: "feed/1", title: "Article", link: "https://example.com/1", content: "Hello", published: 1, read: false, starred: false, author: "", audioUrl: "https://audio.example/1.mp3" }] });
      },
    }));
    expect(requestedSince).toBeUndefined();
    expect(durable.articles["123"].audioUrl).toBe("https://audio.example/1.mp3");
    expect(durable.mediaEnclosureBackfill).toBe(true);
    // After the backfill, incremental syncing resumes.
    const expectedSince = durable.contentSince;
    const restored = new SyncService(durable, async (state) => { durable = state; });
    await restored.synchronize(provider({ getArticles: (query) => { requestedSince = query.since; return Promise.resolve({ articles: [] }); } }));
    expect(requestedSince).toBe(expectedSince);
  });
});
