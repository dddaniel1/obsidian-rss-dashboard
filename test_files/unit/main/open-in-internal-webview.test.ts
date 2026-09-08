import { beforeEach, describe, expect, it, vi } from "vitest";
import RssDashboardPlugin from "../../../main";
import { App, type PluginManifest, type WorkspaceLeaf } from "obsidian";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

installObsidianDomPolyfills();

class MockWorkspaceLeaf {
  app: unknown;
  updateHeader = vi.fn();
  detach = vi.fn();
  setViewState = vi.fn().mockResolvedValue(undefined);

  constructor(app: unknown) {
    this.app = app;
  }
}

interface TestWorkspace {
  getLeaf: ReturnType<typeof vi.fn>;
  revealLeaf: ReturnType<typeof vi.fn>;
  setActiveLeaf: ReturnType<typeof vi.fn>;
}

interface TestApp extends App {
  workspace: TestWorkspace;
  viewRegistry?: {
    getViewCreatorByType?: ReturnType<typeof vi.fn>;
  };
}

function createManifest(): PluginManifest {
  return {
    id: "rss-dashboard",
    name: "RSS Dashboard",
    version: "1.0.0",
    dir: ".",
  } as PluginManifest;
}

describe("RssDashboardPlugin.openInInternalWebView()", () => {
  let mockLeaf: MockWorkspaceLeaf;
  let mockWorkspace: TestWorkspace;
  let app: TestApp;
  let plugin: RssDashboardPlugin;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockLeaf = new MockWorkspaceLeaf({});
    mockWorkspace = {
      getLeaf: vi.fn().mockReturnValue(mockLeaf),
      revealLeaf: vi.fn().mockResolvedValue(undefined),
      setActiveLeaf: vi.fn(),
    };

    app = (App as unknown as { createMock: () => TestApp }).createMock();
    app.workspace = mockWorkspace;
    app.viewRegistry = {
      getViewCreatorByType: vi.fn().mockImplementation((type: string) => {
        if (type === "browser") return () => ({});
        return null;
      }),
    };

    plugin = new RssDashboardPlugin(app, createManifest());
    plugin.settings = {
      openInBrowserTarget: "internal",
    } as unknown as typeof plugin.settings;
  });

  it("opens Obsidian core browser view when browser view type is available", async () => {
    const result = await plugin.openInInternalWebView(
      "https://example.com/test",
      "Test Title",
    );

    expect(result).toBe(mockLeaf);
    expect(mockWorkspace.getLeaf).toHaveBeenCalledWith("tab");
    expect(mockLeaf.setViewState).toHaveBeenCalledWith({
      type: "browser",
      active: true,
      state: {
        url: "https://example.com/test",
        title: "Test Title",
        navigate: true,
      },
    });
    expect(mockWorkspace.revealLeaf).toHaveBeenCalledWith(mockLeaf);
    expect(mockWorkspace.setActiveLeaf).toHaveBeenCalledWith(mockLeaf, {
      focus: true,
    });
  });

  it("falls back to external browser when Obsidian browser view is not available", async () => {
    app.viewRegistry = {
      getViewCreatorByType: vi.fn().mockReturnValue(null),
    };

    const openSpy = vi.fn();
    (activeWindow as unknown as { open: (url: string, target?: string) => void }).open = openSpy;

    const result = await plugin.openInInternalWebView(
      "https://example.com/external-fallback",
      "Fallback",
    );

    expect(result).toBeNull();
    expect(openSpy).toHaveBeenCalledWith("https://example.com/external-fallback", "_blank");
  });

  it("routes through openExternalUrl according to openInBrowserTarget setting", () => {
    const internalSpy = vi.spyOn(plugin, "openInInternalWebView").mockResolvedValue(mockLeaf as unknown as WorkspaceLeaf);
    const openSpy = vi.fn();
    (activeWindow as unknown as { open: (url: string, target?: string) => void }).open = openSpy;

    plugin.settings.openInBrowserTarget = "internal";
    plugin.openExternalUrl("https://example.com/1", "Title 1");
    expect(internalSpy).toHaveBeenCalledWith("https://example.com/1", "Title 1");

    plugin.settings.openInBrowserTarget = "external";
    plugin.openExternalUrl("https://example.com/2", "Title 2");
    expect(openSpy).toHaveBeenCalledWith("https://example.com/2", "_blank");
  });
});
