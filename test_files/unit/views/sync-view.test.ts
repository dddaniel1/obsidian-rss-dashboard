import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App, WorkspaceLeaf } from "obsidian";
import { SyncView } from "../../../src/views/sync-view";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

describe("FreshRSS library view", () => {
  beforeEach(() => { installObsidianDomPolyfills(); });
  afterEach(() => { document.body.empty(); });
  it("shows a connection entry point without exposing local subscriptions", async () => {
    const app = App.createMock() as unknown as App;
    const host = { app, openSyncView: () => Promise.resolve(), openSyncSettings: () => {}, saveSyncArticle: () => Promise.resolve() };
    const view = new SyncView(new WorkspaceLeaf(app), host);
    await view.onOpen();
    expect(view.containerEl.textContent).toContain("Connect FreshRSS");
    await view.onClose();
  });
});
