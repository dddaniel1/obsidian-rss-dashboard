import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArticleRenderer } from "../../../src/components/article-renderer";
import {
  FeedItem,
  RssDashboardSettings,
  DEFAULT_SETTINGS,
} from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import { Component } from "obsidian";

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

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.empty();

    const mockApp = {
      workspace: { getLeavesOfType: vi.fn().mockReturnValue([]) },
      vault: { getAbstractFileByPath: vi.fn() },
    };

    renderer = new ArticleRenderer({
      app: mockApp as never,
      component: new Component(),
      settings: { ...DEFAULT_SETTINGS, corsProxyEnabled: false } as RssDashboardSettings,
      onArticleSave: vi.fn(),
      onArticleUpdate: vi.fn(),
    });

    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("includes a load full text button in the restricted paywall banner", async () => {
    fetchFullArticleContentWithOutcomeMock.mockResolvedValue({
      content: "",
      failureType: "restricted",
    });

    const item = makeItem();
    await renderer.render(container, item);

    const banner = container.querySelector(".rss-reader-paywall-banner");
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
      description: "<p>Short summary only.</p>",
      content: "",
    });
    await renderer.render(container, item);

    const excerptBanner = container.querySelector(".rss-reader-excerpt-banner");
    expect(excerptBanner).not.toBeNull();
    expect(excerptBanner?.textContent).toContain("Showing feed summary");

    const loadBtn = excerptBanner?.querySelector(".rss-reader-load-fulltext-btn");
    expect(loadBtn).not.toBeNull();
    expect(loadBtn?.textContent).toBe("Load full text");
  });

  it("loads full article and updates view when clicking load full text button", async () => {
    fetchFullArticleContentWithOutcomeMock.mockResolvedValueOnce({
      content: "",
      failureType: "restricted",
    });

    const item = makeItem();
    await renderer.render(container, item);

    const banner = container.querySelector(".rss-reader-paywall-banner");
    const loadBtn = banner?.querySelector(
      ".rss-reader-load-fulltext-btn",
    ) as HTMLElement;
    expect(loadBtn).not.toBeNull();

    const fullArticleHtml =
      "<p>" + "Full article rendered inline inside ArticleRenderer. ".repeat(10) + "</p>";
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
});
