import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../../../src/views/reader-view";
import {
  FeedItem,
  RssDashboardSettings,
  DEFAULT_SETTINGS,
} from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import { RESTRICTED_ARTICLE_REASON } from "../../../src/utils/full-article-fetch";

const fetchFullArticleContentWithOutcomeMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/utils/full-article-fetch", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/utils/full-article-fetch")
  >("../../../src/utils/full-article-fetch");

  return {
    ...actual,
    fetchFullArticleContentWithOutcome: fetchFullArticleContentWithOutcomeMock,
  };
});

installObsidianDomPolyfills();

class MockLeaf {
  app: unknown;
  constructor(app: unknown) {
    this.app = app;
  }
  detach = vi.fn();
}

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    title: "Test Article Title",
    link: "https://example.com/article-1",
    description: "<p>Short excerpt summary.</p>",
    content: "",
    pubDate: new Date().toISOString(),
    guid: "guid-readability-test-1",
    read: false,
    starred: false,
    tags: [],
    feedTitle: "Feed Title",
    feedUrl: "https://example.com/rss.xml",
    coverImage: "",
    mediaType: "article",
    saved: false,
    ...overrides,
  };
}

describe("ReaderView load full text with Readability", () => {
  let readerView: ReaderView;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";

    const mockApp = {
      workspace: {
        getLeavesOfType: vi.fn().mockReturnValue([]),
        setActiveLeaf: vi.fn(),
        revealLeaf: vi.fn(),
      },
      vault: {
        getAbstractFileByPath: vi.fn(),
      },
    };

    readerView = new ReaderView(
      new MockLeaf(mockApp) as never,
      { ...DEFAULT_SETTINGS, useWebViewer: false, corsProxyEnabled: false } as RssDashboardSettings,
      {
        saveArticle: vi.fn(),
        checkSavedFileExists: vi.fn().mockReturnValue(true),
      } as never,
      vi.fn(),
      vi.fn(),
    );

    (readerView as unknown as { contentEl: HTMLElement }).contentEl =
      document.createElement("div");
  });

  it("renders a full-text button in the toolbar with appropriate title", async () => {
    fetchFullArticleContentWithOutcomeMock.mockResolvedValue({
      content: "",
      failureType: "restricted",
    });

    const item = makeItem();
    await readerView.onOpen();
    await readerView.displayItem(item);

    const contentEl = (readerView as unknown as { contentEl: HTMLElement })
      .contentEl;
    const fullTextButton = contentEl.querySelector(
      ".rss-reader-fulltext-button",
    );
    expect(fullTextButton).not.toBeNull();
    expect(fullTextButton?.getAttribute("title")).toBe("Load full article");
    expect(fullTextButton?.classList.contains("is-loaded")).toBe(false);
  });

  it("includes a load full text button in the restricted paywall banner", async () => {
    fetchFullArticleContentWithOutcomeMock.mockResolvedValue({
      content: "",
      failureType: "restricted",
    });

    const item = makeItem();
    await readerView.onOpen();
    await readerView.displayItem(item);

    const readingContainer = (
      readerView as unknown as { readingContainer: HTMLElement }
    ).readingContainer;
    const banner = readingContainer.querySelector(".rss-reader-paywall-banner");
    expect(banner).not.toBeNull();

    const loadBtn = banner?.querySelector(".rss-reader-load-fulltext-btn");
    expect(loadBtn).not.toBeNull();
    expect(loadBtn?.textContent).toBe("Load full text");
  });

  it("renders an excerpt banner when full article was not fetched and feed only has summary", async () => {
    fetchFullArticleContentWithOutcomeMock.mockResolvedValue({
      content: "",
      failureType: "none",
    });

    const item = makeItem({
      description: "<p>Only an excerpt.</p>",
      content: "",
    });

    await readerView.onOpen();
    await readerView.displayItem(item);

    const readingContainer = (
      readerView as unknown as { readingContainer: HTMLElement }
    ).readingContainer;
    const excerptBanner = readingContainer.querySelector(
      ".rss-reader-excerpt-banner",
    );
    expect(excerptBanner).not.toBeNull();
    expect(excerptBanner?.textContent).toContain("Showing feed summary");

    const loadBtn = excerptBanner?.querySelector(".rss-reader-load-fulltext-btn");
    expect(loadBtn).not.toBeNull();
    expect(loadBtn?.textContent).toBe("Load full text");
  });

  it("loads full article and updates view when clicking load full text button in banner", async () => {
    // Initial fetch fails / is restricted
    fetchFullArticleContentWithOutcomeMock.mockResolvedValueOnce({
      content: "",
      failureType: "restricted",
    });

    const item = makeItem();
    await readerView.onOpen();
    await readerView.displayItem(item);

    expect(item.restrictedReason).toBe(RESTRICTED_ARTICLE_REASON);

    const readingContainer = (
      readerView as unknown as { readingContainer: HTMLElement }
    ).readingContainer;
    const banner = readingContainer.querySelector(".rss-reader-paywall-banner");
    const loadBtn = banner?.querySelector(
      ".rss-reader-load-fulltext-btn",
    ) as HTMLElement;
    expect(loadBtn).not.toBeNull();

    // Now mock second call (on-demand click) returning full article content
    const fullArticleHtml =
      "<p>" + "This is the full article content extracted by Readability. ".repeat(10) + "</p>";
    fetchFullArticleContentWithOutcomeMock.mockResolvedValueOnce({
      content: fullArticleHtml,
      failureType: "none",
    });

    // Click the button
    loadBtn.click();

    // Allow async loadFullArticle to resolve
    await vi.waitFor(() => {
      const content = readingContainer.querySelector(
        ".rss-reader-article-content",
      );
      expect(content?.textContent).toContain(
        "This is the full article content extracted by Readability",
      );
    });

    // The restricted banner should now be removed
    expect(readingContainer.querySelector(".rss-reader-paywall-banner")).toBeNull();
    expect(item.restrictedReason).toBeUndefined();

    // Toolbar button should now show is-loaded
    const contentEl = (readerView as unknown as { contentEl: HTMLElement })
      .contentEl;
    const fullTextButton = contentEl.querySelector(
      ".rss-reader-fulltext-button",
    );
    expect(fullTextButton?.classList.contains("is-loaded")).toBe(true);
    expect(fullTextButton?.getAttribute("title")).toBe("Reload full article");
  });

  it("loads full article when clicking toolbar full-text button", async () => {
    fetchFullArticleContentWithOutcomeMock.mockResolvedValueOnce({
      content: "",
      failureType: "none",
    });

    const item = makeItem();
    await readerView.onOpen();
    await readerView.displayItem(item);

    const contentEl = (readerView as unknown as { contentEl: HTMLElement })
      .contentEl;
    const fullTextButton = contentEl.querySelector(
      ".rss-reader-fulltext-button",
    ) as HTMLElement;
    expect(fullTextButton).not.toBeNull();

    const fullArticleHtml =
      "<p>" + "Loaded via toolbar full article button. ".repeat(10) + "</p>";
    fetchFullArticleContentWithOutcomeMock.mockResolvedValueOnce({
      content: fullArticleHtml,
      failureType: "none",
    });

    fullTextButton.click();

    const readingContainer = (
      readerView as unknown as { readingContainer: HTMLElement }
    ).readingContainer;

    await vi.waitFor(() => {
      const content = readingContainer.querySelector(
        ".rss-reader-article-content",
      );
      expect(content?.textContent).toContain(
        "Loaded via toolbar full article button",
      );
    });

    expect(fullTextButton.classList.contains("is-loaded")).toBe(true);
  });

  it("preserves existing content when loadFullArticle fails", async () => {
    fetchFullArticleContentWithOutcomeMock.mockResolvedValueOnce({
      content: "",
      failureType: "none",
    });

    const item = makeItem({ description: "<p>Original excerpt preserved.</p>" });
    await readerView.onOpen();
    await readerView.displayItem(item);

    const readingContainer = (
      readerView as unknown as { readingContainer: HTMLElement }
    ).readingContainer;
    expect(readingContainer.textContent).toContain("Original excerpt preserved.");

    // Next call fails
    fetchFullArticleContentWithOutcomeMock.mockResolvedValueOnce({
      content: "",
      failureType: "network",
    });

    const contentEl = (readerView as unknown as { contentEl: HTMLElement })
      .contentEl;
    const fullTextButton = contentEl.querySelector(
      ".rss-reader-fulltext-button",
    ) as HTMLElement;

    fullTextButton.click();

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(readingContainer.textContent).toContain("Original excerpt preserved.");
    expect(fullTextButton.classList.contains("is-loaded")).toBe(false);
  });
});
