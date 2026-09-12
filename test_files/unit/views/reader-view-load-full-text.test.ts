import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../../../src/views/reader-view";
import {
  FeedItem,
  Feed,
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

function deferredFetch() {
  let resolve!: (value: {
    content: string;
    failureType: "none" | "restricted";
  }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{
    content: string;
    failureType: "none" | "restricted";
  }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fullText = (label: string) =>
  `<p>${`${label} full article content. `.repeat(20)}</p>`;

describe("ReaderView load full text with Readability", () => {
  let readerView: ReaderView;
  let settings: RssDashboardSettings;

  afterEach(() => {
    document.body.empty();
    vi.clearAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fetchFullArticleContentWithOutcomeMock.mockReset();
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

    settings = {
      ...DEFAULT_SETTINGS,
      useWebViewer: false,
      corsProxyEnabled: false,
    } as RssDashboardSettings;

    readerView = new ReaderView(
      new MockLeaf(mockApp) as never,
      settings,
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

  it("opens an article with feed content without fetching full text", async () => {
    // Tripwire: any automatic fetch would render this content and fail the test.
    fetchFullArticleContentWithOutcomeMock.mockResolvedValue({
      content: fullText("Auto"),
      failureType: "none",
    });

    const item = makeItem({
      description: "<p>Feed summary body.</p>",
      content: "",
    });
    await readerView.onOpen();
    await readerView.displayItem(item);

    expect(fetchFullArticleContentWithOutcomeMock).not.toHaveBeenCalled();
    const readingContainer = (
      readerView as unknown as { readingContainer: HTMLElement }
    ).readingContainer;
    expect(
      readingContainer.querySelector(".rss-reader-article-content")
        ?.textContent,
    ).toContain("Feed summary body.");

    const loadBtn = readerView.contentEl.querySelector(
      ".rss-reader-fulltext-button",
    ) as HTMLElement;
    expect(loadBtn).not.toBeNull();

    fetchFullArticleContentWithOutcomeMock.mockResolvedValueOnce({
      content: fullText("Manual"),
      failureType: "none",
    });
    loadBtn.click();
    await vi.waitFor(() => {
      expect(
        readingContainer.querySelector(".rss-reader-article-content")
          ?.textContent,
      ).toContain("Manual full article content");
    });
    expect(fetchFullArticleContentWithOutcomeMock).toHaveBeenCalledTimes(1);
    expect(item.restrictedReason).toBeUndefined();
  });

  it("keeps a single pending request for a manual full-text load", async () => {
    const pending = deferredFetch();
    fetchFullArticleContentWithOutcomeMock.mockReturnValue(pending.promise);
    await readerView.onOpen();
    const displaying = readerView.displayItem(makeItem());
    const manual = readerView.loadFullArticle();
    expect(fetchFullArticleContentWithOutcomeMock).toHaveBeenCalledTimes(1);
    pending.resolve({ content: fullText("Current"), failureType: "none" });
    await Promise.all([displaying, manual]);
    expect(
      readerView.contentEl.querySelectorAll(".rss-reader-item-title"),
    ).toHaveLength(1);
    expect(readerView.contentEl.textContent).toContain("Current full article");
  });

  it.each(["success", "restricted", "error"])(
    "keeps the new article's load independent of an old manual %s",
    async (outcome) => {
      await readerView.onOpen();
      await readerView.displayItem(makeItem({ link: "https://aeon.co/first" }));
      const oldFetch = deferredFetch();
      fetchFullArticleContentWithOutcomeMock.mockReturnValueOnce(
        oldFetch.promise,
      );
      const oldLoad = readerView.loadFullArticle();
      const second = makeItem({
        guid: "second",
        title: "Second",
        link: "https://aeon.co/second",
      });
      await readerView.displayItem(second);
      const newFetch = deferredFetch();
      fetchFullArticleContentWithOutcomeMock.mockReturnValueOnce(
        newFetch.promise,
      );
      const newLoad = readerView.loadFullArticle();
      expect(fetchFullArticleContentWithOutcomeMock).toHaveBeenCalledTimes(2);
      if (outcome === "error") oldFetch.reject(new Error("Old request failed"));
      else
        oldFetch.resolve({
          content: outcome === "success" ? fullText("Obsolete") : "",
          failureType: outcome === "restricted" ? "restricted" : "none",
        });
      expect(await oldLoad).toBe(false);
      expect(readerView.contentEl.textContent).not.toContain(
        "Obsolete full article",
      );
      expect(second.restrictedReason).toBeUndefined();
      expect(
        readerView.contentEl
          .querySelector(".rss-reader-fulltext-button")
          ?.classList.contains("is-loading"),
      ).toBe(true);
      expect(await readerView.loadFullArticle()).toBe(false);
      expect(fetchFullArticleContentWithOutcomeMock).toHaveBeenCalledTimes(2);
      newFetch.resolve({ content: fullText("Second"), failureType: "none" });
      expect(await newLoad).toBe(true);
      expect(readerView.contentEl.textContent).toContain("Second full article");
    },
  );

  it("does not render a pending full article after the reader closes", async () => {
    await readerView.onOpen();
    await readerView.displayItem(makeItem({ link: "https://aeon.co/first" }));
    const pending = deferredFetch();
    fetchFullArticleContentWithOutcomeMock.mockReturnValueOnce(pending.promise);
    const loading = readerView.loadFullArticle();
    await readerView.onClose();
    pending.resolve({ content: fullText("Obsolete"), failureType: "none" });
    expect(await loading).toBe(false);
    expect(readerView.contentEl.textContent).not.toContain(
      "Obsolete full article",
    );
  });

  it("invalidates a pending full-text request when the podcast player selects another episode", async () => {
    const firstEpisode = makeItem({
      guid: "podcast-1",
      title: "Podcast episode 1",
      link: "https://example.com/podcast-1",
      mediaType: "podcast",
      audioUrl: "https://example.com/podcast-1.mp3",
      content: "",
    });
    const secondEpisode = makeItem({
      guid: "podcast-2",
      title: "Podcast episode 2",
      link: "https://example.com/podcast-2",
      mediaType: "podcast",
      audioUrl: "https://example.com/podcast-2.mp3",
      content: "",
    });
    settings.feeds = [
      {
        title: "Reader Feed",
        url: firstEpisode.feedUrl,
        folder: "Podcasts",
        items: [firstEpisode, secondEpisode],
        lastUpdated: 0,
      } satisfies Feed,
    ];

    await readerView.onOpen();
    await readerView.displayItem(firstEpisode);
    const pending = deferredFetch();
    fetchFullArticleContentWithOutcomeMock.mockReturnValueOnce(pending.promise);
    const manualLoad = readerView.loadFullArticle();

    const secondRow = readerView.contentEl.querySelector<HTMLElement>(
      ".playlist-episode-row[data-episode-guid='podcast-2']",
    );
    secondRow?.click();

    pending.resolve({
      content: fullText("Obsolete podcast"),
      failureType: "none",
    });
    expect(await manualLoad).toBe(false);
    expect(readerView.contentEl.textContent).not.toContain(
      "Obsolete podcast full article",
    );
    expect(
      readerView.contentEl
        .querySelector(".rss-reader-fulltext-button")
        ?.classList.contains("is-loading"),
    ).toBe(false);
    expect(
      readerView.contentEl
        .querySelector(".playlist-episode-row[data-episode-guid='podcast-2']")
        ?.classList.contains("active"),
    ).toBe(true);
  });

  it("includes a load full text button in the restricted paywall banner", async () => {
    const item = makeItem({ restrictedReason: RESTRICTED_ARTICLE_REASON });
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

  it("renders feed summaries without an excerpt notice or open original link", async () => {
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
    expect(excerptBanner).toBeNull();
    expect(readingContainer.textContent).toContain("Only an excerpt.");
    expect(readingContainer.textContent).not.toContain("Showing feed summary");
    expect(readingContainer.textContent).not.toContain("Open original");
  });

  it("loads full article and updates view when clicking load full text button in banner", async () => {
    const item = makeItem({ restrictedReason: RESTRICTED_ARTICLE_REASON });
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
      "<p>" +
      "This is the full article content extracted by Readability. ".repeat(10) +
      "</p>";
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
    expect(
      readingContainer.querySelector(".rss-reader-paywall-banner"),
    ).toBeNull();
    expect(item.restrictedReason).toBeUndefined();

    // Toolbar button should now show is-loaded
    const contentEl = (readerView as unknown as { contentEl: HTMLElement })
      .contentEl;
    const fullTextButton = contentEl.querySelector(
      ".rss-reader-fulltext-button",
    );
    expect(fullTextButton?.classList.contains("is-loaded")).toBe(true);
    expect(fullTextButton?.getAttribute("title")).toBe("Show original article");
  });

  it("loads full article when clicking toolbar full-text button", async () => {
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

  it("restores the original article when clicking toolbar full-text button again", async () => {
    const item = makeItem();
    await readerView.onOpen();
    await readerView.displayItem(item);

    const contentEl = (readerView as unknown as { contentEl: HTMLElement })
      .contentEl;
    const fullTextButton = contentEl.querySelector(
      ".rss-reader-fulltext-button",
    ) as HTMLElement;
    expect(fullTextButton.classList.contains("is-loaded")).toBe(false);

    const readingContainer = (
      readerView as unknown as { readingContainer: HTMLElement }
    ).readingContainer;

    fetchFullArticleContentWithOutcomeMock.mockResolvedValueOnce({
      content: fullText("Fetched"),
      failureType: "none",
    });
    fullTextButton.click();
    await vi.waitFor(() => {
      const content = readingContainer.querySelector(
        ".rss-reader-article-content",
      );
      expect(content?.textContent).toContain("Fetched full article content");
    });
    expect(fullTextButton.classList.contains("is-loaded")).toBe(true);

    fullTextButton.click();
    await vi.waitFor(() => {
      const content = readingContainer.querySelector(
        ".rss-reader-article-content",
      );
      expect(content?.textContent).toContain("Short excerpt summary.");
    });

    expect(readingContainer.textContent).not.toContain(
      "Fetched full article content",
    );
    expect(readingContainer.textContent).not.toContain("Showing feed summary");
    expect(
      readingContainer.querySelector(".rss-reader-item-title")?.textContent,
    ).toBe(item.title);
    expect(fullTextButton.classList.contains("is-loaded")).toBe(false);
    expect(fullTextButton.getAttribute("title")).toBe("Load full article");
    expect(fetchFullArticleContentWithOutcomeMock).toHaveBeenCalledTimes(1);
  });

  it("preserves existing content when loadFullArticle fails", async () => {
    const item = makeItem({
      description: "<p>Original excerpt preserved.</p>",
    });
    await readerView.onOpen();
    await readerView.displayItem(item);

    const readingContainer = (
      readerView as unknown as { readingContainer: HTMLElement }
    ).readingContainer;
    expect(readingContainer.textContent).toContain(
      "Original excerpt preserved.",
    );

    // The manual load fails.
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

    expect(readingContainer.textContent).toContain(
      "Original excerpt preserved.",
    );
    expect(fullTextButton.classList.contains("is-loaded")).toBe(false);
  });
});
