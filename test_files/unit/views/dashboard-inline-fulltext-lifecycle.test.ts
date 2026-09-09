import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, type WorkspaceLeaf } from "obsidian";
import { ArticleRenderer } from "../../../src/components/article-renderer";
import { RssDashboardView } from "../../../src/views/dashboard-view";
import { DEFAULT_SETTINGS, type FeedItem } from "../../../src/types/types";
import type { FullArticleFetchResult } from "../../../src/utils/fetch-helpers";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

const fetchArticle = vi.hoisted(() => vi.fn());
vi.mock("../../../src/utils/full-article-fetch", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/utils/full-article-fetch")
  >()),
  fetchFullArticleContentWithOutcome: fetchArticle,
}));

interface InlineReaderHarness {
  articleRenderer: ArticleRenderer;
  inlineArticle: FeedItem | null;
  renderInlineArticle(container: HTMLElement): void;
  updateInlineFullTextButton(full: boolean, loading: boolean): void;
}

describe("Dashboard inline full text request lifetime", () => {
  beforeEach(() => {
    installObsidianDomPolyfills();
    fetchArticle.mockReset();
    document.body.empty();
  });

  afterEach(() => {
    document.body.empty();
    vi.restoreAllMocks();
  });

  it.each(["back", "close"])(
    "discards pending full text when leaving the inline reader via %s",
    async (action) => {
      const app = new App();
      const settings = structuredClone(DEFAULT_SETTINGS);
      const view = new RssDashboardView(
        { app } as unknown as WorkspaceLeaf,
        {
          settings,
          saveSettings: vi.fn().mockResolvedValue(undefined),
        } as never,
      );
      const harness = view as unknown as InlineReaderHarness;
      const container = document.body.createDiv();
      // The dashboard layout is outside this test; leaving replaces its contents.
      vi.spyOn(view, "render").mockImplementation(() => container.empty());
      const renderer = new ArticleRenderer({
        app,
        component: view,
        settings,
        onArticleSave: vi.fn(),
        onArticleUpdate: vi.fn(),
        onFullArticleStateChange: (full, loading) =>
          harness.updateInlineFullTextButton(full, loading),
      });
      harness.articleRenderer = renderer;
      harness.inlineArticle = {
        title: "Pending article",
        link: "https://example.com/article",
        guid: "pending-article",
        description: "<p>Original excerpt.</p>",
        pubDate: "2026-09-09",
        read: false,
        starred: false,
        tags: [],
        feedTitle: "Feed",
        feedUrl: "https://example.com/feed",
        mediaType: "article",
      };
      fetchArticle.mockResolvedValueOnce({
        content: "",
        failureType: "network",
      });
      harness.renderInlineArticle(container);
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Original excerpt.");
      });
      const oldBody = container.querySelector<HTMLElement>(
        ".inline-reader-content",
      )!;
      const originalText = oldBody.querySelector(
        ".rss-reader-article-content",
      )?.textContent;
      let resolveRequest!: (result: FullArticleFetchResult) => void;
      fetchArticle.mockReturnValueOnce(
        new Promise<FullArticleFetchResult>((resolve) => {
          resolveRequest = resolve;
        }),
      );
      const pending = renderer.loadFullArticle(oldBody);
      if (action === "back") {
        container
          .querySelector<HTMLElement>(".rss-reader-back-button")!
          .click();
      } else {
        await view.onClose();
      }
      resolveRequest({
        content: `<p>${"Late full article text. ".repeat(30)}</p>`,
        failureType: "none",
      });
      expect(await pending).toBe(false);
      expect(
        oldBody.querySelector(".rss-reader-article-content")?.textContent,
      ).toBe(originalText);
      expect(renderer.isFullArticleLoading()).toBe(false);
      expect(renderer.getCurrentItem()).toBeNull();
    },
  );
});
