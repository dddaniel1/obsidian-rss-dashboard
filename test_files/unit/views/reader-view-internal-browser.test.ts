import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../../../src/views/reader-view";
import { DEFAULT_SETTINGS, FeedItem, RssDashboardSettings } from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

installObsidianDomPolyfills();

class MockLeaf {
  app: unknown;
  view: unknown;

  constructor(app: unknown) {
    this.app = app;
  }

  detach = vi.fn();
  updateHeader = vi.fn();
  setViewState = vi.fn().mockResolvedValue(undefined);
}

type ReaderViewInternals = {
  contentEl: HTMLElement;
  readingContainer: HTMLElement;
};

function getInternals(view: ReaderView): ReaderViewInternals {
  return view as unknown as ReaderViewInternals;
}

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    title: "Sample Article",
    link: "https://example.com/article-1",
    description: '<p>Read more at <a href="https://example.com/source">Source</a></p>',
    content: "",
    pubDate: "2026-04-01T10:00:00.000Z",
    guid: "article-1",
    read: false,
    starred: false,
    tags: [],
    feedTitle: "Tech News",
    feedUrl: "https://example.com/feed.xml",
    coverImage: "",
    mediaType: "article",
    saved: false,
    ...overrides,
  };
}

describe("ReaderView internal browser integration", () => {
  let readerView: ReaderView;
  let mockLeaf: MockLeaf;
  let mockApp: {
    workspace: {
      getLeaf: ReturnType<typeof vi.fn>;
      getLeavesOfType: ReturnType<typeof vi.fn>;
      setActiveLeaf: ReturnType<typeof vi.fn>;
      revealLeaf: ReturnType<typeof vi.fn>;
    };
    vault: {
      getAbstractFileByPath: ReturnType<typeof vi.fn>;
    };
    viewRegistry: {
      getViewCreatorByType: ReturnType<typeof vi.fn>;
    };
  };
  let mockSettings: RssDashboardSettings;
  let createdLeaf: MockLeaf;

  beforeEach(async () => {
    createdLeaf = new MockLeaf({});
    mockApp = {
      workspace: {
        getLeaf: vi.fn().mockReturnValue(createdLeaf),
        getLeavesOfType: vi.fn().mockReturnValue([]),
        setActiveLeaf: vi.fn(),
        revealLeaf: vi.fn().mockResolvedValue(undefined),
      },
      vault: {
        getAbstractFileByPath: vi.fn(),
      },
      viewRegistry: {
        getViewCreatorByType: vi.fn().mockImplementation((type: string) => {
          if (type === "browser") return () => ({});
          return null;
        }),
      },
    };

    mockLeaf = new MockLeaf(mockApp);
    mockSettings = {
      ...DEFAULT_SETTINGS,
      openInBrowserTarget: "internal",
    };

    readerView = new ReaderView(
      mockLeaf as never,
      mockSettings,
      { saveArticle: vi.fn() } as never,
      vi.fn(),
      vi.fn(),
    );

    getInternals(readerView).contentEl = document.createElement("div");
    await readerView.onOpen();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("opens internal webview tab when openInBrowserTarget is internal", async () => {
    const item = makeItem();
    await readerView.displayItem(item);

    const browserButton = getInternals(readerView).contentEl.querySelector(
      '.rss-reader-action-button[title="Open in Obsidian tab"]',
    ) as HTMLElement;
    expect(browserButton).not.toBeNull();

    const openSpy = vi.fn();
    (activeWindow as unknown as { open: (url: string, target?: string) => void }).open = openSpy;

    browserButton.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(openSpy).not.toHaveBeenCalled();
    expect(mockApp.workspace.getLeaf).toHaveBeenCalledWith("tab");
    expect(createdLeaf.setViewState).toHaveBeenCalledWith({
      type: "browser",
      active: true,
      state: {
        url: "https://example.com/article-1",
        title: "Sample Article",
        navigate: true,
      },
    });
    expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(createdLeaf);
    expect(mockApp.workspace.setActiveLeaf).toHaveBeenCalledWith(createdLeaf, {
      focus: true,
    });
  });

  it("opens external browser when openInBrowserTarget is external", async () => {
    const externalSettings = {
      ...DEFAULT_SETTINGS,
      openInBrowserTarget: "external" as const,
    };
    const externalReader = new ReaderView(
      mockLeaf as never,
      externalSettings,
      { saveArticle: vi.fn() } as never,
      vi.fn(),
      vi.fn(),
    );
    getInternals(externalReader).contentEl = document.createElement("div");
    await externalReader.onOpen();

    const item = makeItem();
    await externalReader.displayItem(item);

    const browserButton = getInternals(externalReader).contentEl.querySelector(
      '.rss-reader-action-button[title="Open in browser"]',
    ) as HTMLElement;
    expect(browserButton).not.toBeNull();

    const openSpy = vi.fn();
    (activeWindow as unknown as { open: (url: string, target?: string) => void }).open = openSpy;

    browserButton.click();

    expect(openSpy).toHaveBeenCalledWith("https://example.com/article-1", "_blank");
    expect(mockApp.workspace.getLeaf).not.toHaveBeenCalled();
    await externalReader.onClose();
  });

  it("intercepts external links in article content when openInBrowserTarget is internal", async () => {
    const item = makeItem();
    await readerView.displayItem(item);

    const readingContainer = getInternals(readerView).readingContainer;
    const link = document.createElement("a");
    link.href = "https://example.com/external-target";
    link.textContent = "External target";
    readingContainer.appendChild(link);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(createdLeaf.setViewState).toHaveBeenCalledWith({
      type: "browser",
      active: true,
      state: {
        url: "https://example.com/external-target",
        title: "External target",
        navigate: true,
      },
    });
  });
});
