import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { PodcastAudioService } from "../../../src/services/podcast-audio-service";
import { PodcastMiniPlayer } from "../../../src/components/podcast-mini-player";
import {
  installMediaElementPolyfills,
  installObsidianDomPolyfills,
} from "../test-dom-polyfills";
import type { FeedItem, Tag } from "../../../src/types/types";

describe("PodcastMiniPlayer", () => {
  let app: App;
  let audioService: PodcastAudioService;
  let container: HTMLDivElement;
  let miniPlayer: PodcastMiniPlayer;
  let onExpandMock: ReturnType<typeof vi.fn>;
  let onCloseMock: ReturnType<typeof vi.fn>;

  function baseEpisode(): FeedItem {
    return {
      title: "Episode Title Alpha",
      link: "https://example.com/ep1",
      description: "<p>Show notes</p>",
      pubDate: "2026-03-01T12:00:00.000Z",
      guid: "guid-ep-1",
      read: false,
      starred: false,
      tags: [] as Tag[],
      feedTitle: "Daily Tech Show",
      feedUrl: "https://example.com/feed.xml",
      coverImage: "https://example.com/art.jpg",
      mediaType: "podcast",
      audioUrl: "https://example.com/ep1.mp3",
    };
  }

  beforeEach(() => {
    installObsidianDomPolyfills();
    installMediaElementPolyfills();
    document.body.empty();
    app = new App();
    container = document.body.createDiv();
    audioService = new PodcastAudioService({
      app,
      rememberProgress: false,
    });
    onExpandMock = vi.fn();
    onCloseMock = vi.fn();
    miniPlayer = new PodcastMiniPlayer({
      container,
      audioService,
      theme: "obsidian",
      onExpand: onExpandMock,
      onClose: onCloseMock,
    });
  });

  afterEach(() => {
    miniPlayer.destroy();
    audioService.destroy();
    vi.restoreAllMocks();
    document.body.empty();
  });

  it("is initially hidden when no episode is loaded", () => {
    const el = container.querySelector(".rss-podcast-mini-player");
    expect(el).not.toBeNull();
    expect(el?.classList.contains("is-hidden")).toBe(true);
  });

  it("becomes visible and updates text when an episode is loaded", () => {
    const episode = baseEpisode();
    audioService.loadEpisode(episode);

    const el = container.querySelector(".rss-podcast-mini-player");
    expect(el?.classList.contains("is-hidden")).toBe(false);

    const titleEl = container.querySelector(".rss-mini-title");
    expect(titleEl?.textContent).toBe("Episode Title Alpha");

    const feedEl = container.querySelector(".rss-mini-feed");
    expect(feedEl?.textContent).toBe("Daily Tech Show");
  });

  it("toggles play/pause when play button is clicked", async () => {
    const episode = baseEpisode();
    audioService.loadEpisode(episode);

    const playBtn = container.querySelector(".rss-mini-play-btn") as HTMLElement;
    expect(playBtn).not.toBeNull();

    playBtn.click();
    expect(audioService.isPlaying()).toBe(true);

    playBtn.click();
    expect(audioService.isPlaying()).toBe(false);
  });

  it("seeks relative when rewind and forward buttons are clicked", () => {
    const episode = baseEpisode();
    audioService.loadEpisode(episode);
    Object.defineProperty(audioService.getAudioElement(), "duration", {
      value: 600,
      writable: true,
    });
    audioService.seek(100);

    const rewindBtn = container.querySelector(".rss-mini-rewind-btn") as HTMLElement;
    const forwardBtn = container.querySelector(".rss-mini-forward-btn") as HTMLElement;

    rewindBtn.click();
    expect(audioService.getCurrentTime()).toBe(85); // -15s

    forwardBtn.click();
    expect(audioService.getCurrentTime()).toBe(115); // +30s
  });

  it("updates progress bar width and time text on timeupdate", () => {
    const episode = baseEpisode();
    audioService.loadEpisode(episode);
    Object.defineProperty(audioService.getAudioElement(), "duration", {
      value: 100,
      writable: true,
    });
    audioService.seek(50);

    const progressFilled = container.querySelector(".rss-mini-progress-filled") as HTMLElement;
    expect(progressFilled.style.width).toBe("50%");

    const timeEl = container.querySelector(".rss-mini-time");
    expect(timeEl?.textContent).toContain("00:50");
  });

  it("triggers onExpand when expand button is clicked", () => {
    const episode = baseEpisode();
    audioService.loadEpisode(episode);

    const expandBtn = container.querySelector(".rss-mini-expand-btn") as HTMLElement;
    expandBtn.click();

    expect(onExpandMock).toHaveBeenCalledWith(episode);
  });

  it("triggers onClose and pauses playback when close button is clicked", () => {
    const episode = baseEpisode();
    audioService.loadEpisode(episode);
    void audioService.play();

    const closeBtn = container.querySelector(".rss-mini-close-btn") as HTMLElement;
    closeBtn.click();

    expect(audioService.isPlaying()).toBe(false);
    expect(onCloseMock).toHaveBeenCalled();
    const el = container.querySelector(".rss-podcast-mini-player");
    expect(el?.classList.contains("is-hidden")).toBe(true);
  });

  it("updates theme attribute when updateTheme is called", () => {
    miniPlayer.updateTheme("dracula");
    const el = container.querySelector(".rss-podcast-mini-player");
    expect(el?.getAttribute("data-podcast-theme")).toBe("dracula");
  });

  it("reappears when playback starts after being closed", async () => {
    const episode = baseEpisode();
    audioService.loadEpisode(episode);
    await audioService.play();

    const closeBtn = container.querySelector(".rss-mini-close-btn") as HTMLElement;
    closeBtn.click();

    const el = container.querySelector(".rss-podcast-mini-player");
    expect(el?.classList.contains("is-hidden")).toBe(true);

    await audioService.play();

    expect(el?.classList.contains("is-hidden")).toBe(false);
  });
});
