import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, WorkspaceLeaf } from "obsidian";
import { SyncView } from "../../../src/views/sync-view";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

describe("Legacy FreshRSS workspace view", () => {
  beforeEach(() => { installObsidianDomPolyfills(); });
  afterEach(() => { document.body.empty(); });
  it("redirects into the existing dashboard instead of maintaining a separate reader", async () => {
    const app = App.createMock() as unknown as App;
    const host = { app, openSyncView: vi.fn(() => Promise.resolve()), openSyncSettings: () => {}, saveSyncArticle: () => Promise.resolve() };
    const leaf = new WorkspaceLeaf(app);
    leaf.detach = vi.fn();
    const view = new SyncView(leaf, host);
    await view.onOpen();
    expect(host.openSyncView).toHaveBeenCalledOnce();
    expect(leaf.detach).toHaveBeenCalledOnce();
  });
});