import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSyncSettingsTab, type SyncSettingsHost } from "../../../src/settings/tabs/sync-settings-tab";
import { SyncRuntime } from "../../../src/services/sync/sync-runtime";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

describe("renderSyncSettingsTab", () => {
  beforeEach(() => installObsidianDomPolyfills());
  afterEach(() => {
    document.body.empty();
    vi.restoreAllMocks();
  });

  it("renders a fallback message when syncRuntime is absent", () => {
    const container = document.body.createDiv();
    const host: SyncSettingsHost = {
      openSyncView: vi.fn(() => Promise.resolve()),
    };
    renderSyncSettingsTab(container, host);
    expect(container.textContent).toContain("Sync could not initialize");
  });

  it("renders default library setting and updates settings on change", async () => {
    const container = document.body.createDiv();
    const runtime = new SyncRuntime(
      { exists: () => Promise.resolve(false), read: () => Promise.resolve(""), write: () => Promise.resolve() },
      "test",
      () => Promise.resolve({ status: 200, text: "" }),
    );
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.defaultLibrarySource = "local";
    const host: SyncSettingsHost = {
      settings,
      syncRuntime: runtime,
      openSyncView: vi.fn(() => Promise.resolve()),
      saveSettings: vi.fn(() => Promise.resolve()),
    };

    const cleanup = renderSyncSettingsTab(container, host);
    expect(container.textContent).toContain("Default library");

    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    expect(select?.value).toBe("local");

    select!.value = "freshrss";
    select!.dispatchEvent(new Event("change"));
    await Promise.resolve();

    expect(settings.defaultLibrarySource).toBe("freshrss");
    expect(host.saveSettings).toHaveBeenCalled();

    cleanup();
    runtime.stop();
  });
});
