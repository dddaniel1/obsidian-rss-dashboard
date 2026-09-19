import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as obsidian from "obsidian";
import { ReaderView } from "../../../src/views/reader-view";
import { TranslationService } from "../../../src/services/translation-service";
import {
  FeedItem,
  RssDashboardSettings,
  DEFAULT_SETTINGS,
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
}

type ReaderViewHarness = {
  contentEl: HTMLElement;
  readingContainer: HTMLElement;
  fetchFullArticleContent: ReturnType<typeof vi.fn>;
  shouldSkipFullArticleFetch: (item: FeedItem) => boolean;
};

function getHarness(view: ReaderView): ReaderViewHarness {
  return view as unknown as ReaderViewHarness;
}

function createItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    guid: "test-guid",
    title: "Test article",
    link: "https://example.com/article",
    pubDate: new Date().toISOString(),
    description: "",
    content: "<p>Hello world</p><p>Second paragraph</p>",
    feedTitle: "Test feed",
    feedUrl: "https://example.com/feed.xml",
    ...overrides,
  } as FeedItem;
}

describe("ReaderView translation", () => {
  let readerView: ReaderView;
  let mockApp: Record<string, unknown>;
  let mockSettings: RssDashboardSettings;

  beforeEach(async () => {
    vi.restoreAllMocks();
    TranslationService.clearCache();
    fetchFullArticleContentWithOutcomeMock.mockResolvedValue({
      content: "",
      failureType: "none",
    });
    mockApp = {
      workspace: {
        getLeavesOfType: vi.fn().mockReturnValue([]),
        setActiveLeaf: vi.fn(),
        revealLeaf: vi.fn(),
      },
      vault: {
        getAbstractFileByPath: vi.fn(),
      },
    };
    mockSettings = {
      ...DEFAULT_SETTINGS,
      useWebViewer: false,
      translation: {
        enabled: true,
        provider: "google" as const,
        targetLanguage: "zh-Hans",
      },
    };

    readerView = new ReaderView(
      new MockLeaf(mockApp) as never,
      mockSettings,
      { saveArticle: vi.fn() } as never,
      vi.fn(),
      vi.fn(),
    );

    getHarness(readerView).contentEl = document.createElement("div");
    await readerView.onOpen();
  });

  afterEach(() => {
    document.body.empty();
    vi.clearAllMocks();
  });

  it("inserts paragraph translations under the originals when toggled", async () => {
    const requestUrlSpy = vi.spyOn(obsidian, "requestUrl");
    requestUrlSpy.mockImplementation(async () => ({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: [[["你好，世界", "en", null, null], null, null, null]],
      text: "",
    }));

    const harness = getHarness(readerView);
    getHarness(readerView).fetchFullArticleContent = vi.fn().mockResolvedValue("");
    getHarness(readerView).shouldSkipFullArticleFetch = () => true;

    await readerView.displayItem(createItem());

    const translateButton = harness.contentEl.querySelector(
      ".rss-reader-translate-button",
    ) as HTMLElement;
    expect(translateButton).toBeTruthy();

    translateButton.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const translations = harness.readingContainer.querySelectorAll(
      ".rss-reader-translation",
    );
    expect(translations.length).toBe(2);
    expect(translations[0].textContent).toBe("你好，世界");

    // Translations appear directly after their original paragraphs.
    const firstOriginal = harness.readingContainer.querySelector(
      ".rss-reader-article-content p",
    ) as HTMLElement;
    expect(firstOriginal.nextElementSibling).toBe(translations[0]);
  });

  it("removes translations when toggled off", async () => {
    const requestUrlSpy = vi.spyOn(obsidian, "requestUrl");
    requestUrlSpy.mockImplementation(async () => ({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: [[["你好，世界", "en", null, null], null, null, null]],
      text: "",
    }));

    const harness = getHarness(readerView);
    getHarness(readerView).fetchFullArticleContent = vi.fn().mockResolvedValue("");
    getHarness(readerView).shouldSkipFullArticleFetch = () => true;

    await readerView.displayItem(createItem());

    const translateButton = harness.contentEl.querySelector(
      ".rss-reader-translate-button",
    ) as HTMLElement;
    translateButton.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      harness.readingContainer.querySelectorAll(".rss-reader-translation").length,
    ).toBe(2);

    translateButton.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      harness.readingContainer.querySelectorAll(".rss-reader-translation").length,
    ).toBe(0);
  });

  it("hides the translate button when translation is disabled", async () => {
    mockSettings.translation.enabled = false;
    // Re-open the view so the header re-renders without the translate button.
    await readerView.onOpen();
    const harness = getHarness(readerView);
    getHarness(readerView).fetchFullArticleContent = vi.fn().mockResolvedValue("");
    getHarness(readerView).shouldSkipFullArticleFetch = () => true;

    await readerView.displayItem(createItem());

    const translateButton = harness.contentEl.querySelector(
      ".rss-reader-translate-button",
    );
    expect(translateButton).toBeNull();
  });

  it("renders exactly one translate button across open, settings, and display flows", async () => {
    const harness = getHarness(readerView);
    await readerView.onOpen();

    // The dashboard applies source settings before the view is attached to
    // the workspace DOM, mirroring the open-in-new-tab flow.
    readerView.setSourceSettings(mockSettings);

    document.body.appendChild(harness.contentEl);
    getHarness(readerView).fetchFullArticleContent = vi
      .fn()
      .mockResolvedValue("");
    getHarness(readerView).shouldSkipFullArticleFetch = () => true;
    await readerView.displayItem(createItem());

    const buttons = harness.contentEl.querySelectorAll(
      ".rss-reader-translate-button",
    );
    expect(buttons.length).toBe(1);
  });

  it("updates translate button state with is-loading and progress title while in flight", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const requestUrlSpy = vi.spyOn(obsidian, "requestUrl");
    requestUrlSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const harness = getHarness(readerView);
    harness.fetchFullArticleContent = vi.fn().mockResolvedValue("");
    harness.shouldSkipFullArticleFetch = () => true;

    await readerView.displayItem(createItem());

    const translateButton = harness.contentEl.querySelector(
      ".rss-reader-translate-button",
    ) as HTMLElement;
    expect(translateButton).toBeTruthy();
    expect(translateButton.classList.contains("is-loading")).toBe(false);

    translateButton.click();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(translateButton.classList.contains("is-loading")).toBe(true);
    expect(translateButton.getAttribute("aria-busy")).toBe("true");
    expect(translateButton.getAttribute("title")).toContain("Translating article");

    for (const r of resolvers) {
      r({
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: [[["你好，世界", "en", null, null], null, null, null]],
        text: "",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(translateButton.classList.contains("is-loading")).toBe(false);
    expect(translateButton.classList.contains("active")).toBe(true);
    expect(translateButton.hasAttribute("aria-busy")).toBe(false);
    expect(translateButton.getAttribute("title")).toBe("Hide translation");
  });

  it("aborts DOM translation updates when switching articles during an in-flight translation", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const requestUrlSpy = vi.spyOn(obsidian, "requestUrl");
    requestUrlSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const harness = getHarness(readerView);
    harness.fetchFullArticleContent = vi.fn().mockResolvedValue("");
    harness.shouldSkipFullArticleFetch = () => true;

    await readerView.displayItem(createItem({ guid: "article-1" }));

    const translateButton = harness.contentEl.querySelector(
      ".rss-reader-translate-button",
    ) as HTMLElement;
    translateButton.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(translateButton.classList.contains("is-loading")).toBe(true);

    // Switch to another article while translation is in flight
    await readerView.displayItem(
      createItem({ guid: "article-2", content: "<p>New article content</p>" }),
    );

    // Now resolve the old translation requests
    for (const r of resolvers) {
      r({
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: [[["旧文章翻译", "en", null, null], null, null, null]],
        text: "",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    const translations = harness.readingContainer.querySelectorAll(
      ".rss-reader-translation",
    );
    expect(translations.length).toBe(0);
  });
});
