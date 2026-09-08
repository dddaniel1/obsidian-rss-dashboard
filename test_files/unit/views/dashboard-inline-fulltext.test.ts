import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, WorkspaceLeaf } from "obsidian";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import {
  DEFAULT_SETTINGS,
  type Feed,
  type FeedItem,
  type RssDashboardSettings,
} from "../../../src/types/types";

vi.mock("../../../src/utils/platform-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/utils/platform-utils")>();
  return {
    ...actual,
    robustFetch: vi.fn(),
    ensureUtf8Meta: (html: string) => html,
    shouldUseMobileSidebarLayout: () => false,
  };
});

vi.mock("../../../src/components/article-list", () => ({
  ArticleList: class ArticleListMock {
    constructor(..._args: unknown[]) {}
    render(): void {}
    destroy(): void {}
    refilter(..._args: unknown[]): void {}
    setSelectedArticle(..._args: unknown[]): void {}
    hasArticle(): boolean {
      return false;
    }
    insertArticleInPlace(): boolean {
      return false;
    }
    removeArticleInPlace(): void {}
    updateArticleInPlace(): void {}
  },
}));

vi.mock("../../../src/components/sidebar", () => ({
  Sidebar: class SidebarMock {
    constructor(..._args: unknown[]) {}
    render(): void {}
    clearFolderPathCache(): void {}
    destroy(): void {}
    showEditFeedModal(): void {}
  },
}));

vi.mock("../../../src/modals/feed-manager-modal", () => ({
  FeedManagerModal: class FeedManagerModalMock {
    constructor(..._args: unknown[]) {}
    open(): void {}
  },
}));

vi.mock("../../../src/modals/mobile-navigation-modal", () => ({
  MobileNavigationModal: class MobileNavigationModalMock {
    constructor(..._args: unknown[]) {}
    open(): void {}
    close(): void {}
  },
}));

vi.mock("../../../src/views/reader-view", () => ({
  ReaderView: class ReaderViewMock {},
  RSS_READER_VIEW_TYPE: "rss-reader-view",
}));

vi.mock("../../../src/services/article-saver", () => ({
  ArticleSaver: class ArticleSaverMock {
    constructor(..._args: unknown[]) {}
    verifyAllSavedArticles(): void {}
  },
}));

const mockLoadFullArticle = vi.fn().mockResolvedValue(true);
const mockIsContentFullArticle = vi.fn().mockReturnValue(false);
const mockIsFullArticleLoading = vi.fn().mockReturnValue(false);

vi.mock("../../../src/components/article-renderer", () => {
  return {
    ArticleRenderer: class ArticleRendererMock {
      loadFullArticle = mockLoadFullArticle;
      isContentFullArticle = mockIsContentFullArticle;
      isFullArticleLoading = mockIsFullArticleLoading;
      render = vi.fn();
      setSourceSettings = vi.fn();
    },
  };
});

interface DashboardViewTestInternals {
  articleRenderer: {
    loadFullArticle: typeof mockLoadFullArticle;
    isContentFullArticle: typeof mockIsContentFullArticle;
    isFullArticleLoading: typeof mockIsFullArticleLoading;
    render: ReturnType<typeof vi.fn>;
  };
  containerEl: HTMLElement;
  inlineArticle: FeedItem | null;
  renderInlineArticle(container: HTMLElement): void;
  updateInlineFullTextButton(isFullArticle: boolean, isLoading: boolean): void;
}

function cloneSettings(): RssDashboardSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as RssDashboardSettings;
}

function makeFeed(url: string, items: Partial<FeedItem>[] = []): Feed {
  return {
    title: `Feed (${url})`,
    url,
    folder: "",
    items: items.map((item, index) => ({
      title: `Item ${index}`,
      link: `${url}#${index}`,
      description: "<p>Excerpt</p>",
      pubDate: new Date(Date.now() - index * 1000).toISOString(),
      guid: `${url}#${index}`,
      read: false,
      starred: false,
      tags: [],
      feedTitle: `Feed (${url})`,
      feedUrl: url,
      coverImage: "",
      mediaType: "article",
      saved: false,
      ...item,
    })),
    lastUpdated: Date.now(),
  };
}

describe("DashboardView inline full text button", () => {
  beforeEach(() => {
    installObsidianDomPolyfills();
    document.body.empty();
    vi.clearAllMocks();
  });

  it("renders a full-text button in the inline reader toolbar and invokes loadFullArticle on click", async () => {
    const { RssDashboardView } =
      await import("../../../src/views/dashboard-view");
    const settings = cloneSettings();
    const feed = makeFeed("https://example.com/feed", [
      { title: "Test inline article", link: "https://example.com/art-1" },
    ]);
    settings.feeds = [feed];

    const app = new App();
    const plugin = {
      settings,
      saveSettings: vi.fn(async () => {}),
      updateArticle: vi.fn(async () => {}),
      registerEvent: vi.fn(),
    };
    const leaf = { app } as unknown as WorkspaceLeaf;
    const view = new RssDashboardView(leaf, plugin as never) as unknown as DashboardViewTestInternals;
    view.articleRenderer = {
      loadFullArticle: mockLoadFullArticle,
      isContentFullArticle: mockIsContentFullArticle,
      isFullArticleLoading: mockIsFullArticleLoading,
      render: vi.fn(),
    };

    const container = document.createElement("div");
    view.containerEl = container;
    view.inlineArticle = feed.items[0];

    view.renderInlineArticle(container);

    const fullTextButton = container.querySelector(
      ".rss-reader-fulltext-button",
    ) as HTMLElement;
    expect(fullTextButton).not.toBeNull();
    expect(fullTextButton.getAttribute("title")).toBe("Load full article");

    fullTextButton.click();
    expect(mockLoadFullArticle).toHaveBeenCalledTimes(1);
  });

  it("updates full-text button state classes and title on state change", async () => {
    const { RssDashboardView } =
      await import("../../../src/views/dashboard-view");
    const settings = cloneSettings();
    const feed = makeFeed("https://example.com/feed", [
      { title: "Test inline article", link: "https://example.com/art-1" },
    ]);
    settings.feeds = [feed];

    const app = new App();
    const plugin = {
      settings,
      saveSettings: vi.fn(async () => {}),
      updateArticle: vi.fn(async () => {}),
      registerEvent: vi.fn(),
    };
    const leaf = { app } as unknown as WorkspaceLeaf;
    const view = new RssDashboardView(leaf, plugin as never) as unknown as DashboardViewTestInternals;
    view.articleRenderer = {
      loadFullArticle: mockLoadFullArticle,
      isContentFullArticle: mockIsContentFullArticle,
      isFullArticleLoading: mockIsFullArticleLoading,
      render: vi.fn(),
    };

    const container = document.createElement("div");
    view.containerEl = container;
    view.inlineArticle = feed.items[0];

    view.renderInlineArticle(container);

    const fullTextButton = container.querySelector(
      ".rss-reader-fulltext-button",
    ) as HTMLElement;

    // Loading state
    view.updateInlineFullTextButton(false, true);
    expect(fullTextButton.classList.contains("is-loading")).toBe(true);
    expect(fullTextButton.getAttribute("title")).toBe("Loading full article...");

    // Loaded state
    view.updateInlineFullTextButton(true, false);
    expect(fullTextButton.classList.contains("is-loading")).toBe(false);
    expect(fullTextButton.classList.contains("is-loaded")).toBe(true);
    expect(fullTextButton.getAttribute("title")).toBe("Reload full article");

    // Unloaded idle state
    view.updateInlineFullTextButton(false, false);
    expect(fullTextButton.classList.contains("is-loaded")).toBe(false);
    expect(fullTextButton.classList.contains("is-loading")).toBe(false);
    expect(fullTextButton.getAttribute("title")).toBe("Load full article");
  });
});
