import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArticleRenderer } from "../../../src/components/article-renderer";
import {
  FeedItem,
  Feed,
  RssDashboardSettings,
  DEFAULT_SETTINGS,
} from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import { Component } from "obsidian";
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

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    title: "ArticleRenderer Test Article",
    link: "https://example.com/article-renderer",
    description: "<p>Renderer fallback excerpt.</p>",
    content: "",
    pubDate: new Date().toISOString(),
    guid: "guid-renderer-readability-1",
    read: false,
    starred: false,
    tags: [],
    feedTitle: "Renderer Feed",
    feedUrl: "https://example.com/rss.xml",
    coverImage: "",
    mediaType: "article",
    saved: false,
    ...overrides,
  };
}

describe("ArticleRenderer load full text with Readability", () => {
  let renderer: ArticleRenderer;
  let container: HTMLElement;
  let settings: RssDashboardSettings;
  const onStateChange = vi.fn();

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

  beforeEach(() => {
    vi.clearAllMocks();
    fetchFullArticleContentWithOutcomeMock.mockReset();
    document.body.empty();

    const mockApp = {
      workspace: { getLeavesOfType: vi.fn().mockReturnValue([]) },
      vault: { getAbstractFileByPath: vi.fn() },
    };

    settings = {
      ...DEFAULT_SETTINGS,
      corsProxyEnabled: false,
    } as RssDashboardSettings;

    renderer = new ArticleRenderer({
      app: mockApp as never,
      component: new Component(),
      settings,
      onArticleSave: vi.fn(),
      onArticleUpdate: vi.fn(),
      onFullArticleStateChange: onStateChange,
    });

    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.empty();
    vi.clearAllMocks();
  });

  it("keeps a single request while a manual load is pending", async () => {
    await renderer.render(container, makeItem());
    const fetch = deferredFetch();
    fetchFullArticleContentWithOutcomeMock.mockReturnValueOnce(fetch.promise);
    const manual = renderer.loadFullArticle();
    expect(renderer.isFullArticleLoading()).toBe(true);
    expect(await renderer.loadFullArticle()).toBe(false);
    expect(fetchFullArticleContentWithOutcomeMock).toHaveBeenCalledTimes(1);
    fetch.resolve({
      content: "<p>" + "Initial full article. ".repeat(20) + "</p>",
      failureType: "none",
    });
    expect(await manual).toBe(true);
    expect(container.querySelectorAll(".rss-reader-item-title")).toHaveLength(
      1,
    );
    expect(renderer.isFullArticleLoading()).toBe(false);
  });

  it("renders feed content without fetching full text on open", async () => {
    // Tripwire: any automatic fetch would render this content and fail the test.
    fetchFullArticleContentWithOutcomeMock.mockResolvedValue({
      content: "<p>" + "Auto loaded content. ".repeat(20) + "</p>",
      failureType: "none",
    });

    const item = makeItem({
      description: "<p>Feed summary body.</p>",
      content: "",
    });
    await renderer.render(container, item);

    expect(fetchFullArticleContentWithOutcomeMock).not.toHaveBeenCalled();
    expect(
      container.querySelector(".rss-reader-article-content")?.textContent,
    ).toContain("Feed summary body.");
    expect(renderer.isContentFullArticle()).toBe(false);
    expect(onStateChange).toHaveBeenCalledWith(false, false);

    fetchFullArticleContentWithOutcomeMock.mockResolvedValueOnce({
      content: "<p>" + "Manual full article content. ".repeat(20) + "</p>",
      failureType: "none",
    });
    await renderer.loadFullArticle();
    await vi.waitFor(() => {
      expect(
        container.querySelector(".rss-reader-article-content")?.textContent,
      ).toContain("Manual full article content");
    });
    expect(fetchFullArticleContentWithOutcomeMock).toHaveBeenCalledTimes(1);
    expect(renderer.isContentFullArticle()).toBe(true);
  });

  it.each(["success", "failure"])(
    "ignores a stale manual %s from a previously opened article",
    async (outcome) => {
      const firstItem = makeItem();
      await renderer.render(container, firstItem);
      const stale = deferredFetch();
      fetchFullArticleContentWithOutcomeMock.mockReturnValueOnce(stale.promise);
      const manual = renderer.loadFullArticle();
      const next = makeItem({ guid: "next", title: "Next article" });
      await renderer.render(container, next);
      onStateChange.mockClear();
      if (outcome === "success") {
        stale.resolve({
          content: "<p>" + "Stale manual content. ".repeat(20) + "</p>",
          failureType: "none",
        });
      } else {
        stale.reject(new Error("Old request failed"));
      }
      expect(await manual).toBe(false);
      expect(container.textContent).not.toContain("Stale manual content");
      expect(renderer.isContentFullArticle()).toBe(false);
      expect(renderer.isFullArticleLoading()).toBe(false);
      expect(onStateChange).not.toHaveBeenCalled();
      expect(renderer.getCurrentItem()).toBe(next);
    },
  );

  it("does not render or notify after the renderer is destroyed during a fetch", async () => {
    await renderer.render(container, makeItem());
    const fetch = deferredFetch();
    fetchFullArticleContentWithOutcomeMock.mockReturnValueOnce(fetch.promise);
    const manual = renderer.loadFullArticle();
    renderer.destroy();
    onStateChange.mockClear();
    fetch.resolve({
      content: "<p>" + "Late content. ".repeat(30) + "</p>",
      failureType: "none",
    });
    expect(await manual).toBe(false);
    expect(container.textContent).not.toContain("Late content");
    expect(onStateChange).not.toHaveBeenCalled();
    expect(renderer.getCurrentItem()).toBeNull();
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
        title: "Renderer Feed",
        url: firstEpisode.feedUrl,
        folder: "Podcasts",
        items: [firstEpisode, secondEpisode],
        lastUpdated: 0,
      } satisfies Feed,
    ];

    await renderer.render(container, firstEpisode);
    const pending = deferredFetch();
    fetchFullArticleContentWithOutcomeMock.mockReturnValueOnce(pending.promise);
    const manualLoad = renderer.loadFullArticle();
    onStateChange.mockClear();

    const secondRow = container.querySelector<HTMLElement>(
      ".playlist-episode-row[data-episode-guid='podcast-2']",
    );
    secondRow?.click();

    pending.resolve({
      content: "<p>" + "Stale podcast full text. ".repeat(20) + "</p>",
      failureType: "none",
    });
    expect(await manualLoad).toBe(false);
    expect(container.textContent).not.toContain("Stale podcast full text");
    expect(renderer.isFullArticleLoading()).toBe(false);
    expect(renderer.isContentFullArticle()).toBe(false);
    expect(
      container
        .querySelector(".playlist-episode-row[data-episode-guid='podcast-2']")
        ?.classList.contains("active"),
    ).toBe(true);
    expect(onStateChange).toHaveBeenCalledWith(false, false);
  });

  it("includes a load full text button in the restricted paywall banner", async () => {
    const item = makeItem({ restrictedReason: RESTRICTED_ARTICLE_REASON });
    await renderer.render(container, item);

    const banner = container.querySelector(".rss-reader-paywall-banner");
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
      description: "<p>Short summary only.</p>",
      content: "",
    });
    await renderer.render(container, item);

    const excerptBanner = container.querySelector(".rss-reader-excerpt-banner");
    expect(excerptBanner).toBeNull();
    expect(container.textContent).toContain("Short summary only.");
    expect(container.textContent).not.toContain("Showing feed summary");
    expect(container.textContent).not.toContain("Open original");
  });

  it("loads full article and updates view when clicking load full text button", async () => {
    const item = makeItem({ restrictedReason: RESTRICTED_ARTICLE_REASON });
    await renderer.render(container, item);

    const banner = container.querySelector(".rss-reader-paywall-banner");
    const loadBtn = banner?.querySelector(
      ".rss-reader-load-fulltext-btn",
    ) as HTMLElement;
    expect(loadBtn).not.toBeNull();

    const fullArticleHtml =
      "<p>" +
      "Full article rendered inline inside ArticleRenderer. ".repeat(10) +
      "</p>";
    fetchFullArticleContentWithOutcomeMock.mockResolvedValueOnce({
      content: fullArticleHtml,
      failureType: "none",
    });

    loadBtn.click();

    await vi.waitFor(() => {
      const content = container.querySelector(".rss-reader-article-content");
      expect(content?.textContent).toContain(
        "Full article rendered inline inside ArticleRenderer",
      );
    });

    expect(container.querySelector(".rss-reader-paywall-banner")).toBeNull();
    expect(item.restrictedReason).toBeUndefined();
    expect(renderer.isContentFullArticle()).toBe(true);
  });

  it("restores the original article when loadFullArticle is called again", async () => {
    fetchFullArticleContentWithOutcomeMock.mockResolvedValueOnce({
      content: "<p>" + "Fetched full article content. ".repeat(20) + "</p>",
      failureType: "none",
    });

    const item = makeItem();
    await renderer.render(container, item);
    expect(renderer.isContentFullArticle()).toBe(false);
    expect(onStateChange).toHaveBeenCalledWith(false, false);
    onStateChange.mockClear();

    expect(await renderer.loadFullArticle(container)).toBe(true);
    expect(onStateChange).toHaveBeenCalledWith(true, false);
    onStateChange.mockClear();

    expect(await renderer.loadFullArticle(container)).toBe(true);

    const content = container.querySelector(".rss-reader-article-content");
    expect(content?.textContent).toContain("Renderer fallback excerpt.");
    expect(container.textContent).not.toContain("Fetched full article content");
    expect(container.textContent).not.toContain("Showing feed summary");
    expect(container.querySelector(".rss-reader-item-title")?.textContent).toBe(
      item.title,
    );
    expect(renderer.isContentFullArticle()).toBe(false);
    expect(onStateChange).toHaveBeenCalledWith(false, false);
    expect(fetchFullArticleContentWithOutcomeMock).toHaveBeenCalledTimes(1);
  });
});
