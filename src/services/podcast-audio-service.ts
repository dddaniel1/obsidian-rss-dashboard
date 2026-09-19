import { App } from "obsidian";
import type { FeedItem } from "../types/types";
import { MediaService } from "./media-service";

export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "ended";

export interface PodcastAudioServiceEvents {
  "track-change": (item: FeedItem | null) => void;
  "state-change": (state: PlaybackState) => void;
  "time-update": (currentTime: number, duration: number) => void;
  "rate-change": (rate: number) => void;
  "volume-change": (volume: number) => void;
  "playlist-change": (playlist: FeedItem[], currentIndex: number) => void;
  "sleep-timer-change": (remainingSeconds: number | null) => void;
}

export interface PodcastAudioServiceOptions {
  app: App;
  onPlaybackProgress?: (
    item: FeedItem,
    position: number,
    duration: number,
    flush?: boolean,
  ) => void;
  rememberProgress?: boolean;
  defaultPlaySpeed?: number;
}

export class PodcastAudioService {
  private readonly app: App;
  private readonly audioElement: HTMLAudioElement;
  private currentItem: FeedItem | null = null;
  private playlist: FeedItem[] = [];
  private currentPlaylistIndex = -1;
  private playbackState: PlaybackState = "idle";
  private isAutoplayEnabled = false;
  private isShuffled = false;
  private isRepeat = false;
  private originalPlaylist: FeedItem[] = [];

  private progressInterval: number | null = null;
  private progressSaveInterval: number | null = null;
  private sleepTimerId: number | null = null;
  private sleepTimerTickId: number | null = null;
  private sleepTimerEndTime: number | null = null;

  private readonly onPlaybackProgress?: (
    item: FeedItem,
    position: number,
    duration: number,
    flush?: boolean,
  ) => void;
  private readonly rememberProgress: boolean;
  private playbackRate: number;

  private readonly listeners = new Map<keyof PodcastAudioServiceEvents, Set<unknown>>();

  constructor(options: PodcastAudioServiceOptions) {
    this.app = options.app;
    this.onPlaybackProgress = options.onPlaybackProgress;
    this.rememberProgress = options.rememberProgress ?? true;
    this.playbackRate = options.defaultPlaySpeed ?? 1;

    this.audioElement = activeWindow.createEl("audio");
    this.audioElement.preload = "metadata";
    this.audioElement.playbackRate = this.playbackRate;
    this.audioElement.defaultPlaybackRate = this.playbackRate;

    this.setupAudioElementListeners();
    this.setupMediaSession();
  }

  public getAudioElement(): HTMLAudioElement {
    return this.audioElement;
  }

  public getCurrentItem(): FeedItem | null {
    return this.currentItem;
  }

  public getPlaylist(): FeedItem[] {
    return this.playlist;
  }

  public getCurrentPlaylistIndex(): number {
    return this.currentPlaylistIndex;
  }

  public getPlaybackState(): PlaybackState {
    return this.playbackState;
  }

  public isPlaying(): boolean {
    return this.playbackState === "playing";
  }

  public getCurrentTime(): number {
    return this.audioElement.currentTime || 0;
  }

  public getDuration(): number {
    return this.audioElement.duration || 0;
  }

  public getPlaybackRate(): number {
    return this.playbackRate;
  }

  public getVolume(): number {
    return this.audioElement.volume;
  }

  public isShuffleActive(): boolean {
    return this.isShuffled;
  }

  public isRepeatActive(): boolean {
    return this.isRepeat;
  }

  public setAutoplay(enabled: boolean): void {
    this.isAutoplayEnabled = enabled;
  }

  public isAutoplay(): boolean {
    return this.isAutoplayEnabled;
  }

  public on<K extends keyof PodcastAudioServiceEvents>(
    event: K,
    listener: PodcastAudioServiceEvents[K],
  ): () => void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(listener);
    return () => this.off(event, listener);
  }

  public off<K extends keyof PodcastAudioServiceEvents>(
    event: K,
    listener: PodcastAudioServiceEvents[K],
  ): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit<K extends keyof PodcastAudioServiceEvents>(
    event: K,
    ...args: Parameters<PodcastAudioServiceEvents[K]>
  ): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          (handler as (...params: typeof args) => void)(...args);
        } catch (error) {
          console.error(`Error in PodcastAudioService event ${event}:`, error);
        }
      });
    }
  }

  private setupAudioElementListeners(): void {
    this.audioElement.onplay = () => {
      this.setPlaybackState("playing");
      this.startProgressTracking();
      this.updateMediaSessionPlaybackState("playing");
    };

    this.audioElement.onpause = () => {
      this.setPlaybackState("paused");
      this.stopProgressTracking();
      this.saveProgress(true);
      this.updateMediaSessionPlaybackState("paused");
    };

    this.audioElement.ontimeupdate = () => {
      this.emit("time-update", this.getCurrentTime(), this.getDuration());
    };

    this.audioElement.onloadedmetadata = () => {
      this.emit("time-update", this.getCurrentTime(), this.getDuration());
    };

    this.audioElement.onended = () => {
      this.setPlaybackState("ended");
      this.stopProgressTracking();
      this.saveProgress(true);
      this.updateMediaSessionPlaybackState("none");
      this.handleEpisodeEnd();
    };

    this.audioElement.onerror = () => {
      this.setPlaybackState("idle");
      this.stopProgressTracking();
    };
  }

  private setPlaybackState(state: PlaybackState): void {
    if (this.playbackState !== state) {
      this.playbackState = state;
      this.emit("state-change", state);
    }
  }

  public loadEpisode(
    item: FeedItem,
    fullFeedEpisodes?: FeedItem[],
    options?: { autoplay?: boolean },
  ): void {
    if (fullFeedEpisodes && Array.isArray(fullFeedEpisodes)) {
      this.setPlaylist(fullFeedEpisodes);
    }

    const resolvedAudioUrl =
      item.audioUrl ||
      item.enclosure?.url ||
      MediaService.extractPodcastAudio(item.description);

    if (resolvedAudioUrl) {
      item.audioUrl = resolvedAudioUrl;
    }

    this.currentItem = item;
    this.currentPlaylistIndex = this.playlist.findIndex(
      (ep) => ep.guid === item.guid,
    );

    this.emit("track-change", item);

    if (item.audioUrl) {
      this.audioElement.src = item.audioUrl;
      this.audioElement.load();
      this.audioElement.playbackRate = this.playbackRate;
      this.audioElement.defaultPlaybackRate = this.playbackRate;
      this.setPlaybackState("paused");

      const savedProgress = this.rememberProgress
        ? (item.playbackProgress ?? this.loadProgressFromStorage(item.guid))
        : undefined;

      if (savedProgress && savedProgress.position > 0) {
        this.audioElement.currentTime = savedProgress.position;
      }

      this.updateMediaSessionMetadata(item);

      if (options?.autoplay) {
        void this.play();
      }
    } else {
      this.audioElement.pause();
      this.audioElement.src = "";
      this.audioElement.load();
      this.setPlaybackState("idle");
    }
  }

  public setPlaylist(playlist: FeedItem[]): void {
    this.playlist = playlist;
    this.originalPlaylist = [...playlist];
    this.isShuffled = false;
    if (this.currentItem) {
      this.currentPlaylistIndex = this.playlist.findIndex(
        (ep) => ep.guid === this.currentItem?.guid,
      );
    } else {
      this.currentPlaylistIndex = 0;
    }
    this.emit("playlist-change", this.playlist, this.currentPlaylistIndex);
  }

  public async play(): Promise<void> {
    if (!this.currentItem?.audioUrl) return;
    try {
      await this.audioElement.play();
    } catch (error) {
      console.error("Failed to play audio:", error);
      this.setPlaybackState("paused");
    }
  }

  public pause(): void {
    this.audioElement.pause();
  }

  public async togglePlayback(): Promise<void> {
    if (this.isPlaying()) {
      this.pause();
    } else {
      await this.play();
    }
  }

  public seek(positionSeconds: number): void {
    if (!this.audioElement) return;
    const duration = this.getDuration();
    const target = Math.max(0, duration > 0 ? Math.min(positionSeconds, duration) : positionSeconds);
    this.audioElement.currentTime = target;
    this.emit("time-update", target, duration);
  }

  public seekRelative(deltaSeconds: number): void {
    this.seek(this.getCurrentTime() + deltaSeconds);
  }

  public setPlaybackRate(rate: number): void {
    this.playbackRate = rate;
    this.audioElement.playbackRate = rate;
    this.audioElement.defaultPlaybackRate = rate;
    this.emit("rate-change", rate);
  }

  public setVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.audioElement.volume = clamped;
    this.emit("volume-change", clamped);
  }

  public toggleShuffle(): void {
    if (this.playlist.length === 0) return;
    this.isShuffled = !this.isShuffled;
    if (this.isShuffled) {
      const current = this.currentItem;
      const rest = this.originalPlaylist.filter((i) => i.guid !== current?.guid);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = rest[i];
        rest[i] = rest[j];
        rest[j] = temp;
      }
      this.playlist = current ? [current, ...rest] : rest;
      this.currentPlaylistIndex = 0;
    } else {
      this.playlist = [...this.originalPlaylist];
      if (this.currentItem) {
        this.currentPlaylistIndex = this.playlist.findIndex(
          (i) => i.guid === this.currentItem?.guid,
        );
      }
    }
    this.emit("playlist-change", this.playlist, this.currentPlaylistIndex);
  }

  public toggleRepeat(): void {
    this.isRepeat = !this.isRepeat;
  }

  public playNext(): void {
    if (this.playlist.length === 0) return;
    if (this.currentPlaylistIndex < this.playlist.length - 1) {
      const nextItem = this.playlist[this.currentPlaylistIndex + 1];
      this.loadEpisode(nextItem, undefined, { autoplay: true });
    }
  }

  public playPrevious(): void {
    if (this.playlist.length === 0) return;
    if (this.currentPlaylistIndex > 0) {
      const prevItem = this.playlist[this.currentPlaylistIndex - 1];
      this.loadEpisode(prevItem, undefined, { autoplay: true });
    }
  }

  private handleEpisodeEnd(): void {
    if (this.isRepeat && this.currentItem) {
      this.seek(0);
      void this.play();
      return;
    }
    if (this.isAutoplayEnabled && this.currentPlaylistIndex < this.playlist.length - 1) {
      this.playNext();
    }
  }

  public setSleepTimer(minutes: number | "end" | null): void {
    this.clearSleepTimer();
    if (minutes === null) {
      this.emit("sleep-timer-change", null);
      return;
    }

    if (minutes === "end") {
      const remainingSeconds = Math.max(0, this.getDuration() - this.getCurrentTime());
      this.sleepTimerEndTime = Date.now() + remainingSeconds * 1000;
      this.sleepTimerId = window.setTimeout(() => {
        this.pause();
        this.clearSleepTimer();
      }, remainingSeconds * 1000);
    } else {
      const ms = minutes * 60 * 1000;
      this.sleepTimerEndTime = Date.now() + ms;
      this.sleepTimerId = window.setTimeout(() => {
        this.pause();
        this.clearSleepTimer();
      }, ms);
    }

    this.emit("sleep-timer-change", this.getSleepTimerRemaining());

    this.sleepTimerTickId = window.setInterval(() => {
      const remaining = this.getSleepTimerRemaining();
      this.emit("sleep-timer-change", remaining);
      if (remaining === null || remaining <= 0) {
        if (this.sleepTimerTickId !== null) {
          window.clearInterval(this.sleepTimerTickId);
          this.sleepTimerTickId = null;
        }
      }
    }, 1000);
  }

  public getSleepTimerRemaining(): number | null {
    if (!this.sleepTimerEndTime) return null;
    const remainingMs = this.sleepTimerEndTime - Date.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : null;
  }

  private clearSleepTimer(): void {
    if (this.sleepTimerId !== null) {
      window.clearTimeout(this.sleepTimerId);
      this.sleepTimerId = null;
    }
    if (this.sleepTimerTickId !== null) {
      window.clearInterval(this.sleepTimerTickId);
      this.sleepTimerTickId = null;
    }
    this.sleepTimerEndTime = null;
    this.emit("sleep-timer-change", null);
  }

  private startProgressTracking(): void {
    this.stopProgressTracking();
    this.progressInterval = window.setInterval(() => {
      this.saveProgress(false);
    }, 5000);
  }

  private stopProgressTracking(): void {
    if (this.progressInterval !== null) {
      window.clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
    if (this.progressSaveInterval !== null) {
      window.clearInterval(this.progressSaveInterval);
      this.progressSaveInterval = null;
    }
  }

  public saveProgress(flush = false): void {
    if (!this.rememberProgress || !this.currentItem) return;
    const position = this.getCurrentTime();
    const duration = this.getDuration();
    if (duration > 0 && position >= 0) {
      if (this.onPlaybackProgress) {
        this.onPlaybackProgress(this.currentItem, position, duration, flush);
      }
      this.saveProgressToStorage(this.currentItem.guid, position, duration);
    }
  }

  private saveProgressToStorage(guid: string, position: number, duration: number): void {
    try {
      const key = "rss-podcast-progress";
      const existing = (this.app.loadLocalStorage(key) as Record<string, { position: number; duration: number }>) || {};
      existing[guid] = { position, duration };
      this.app.saveLocalStorage(key, existing);
    } catch {
      // Ignore local storage errors
    }
  }

  private loadProgressFromStorage(guid: string): { position: number; duration: number } | undefined {
    try {
      const data = this.app.loadLocalStorage("rss-podcast-progress") as Record<string, { position: number; duration: number }> | undefined;
      return data?.[guid];
    } catch {
      return undefined;
    }
  }

  private setupMediaSession(): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    try {
      const session = navigator.mediaSession;
      session.setActionHandler("play", () => void this.play());
      session.setActionHandler("pause", () => this.pause());
      session.setActionHandler("seekbackward", () => this.seekRelative(-15));
      session.setActionHandler("seekforward", () => this.seekRelative(30));
      session.setActionHandler("previoustrack", () => this.playPrevious());
      session.setActionHandler("nexttrack", () => this.playNext());
    } catch {
      // Platform doesn't support MediaSession action handlers
    }
  }

  private updateMediaSessionMetadata(item: FeedItem): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator) || !window.MediaMetadata) return;
    try {
      const artwork = [];
      const coverUrl = item.coverImage || item.image || item.itunes?.image?.href;
      if (coverUrl) {
        artwork.push({ src: coverUrl, sizes: "512x512", type: "image/jpeg" });
      }
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: item.title,
        artist: item.author || item.feedTitle,
        album: item.feedTitle,
        artwork,
      });
    } catch {
      // Ignore MediaMetadata creation errors
    }
  }

  private updateMediaSessionPlaybackState(state: "playing" | "paused" | "none"): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = state;
    } catch {
      // Ignore
    }
  }

  public destroy(): void {
    this.stopProgressTracking();
    this.clearSleepTimer();

    if (this.audioElement) {
      this.saveProgress(true);
      this.audioElement.onplay = null;
      this.audioElement.onpause = null;
      this.audioElement.onended = null;
      this.audioElement.ontimeupdate = null;
      this.audioElement.onloadedmetadata = null;
      this.audioElement.onerror = null;
      this.audioElement.pause();
      this.audioElement.src = "";
      this.audioElement.remove();
    }

    this.currentItem = null;
    this.playlist = [];
    this.originalPlaylist = [];
    this.setPlaybackState("idle");
    this.updateMediaSessionPlaybackState("none");
  }
}
