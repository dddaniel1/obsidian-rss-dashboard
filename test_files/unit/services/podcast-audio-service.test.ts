import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { PodcastAudioService } from "../../../src/services/podcast-audio-service";
import {
  installMediaElementPolyfills,
  installObsidianDomPolyfills,
} from "../test-dom-polyfills";
import type { FeedItem, Tag } from "../../../src/types/types";

describe("PodcastAudioService", () => {
  let app: App;
  let service: PodcastAudioService;
  let progressCallback: ReturnType<typeof vi.fn>;

  function baseEpisode(index = 1): FeedItem {
    return {
      title: `Podcast Episode ${index}`,
      link: `https://example.com/ep${index}`,
      description: `<p>Episode ${index} notes</p>`,
      pubDate: "2026-03-01T12:00:00.000Z",
      guid: `guid-ep-${index}`,
      read: false,
      starred: false,
      tags: [] as Tag[],
      feedTitle: "My Podcast Show",
      feedUrl: "https://example.com/podcast.xml",
      coverImage: "https://example.com/cover.jpg",
      mediaType: "podcast",
      audioUrl: `https://example.com/audio-${index}.mp3`,
    };
  }

  beforeEach(() => {
    installObsidianDomPolyfills();
    installMediaElementPolyfills();
    document.body.empty();
    app = new App();
    progressCallback = vi.fn();
    service = new PodcastAudioService({
      app,
      onPlaybackProgress: progressCallback,
      rememberProgress: true,
      defaultPlaySpeed: 1,
    });
  });

  afterEach(() => {
    service.destroy();
    vi.restoreAllMocks();
    document.body.empty();
  });

  describe("initial state", () => {
    it("initializes with idle state and no current track", () => {
      expect(service.getCurrentItem()).toBeNull();
      expect(service.getPlaybackState()).toBe("idle");
      expect(service.isPlaying()).toBe(false);
      expect(service.getCurrentTime()).toBe(0);
      expect(service.getDuration()).toBe(0);
      expect(service.getPlaybackRate()).toBe(1);
    });
  });

  describe("episode loading & playback controls", () => {
    it("loads an episode and sets audio source", () => {
      const episode = baseEpisode(1);
      service.loadEpisode(episode);

      expect(service.getCurrentItem()).toEqual(episode);
      expect(service.getAudioElement().src).toBe("https://example.com/audio-1.mp3");
      expect(service.getPlaybackState()).toBe("paused");
    });

    it("restores saved playback progress when loading", () => {
      const episode = {
        ...baseEpisode(1),
        playbackProgress: { position: 120, duration: 600, lastUpdated: Date.now() },
      };
      service.loadEpisode(episode);

      expect(service.getAudioElement().currentTime).toBe(120);
      expect(service.getCurrentTime()).toBe(120);
    });

    it("toggles playback between play and pause", async () => {
      const episode = baseEpisode(1);
      service.loadEpisode(episode);

      await service.play();
      expect(service.isPlaying()).toBe(true);
      expect(service.getPlaybackState()).toBe("playing");

      service.pause();
      expect(service.isPlaying()).toBe(false);
      expect(service.getPlaybackState()).toBe("paused");

      await service.togglePlayback();
      expect(service.isPlaying()).toBe(true);
    });

    it("supports seeking to absolute and relative positions", () => {
      const episode = baseEpisode(1);
      service.loadEpisode(episode);
      // Simulate duration loaded
      Object.defineProperty(service.getAudioElement(), "duration", {
        value: 1000,
        writable: true,
      });

      service.seek(300);
      expect(service.getCurrentTime()).toBe(300);

      service.seekRelative(30);
      expect(service.getCurrentTime()).toBe(330);

      service.seekRelative(-50);
      expect(service.getCurrentTime()).toBe(280);

      // Clamping to 0
      service.seekRelative(-500);
      expect(service.getCurrentTime()).toBe(0);
    });

    it("updates playback rate", () => {
      const episode = baseEpisode(1);
      service.loadEpisode(episode);

      service.setPlaybackRate(1.5);
      expect(service.getPlaybackRate()).toBe(1.5);
      expect(service.getAudioElement().playbackRate).toBe(1.5);
    });

    it("updates volume", () => {
      service.setVolume(0.5);
      expect(service.getVolume()).toBe(0.5);
      expect(service.getAudioElement().volume).toBe(0.5);
    });
  });

  describe("playlist management & navigation", () => {
    it("navigates through playlist with playNext and playPrevious", () => {
      const ep1 = baseEpisode(1);
      const ep2 = baseEpisode(2);
      const ep3 = baseEpisode(3);
      service.loadEpisode(ep1, [ep1, ep2, ep3]);

      expect(service.getCurrentPlaylistIndex()).toBe(0);

      service.playNext();
      expect(service.getCurrentItem()?.guid).toBe(ep2.guid);
      expect(service.getCurrentPlaylistIndex()).toBe(1);

      service.playNext();
      expect(service.getCurrentItem()?.guid).toBe(ep3.guid);
      expect(service.getCurrentPlaylistIndex()).toBe(2);

      service.playPrevious();
      expect(service.getCurrentItem()?.guid).toBe(ep2.guid);
      expect(service.getCurrentPlaylistIndex()).toBe(1);
    });
  });

  describe("event subscriptions", () => {
    it("emits events when track, state, or time changes", async () => {
      const trackListener = vi.fn();
      const stateListener = vi.fn();
      const timeListener = vi.fn();

      service.on("track-change", trackListener);
      service.on("state-change", stateListener);
      service.on("time-update", timeListener);

      const ep = baseEpisode(1);
      service.loadEpisode(ep);

      expect(trackListener).toHaveBeenCalledWith(ep);

      await service.play();
      expect(stateListener).toHaveBeenCalledWith("playing");

      service.seek(42);
      expect(timeListener).toHaveBeenCalledWith(42, expect.any(Number));
    });
  });

  describe("sleep timer", () => {
    it("stops playback when sleep timer fires", () => {
      vi.useFakeTimers();
      const ep = baseEpisode(1);
      service.loadEpisode(ep);
      void service.play();

      service.setSleepTimer(15); // 15 minutes
      expect(service.getSleepTimerRemaining()).toBe(15 * 60);

      // Fast-forward 15 minutes
      vi.advanceTimersByTime(15 * 60 * 1000);

      expect(service.isPlaying()).toBe(false);
      expect(service.getSleepTimerRemaining()).toBeNull();
      vi.useRealTimers();
    });
  });

  describe("persistence", () => {
    it("saves progress periodically and on pause", async () => {
      const ep = baseEpisode(1);
      service.loadEpisode(ep);
      Object.defineProperty(service.getAudioElement(), "duration", {
        value: 600,
        writable: true,
      });
      service.getAudioElement().currentTime = 150;

      service.pause();

      expect(progressCallback).toHaveBeenCalledWith(
        ep,
        150,
        600,
        true, // flush
      );
    });
  });
});
