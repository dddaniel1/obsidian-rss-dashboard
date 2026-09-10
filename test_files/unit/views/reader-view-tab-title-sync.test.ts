import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../../../src/views/reader-view";
import {
  DEFAULT_SETTINGS,
  FeedItem,
  RssDashboardSettings,
} from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

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
  view: unknown;

  constructor(app: unknown) {
    this.app = app;
  }

  detach = vi.fn();
  updateHeader = vi.fn();
}

type ReaderViewInternals = {
  contentEl: HTMLElement;
};

function getInternals(view: ReaderView): ReaderViewInternals {
  return view as unknown as ReaderViewInternals;
}

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    title: "Article A",
    link: "https://example.com/article-a",
    description: "<p>Fallback description</p>",
    content: "",
    pubDate: "2026-04-01T10:00:00.000Z",
    guid: "guid-a",
    read: false,
    starred: false,
    tags: [],
    feedTitle: "Example Feed",
    feedUrl: "https://example.com/rss.xml",
    coverImage: "",
    mediaType: "article",
    saved: false,
    ...overrides,
  };
}

describe("ReaderView tab title sync", () => {
  let readerView: ReaderView;
  let mockLeaf: MockLeaf;
  let mockSettings: RssDashboardSettings;

  beforeEach(async () => {
    fetchFullArticleContentWithOutcomeMock.mockReset();

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

    mockLeaf = new MockLeaf(mockApp);
    mockSettings = { ...DEFAULT_SETTINGS, useWebViewer: false };

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

  it("refreshes the tab title when reusing the same reader view for another article", async () => {
    const itemA = makeItem();
    const itemB = makeItem({
      title: "Article B",
      link: "https://example.com/article-b",
      guid: "guid-b",
    });

    await readerView.displayItem(itemA);
    expect(readerView.getDisplayText()).toBe("Article A");
    // Opening an article syncs the title once; no fetch runs on open anymore.
    expect(mockLeaf.updateHeader).toHaveBeenCalledTimes(1);

    await readerView.displayItem(itemB);

    expect(readerView.getDisplayText()).toBe("Article B");
    expect(mockLeaf.updateHeader).toHaveBeenCalledTimes(2);
  });

  it("refreshes the tab title again when fetched full article content provides a better title", async () => {
    const item = makeItem({
      title: "Feed Title",
      link: "https://example.com/full-article",
      guid: "guid-full",
    });

    await readerView.displayItem(item);

    // Full text loads on demand since the behavior change.
    fetchFullArticleContentWithOutcomeMock.mockResolvedValueOnce({
      content: `
      <h1>Fetched Full Article Title</h1>
      <p>${"x".repeat(260)}</p>
    `,
      failureType: "none",
    });
    await readerView.loadFullArticle();

    expect(readerView.getDisplayText()).toBe("Fetched Full Article Title");
    // Once on open (feed title) and once again after the manual full-text
    // load surfaces the better page title.
    expect(mockLeaf.updateHeader).toHaveBeenCalledTimes(2);
  });
});
