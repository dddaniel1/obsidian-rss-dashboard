import { describe, expect, it } from "vitest";
import { DashboardSyncSource } from "../../../../src/services/sync/dashboard-sync-source";
import { SyncService, emptySyncState } from "../../../../src/services/sync/sync-service";
import { SyncRuntime } from "../../../../src/services/sync/sync-runtime";
import { DEFAULT_SETTINGS } from "../../../../src/types/types";
import type RssDashboardPlugin from "../../../../main";

function setup() {
  const state = emptySyncState("account");
  state.folders = [{ id: "user/-/label/科技", name: "科技" }];
  state.subscriptions = [{ id: "feed/1", title: "Remote", url: "https://same.example/rss", folder: state.folders[0].id, iconUrl: "https://icons.example/feed.png" }];
  state.articles["1"] = { id: "1", feedId: "feed/1", title: "Remote article", content: "body <img src=\"https://img.example/photo.jpg\">", link: "", published: 1, read: false, starred: false, author: "" };
  state.articles["2"] = { id: "2", feedId: "feed/1", title: "Remote episode", content: "shownotes", link: "", published: 2, read: false, starred: false, author: "", audioUrl: "https://audio.example/episode.mp3" };
  state.articles["3"] = { id: "3", feedId: "feed/1", title: "Remote video", content: "description", link: "", published: 3, read: false, starred: false, author: "", videoUrl: "https://media.example/video.mp4" };
  state.articles["4"] = { id: "4", feedId: "feed/1", title: "Remote YouTube video", content: "description", link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", published: 4, read: false, starred: false, author: "" };
  const runtime = new SyncRuntime({ exists: () => Promise.resolve(false), read: () => Promise.resolve(""), write: () => Promise.resolve() }, "test", () => Promise.resolve({ status: 200, text: "" }));
  runtime.service = new SyncService(state, () => Promise.resolve());
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.feeds = [{ title: "Local", url: "https://same.example/rss", folder: "Local", items: [], lastUpdated: 0 }];
  const host = { settings, syncRuntime: runtime } as unknown as RssDashboardPlugin;
  return { source: new DashboardSyncSource(host, runtime), runtime, host };
}
describe("Dashboard sync source", () => {
  it("projects remote data into existing dashboard types without changing local subscriptions", () => {
    const { source, host } = setup();
    expect(source.settings.feeds[0].title).toBe("Remote");
    expect(source.settings.folders[0].name).toBe("科技");
    expect(source.settings.feeds[0].items[0].guid).toBe("freshrss:account:1");
    source.settings.feeds[0].title = "Changed";
    expect(host.settings.feeds[0].title).toBe("Local");
  });

  it("marks articles with media enclosures as podcast or video items", () => {
    const { source } = setup();
    const article = source.settings.feeds[0].items.find((item) => item.guid === "freshrss:account:1");
    const episode = source.settings.feeds[0].items.find((item) => item.guid === "freshrss:account:2");
    const video = source.settings.feeds[0].items.find((item) => item.guid === "freshrss:account:3");
    expect(article?.mediaType).toBe("article");
    expect(episode?.mediaType).toBe("podcast");
    expect(episode?.audioUrl).toBe("https://audio.example/episode.mp3");
    expect(video?.mediaType).toBe("video");
    expect(video?.videoUrl).toBe("https://media.example/video.mp4");
  });

  it("marks articles with YouTube links as video items", () => {
    const { source } = setup();
    const video = source.settings.feeds[0].items.find((item) => item.guid === "freshrss:account:4");
    expect(video?.mediaType).toBe("video");
    expect(video?.videoId).toBe("dQw4w9WgXcQ");
  });

  it("derives article cover images from content and passes through feed icons", () => {
    const { source } = setup();
    const feed = source.settings.feeds[0];
    expect(feed.iconUrl).toBe("https://icons.example/feed.png");
    const article = feed.items.find((item) => item.guid === "freshrss:account:1");
    expect(article?.coverImage).toBe("https://img.example/photo.jpg");
  });

  it("treats previously synced articles without enclosures as plain articles", () => {
    const { source } = setup();
    // Simulate a pre-fix snapshot: the podcast episode was stored as an article.
    const state = source.runtime.service!.snapshot();
    state.articles["2"].audioUrl = undefined;
    state.articles["3"].videoUrl = undefined;
    const runtime = source.runtime;
    (runtime as unknown as { service: SyncService }).service = new SyncService(state, () => Promise.resolve());
    source.refresh();
    const episode = source.settings.feeds[0].items.find((item) => item.guid === "freshrss:account:2");
    const video = source.settings.feeds[0].items.find((item) => item.guid === "freshrss:account:3");
    expect(episode?.mediaType).toBe("article");
    expect(video?.mediaType).toBe("article");
  });
  it("routes existing article and bulk mutations to the remote outbox", async () => {
    const { source, runtime } = setup();
    source.settings.feeds[0].items[0].read = true;
    source.settings.feeds[0].items[0].starred = true;
    await source.persist();
    expect(runtime.service!.snapshot().operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "article-state", articleId: "1", field: "read", value: true }),
      expect.objectContaining({ kind: "article-state", articleId: "1", field: "starred", value: true }),
    ]));
  });
  it("turns a sidebar rename into a remote folder rename", async () => {
    const { source, runtime } = setup();
    source.settings.folders[0].name = "技术";
    source.settings.feeds[0].folder = "技术";
    await source.persist();
    expect(runtime.service!.snapshot().operations).toContainEqual(expect.objectContaining({ kind: "rename-folder", folder: "user/-/label/科技", name: "技术" }));
  });
});
