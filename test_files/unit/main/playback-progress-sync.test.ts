import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { App, PluginManifest } from "obsidian";
import { DEFAULT_SETTINGS, type FeedItem } from "../../../src/types/types";
import { SyncRuntime } from "../../../src/services/sync/sync-runtime";
import { SyncService, emptySyncState } from "../../../src/services/sync/sync-service";

// Module mocks for main.ts
vi.mock("../../../src/services/feed-parser", () => ({
  FeedParser: class FeedParser {
    constructor(_media?: any, _availableTags?: any) {}
    parseFeed = vi.fn();
    refreshAllFeeds = vi.fn();
  },
  applyFeedRetentionLimits: vi.fn((feed: unknown) => feed),
  formatFeedParseNoticeMessage: vi.fn((e: Error) => e.message),
  getFeedErrorMessage: vi.fn((e: Error) => e.message),
}));

vi.mock("../../../src/services/article-saver", () => ({
  ArticleSaver: class ArticleSaver {
    constructor(_app?: any, _settings?: any) {}
    fixSavedFilePaths = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("../../../src/utils/settings-migration", () => ({
  migrateDisplaySettings: vi.fn(),
  migrateDefaultFilterToDashboardMultiFilters: vi.fn(),
  migrateKeywordRulesSettings: vi.fn().mockReturnValue(false),
  migrateMediaVideoTagSettings: vi.fn().mockReturnValue(false),
  migrateMediaDefaultTagArrays: vi.fn().mockReturnValue(false),
}));

import RssDashboardPlugin from "../../../main";

const MANIFEST = {
  id: "rss-dashboard",
  name: "RSS Dashboard",
  version: "1.0.0",
  author: "Test",
  description: "Test",
  dir: ".",
} as unknown as PluginManifest;

describe("updatePlaybackProgress with FreshRSS sync", () => {
  let app: App;
  let plugin: RssDashboardPlugin;
  let runtime: SyncRuntime;
  let syncService: SyncService;

  beforeEach(() => {
    vi.useFakeTimers();
    app = new App();
    plugin = new RssDashboardPlugin(app, MANIFEST);
    plugin.settings = structuredClone(DEFAULT_SETTINGS);
    plugin.settings.media.rememberPlaybackProgress = true;

    const state = emptySyncState("account-123");
    state.articles["article-1"] = {
      id: "article-1",
      feedId: "feed-1",
      title: "Episode 1",
      content: "desc",
      link: "https://example.com/ep1",
      published: 1000,
      read: false,
      starred: false,
      author: "Host",
      audioUrl: "https://example.com/ep1.mp3",
    };

    syncService = new SyncService(state, () => Promise.resolve());
    runtime = new SyncRuntime(
      { exists: () => Promise.resolve(false), read: () => Promise.resolve(""), write: () => Promise.resolve() },
      "test",
      () => Promise.resolve({ status: 200, text: "" }),
    );
    runtime.service = syncService;
    plugin.syncRuntime = runtime;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not call runtime.perform or notify sync subscribers during active playback", async () => {
    const subscriber = vi.fn();
    runtime.subscribe(subscriber);
    const performSpy = vi.spyOn(runtime, "perform");
    const updateLocalSpy = vi.spyOn(syncService, "updateLocalArticle");

    const guid = "freshrss:account-123:article-1";
    const sourceItem = {
      guid,
      title: "Episode 1",
      link: "https://example.com/ep1",
      description: "desc",
      pubDate: "2026-03-01T00:00:00Z",
      read: false,
      starred: false,
      tags: [],
      feedTitle: "Podcast Feed",
      feedUrl: "https://example.com/feed.xml",
      coverImage: "",
    } as unknown as FeedItem;

    // Simulate 1s interval ticks during active playback (flush = false)
    plugin.updatePlaybackProgress("https://example.com/feed.xml", guid, 15, 300, false, sourceItem);
    plugin.updatePlaybackProgress("https://example.com/feed.xml", guid, 16, 300, false, sourceItem);
    plugin.updatePlaybackProgress("https://example.com/feed.xml", guid, 17, 300, false, sourceItem);

    // CRITICAL: runtime.perform must NOT be called, and subscriber must NOT be notified
    // (subscriber notification triggers DashboardView.refresh() -> articleList destruction/recreation -> flickering)
    expect(performSpy).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();

    // In-memory progress on sourceItem must be updated immediately
    expect(sourceItem.playbackProgress).toEqual(
      expect.objectContaining({ position: 17, duration: 300 }),
    );

    // Persistence to updateLocalArticle should be throttled (not yet called 3 times)
    expect(updateLocalSpy).not.toHaveBeenCalled();

    // After throttle delay (2000ms), updateLocalArticle is called once with latest progress
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateLocalSpy).toHaveBeenCalledTimes(1);
    expect(updateLocalSpy).toHaveBeenCalledWith("article-1", {
      playbackProgress: expect.objectContaining({ position: 17, duration: 300 }),
    });
    expect(syncService.snapshot().articles["article-1"]?.playbackProgress).toEqual(
      expect.objectContaining({ position: 17, duration: 300 }),
    );
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("immediately flushes progress on pause without notifying sync subscribers", () => {
    const subscriber = vi.fn();
    runtime.subscribe(subscriber);
    const performSpy = vi.spyOn(runtime, "perform");
    const updateLocalSpy = vi.spyOn(syncService, "updateLocalArticle");

    const guid = "freshrss:account-123:article-1";
    plugin.updatePlaybackProgress("https://example.com/feed.xml", guid, 42, 300, true);

    expect(performSpy).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
    expect(updateLocalSpy).toHaveBeenCalledTimes(1);
    expect(updateLocalSpy).toHaveBeenCalledWith("article-1", {
      playbackProgress: expect.objectContaining({ position: 42, duration: 300 }),
    });
  });

  it("flushes pending progress for the previous episode when switching to a different episode", async () => {
    const state = syncService.snapshot();
    state.articles["article-2"] = {
      id: "article-2",
      feedId: "feed-1",
      title: "Episode 2",
      content: "desc",
      link: "https://example.com/ep2",
      published: 2000,
      read: false,
      starred: false,
      author: "Host",
      audioUrl: "https://example.com/ep2.mp3",
    };

    const updateLocalSpy = vi.spyOn(syncService, "updateLocalArticle");

    // Progress on episode 1 (not flushed)
    plugin.updatePlaybackProgress(
      "https://example.com/feed.xml",
      "freshrss:account-123:article-1",
      100,
      300,
      false,
    );

    // Switch to episode 2 (not flushed)
    plugin.updatePlaybackProgress(
      "https://example.com/feed.xml",
      "freshrss:account-123:article-2",
      5,
      200,
      false,
    );

    // Episode 1's pending progress should have been flushed immediately upon switching
    expect(updateLocalSpy).toHaveBeenCalledWith("article-1", {
      playbackProgress: expect.objectContaining({ position: 100, duration: 300 }),
    });

    // Advance timers for episode 2
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateLocalSpy).toHaveBeenCalledWith("article-2", {
      playbackProgress: expect.objectContaining({ position: 5, duration: 200 }),
    });
  });

  it("flushes pending remote progress when plugin is unloaded", () => {
    const updateLocalSpy = vi.spyOn(syncService, "updateLocalArticle");

    plugin.updatePlaybackProgress(
      "https://example.com/feed.xml",
      "freshrss:account-123:article-1",
      88,
      300,
      false,
    );

    expect(updateLocalSpy).not.toHaveBeenCalled();

    plugin.onunload();

    expect(updateLocalSpy).toHaveBeenCalledWith("article-1", {
      playbackProgress: expect.objectContaining({ position: 88, duration: 300 }),
    });
  });

  it("clears playback progress from remote articles in clearPlaybackProgress", async () => {
    await syncService.updateLocalArticle("article-1", {
      playbackProgress: {
        position: 50,
        duration: 300,
        lastUpdated: Date.now(),
      },
    });

    const updateLocalSpy = vi.spyOn(syncService, "updateLocalArticle");
    const count = await plugin.clearPlaybackProgress();

    expect(count).toBe(1);
    expect(syncService.snapshot().articles["article-1"]?.playbackProgress).toBeUndefined();
    expect(updateLocalSpy).toHaveBeenCalledWith("article-1", {
      playbackProgress: undefined,
    });
  });
});
