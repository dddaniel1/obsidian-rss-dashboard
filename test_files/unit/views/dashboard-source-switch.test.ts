import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, WorkspaceLeaf } from "obsidian";
import { RssDashboardView } from "../../../src/views/dashboard-view";
import { SyncRuntime } from "../../../src/services/sync/sync-runtime";
import { SyncService, emptySyncState } from "../../../src/services/sync/sync-service";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
import type RssDashboardPlugin from "../../../main";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

describe("Dashboard library source switching", () => {
  beforeEach(() => installObsidianDomPolyfills());
  afterEach(() => { document.body.empty(); vi.restoreAllMocks(); });
  it("uses the same dashboard and restores the untouched local subscriptions", async () => {
    const app = new App();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.feeds = [{ title: "Local", url: "https://same.example/rss", folder: "", items: [], lastUpdated: 0 }];
    const runtime = new SyncRuntime({ exists: () => Promise.resolve(false), read: () => Promise.resolve(""), write: () => Promise.resolve() }, "test", () => Promise.resolve({ status: 200, text: "" }));
    const state = emptySyncState("account");
    state.subscriptions = [{ id: "feed/1", title: "Remote", url: "https://same.example/rss", folder: "" }];
    runtime.service = new SyncService(state, () => Promise.resolve());
    const host = {
      app, settings, syncRuntime: runtime, saveSettings: vi.fn(() => Promise.resolve()),
      activateDiscoverView: vi.fn(), openSettingsToTab: vi.fn(), openTagsSettings: vi.fn(),
    } as unknown as RssDashboardPlugin;
    const view = new RssDashboardView(new WorkspaceLeaf(app), host);
    vi.spyOn(view, "render").mockImplementation(() => {});
    await view.setLibrarySource("freshrss");
    expect(view.getViewType()).toBe("rss-dashboard-view");
    expect(view["settings"].feeds[0].title).toBe("Remote");
    expect(host.settings.feeds[0].title).toBe("Local");
    await view.setLibrarySource("local");
    expect(view["settings"]).toBe(settings);
    expect(view["settings"].feeds[0].title).toBe("Local");
    runtime.stop();
  });
});