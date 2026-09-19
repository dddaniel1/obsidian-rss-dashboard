import { setIcon } from "obsidian";
import type { FeedItem } from "../types/types";
import type { PodcastAudioService, PlaybackState } from "../services/podcast-audio-service";

export interface PodcastMiniPlayerOptions {
  container: HTMLElement;
  audioService: PodcastAudioService;
  theme?: string;
  onExpand?: (item: FeedItem) => void;
  onClose?: () => void;
}

export class PodcastMiniPlayer {
  private readonly container: HTMLElement;
  private readonly audioService: PodcastAudioService;
  private theme: string;
  private readonly onExpand?: (item: FeedItem) => void;
  private readonly onClose?: () => void;

  private rootEl: HTMLElement | null = null;
  private coverEl: HTMLImageElement | null = null;
  private coverPlaceholderEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private feedEl: HTMLElement | null = null;
  private playBtn: HTMLElement | null = null;
  private progressTrackEl: HTMLElement | null = null;
  private progressFilledEl: HTMLElement | null = null;
  private timeEl: HTMLElement | null = null;
  private speedBtn: HTMLElement | null = null;

  private unsubs: Array<() => void> = [];

  constructor(options: PodcastMiniPlayerOptions) {
    this.container = options.container;
    this.audioService = options.audioService;
    this.theme = options.theme || "obsidian";
    this.onExpand = options.onExpand;
    this.onClose = options.onClose;

    this.render();
    this.bindEvents();
    this.syncState();
  }

  public updateTheme(theme: string): void {
    this.theme = theme;
    if (this.rootEl) {
      this.rootEl.setAttribute("data-podcast-theme", theme);
    }
  }

  public show(): void {
    if (this.rootEl) {
      this.rootEl.removeClass("is-hidden");
    }
  }

  public hide(): void {
    if (this.rootEl) {
      this.rootEl.addClass("is-hidden");
    }
  }

  public getRootElement(): HTMLElement | null {
    return this.rootEl;
  }

  private render(): void {
    this.rootEl = this.container.createDiv({
      cls: "rss-podcast-mini-player is-hidden",
      attr: { "data-podcast-theme": this.theme },
    });

    // Top progress bar (click to seek)
    this.progressTrackEl = this.rootEl.createDiv({
      cls: "rss-mini-progress-track",
      attr: {
        role: "slider",
        tabindex: "0",
        "aria-label": "Playback progress",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": "0",
      },
    });
    this.progressFilledEl = this.progressTrackEl.createDiv({
      cls: "rss-mini-progress-filled",
    });

    this.progressTrackEl.onclick = (e: MouseEvent) => {
      this.handleProgressSeek(e);
    };

    // Main horizontal row
    const rowEl = this.rootEl.createDiv({ cls: "rss-mini-row" });

    // Left info (cover + title + feed)
    const infoSection = rowEl.createDiv({ cls: "rss-mini-info-section" });
    infoSection.onclick = () => {
      const current = this.audioService.getCurrentItem();
      if (current && this.onExpand) {
        this.onExpand(current);
      }
    };

    const coverWrapper = infoSection.createDiv({ cls: "rss-mini-cover-wrapper" });
    this.coverPlaceholderEl = coverWrapper.createDiv({ cls: "rss-mini-cover-placeholder" });
    setIcon(this.coverPlaceholderEl, "podcast");

    const textWrapper = infoSection.createDiv({ cls: "rss-mini-text-wrapper" });
    this.titleEl = textWrapper.createDiv({
      cls: "rss-mini-title",
      text: "No Episode",
    });
    this.feedEl = textWrapper.createDiv({
      cls: "rss-mini-feed",
      text: "",
    });

    // Center controls
    const controlsSection = rowEl.createDiv({ cls: "rss-mini-controls-section" });

    const rewindBtn = controlsSection.createDiv({
      cls: "rss-mini-rewind-btn clickable-icon",
      attr: {
        role: "button",
        tabindex: "0",
        title: "Rewind 15s",
        "aria-label": "Rewind 15 seconds",
      },
    });
    setIcon(rewindBtn, "rotate-ccw");
    rewindBtn.onclick = (e) => {
      e.stopPropagation();
      this.audioService.seekRelative(-15);
    };

    this.playBtn = controlsSection.createDiv({
      cls: "rss-mini-play-btn clickable-icon",
      attr: {
        role: "button",
        tabindex: "0",
        title: "Play/Pause",
        "aria-label": "Play/Pause",
      },
    });
    setIcon(this.playBtn, "play");
    this.playBtn.onclick = (e) => {
      e.stopPropagation();
      void this.audioService.togglePlayback();
    };

    const forwardBtn = controlsSection.createDiv({
      cls: "rss-mini-forward-btn clickable-icon",
      attr: {
        role: "button",
        tabindex: "0",
        title: "Forward 30s",
        "aria-label": "Forward 30 seconds",
      },
    });
    setIcon(forwardBtn, "rotate-cw");
    forwardBtn.onclick = (e) => {
      e.stopPropagation();
      this.audioService.seekRelative(30);
    };

    // Right actions (time + speed + expand + close)
    const actionsSection = rowEl.createDiv({ cls: "rss-mini-actions-section" });

    this.timeEl = actionsSection.createDiv({
      cls: "rss-mini-time",
      text: "00:00 / 00:00",
    });

    this.speedBtn = actionsSection.createDiv({
      cls: "rss-mini-speed-btn clickable-icon",
      attr: {
        role: "button",
        tabindex: "0",
        title: "Change playback speed",
        "aria-label": "Change playback speed",
      },
      text: "1.0×",
    });
    this.speedBtn.onclick = (e) => {
      e.stopPropagation();
      this.cycleSpeed();
    };

    const expandBtn = actionsSection.createDiv({
      cls: "rss-mini-expand-btn clickable-icon",
      attr: {
        role: "button",
        tabindex: "0",
        title: "Open episode details",
        "aria-label": "Open episode details",
      },
    });
    setIcon(expandBtn, "maximize-2");
    expandBtn.onclick = (e) => {
      e.stopPropagation();
      const current = this.audioService.getCurrentItem();
      if (current && this.onExpand) {
        this.onExpand(current);
      }
    };

    const closeBtn = actionsSection.createDiv({
      cls: "rss-mini-close-btn clickable-icon",
      attr: {
        role: "button",
        tabindex: "0",
        title: "Close player",
        "aria-label": "Close player",
      },
    });
    setIcon(closeBtn, "x");
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      this.audioService.pause();
      this.hide();
      if (this.onClose) {
        this.onClose();
      }
    };
  }

  private handleProgressSeek(e: MouseEvent): void {
    if (!this.progressTrackEl) return;
    const rect = this.progressTrackEl.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, clickX / rect.width));
    const duration = this.audioService.getDuration();
    if (duration > 0) {
      this.audioService.seek(fraction * duration);
    }
  }

  private cycleSpeed(): void {
    const speeds = [1, 1.25, 1.5, 1.75, 2, 0.75];
    const current = this.audioService.getPlaybackRate();
    const currentIndex = speeds.findIndex((s) => Math.abs(s - current) < 0.05);
    const nextIndex = (currentIndex + 1) % speeds.length;
    const nextSpeed = speeds[nextIndex];
    this.audioService.setPlaybackRate(nextSpeed);
  }

  private bindEvents(): void {
    this.unsubs.push(
      this.audioService.on("track-change", (item) => {
        if (item) {
          this.updateTrackInfo(item);
          this.show();
        } else {
          this.hide();
        }
      }),
    );

    this.unsubs.push(
      this.audioService.on("state-change", (state) => {
        this.updatePlaybackState(state);
        if (state === "playing" || state === "loading") {
          const current = this.audioService.getCurrentItem();
          if (current) {
            this.updateTrackInfo(current);
          }
          this.show();
        }
      }),
    );

    this.unsubs.push(
      this.audioService.on("time-update", (currentTime, duration) => {
        this.updateTime(currentTime, duration);
      }),
    );

    this.unsubs.push(
      this.audioService.on("rate-change", (rate) => {
        if (this.speedBtn) {
          this.speedBtn.textContent = `${rate}×`;
        }
      }),
    );
  }

  private syncState(): void {
    const current = this.audioService.getCurrentItem();
    if (current) {
      this.updateTrackInfo(current);
      this.show();
    } else {
      this.hide();
    }
    this.updatePlaybackState(this.audioService.getPlaybackState());
    this.updateTime(this.audioService.getCurrentTime(), this.audioService.getDuration());
    if (this.speedBtn) {
      this.speedBtn.textContent = `${this.audioService.getPlaybackRate()}×`;
    }
  }

  private updateTrackInfo(item: FeedItem): void {
    if (this.titleEl) {
      this.titleEl.textContent = item.title;
      this.titleEl.setAttribute("title", item.title);
    }
    if (this.feedEl) {
      this.feedEl.textContent = item.feedTitle || item.author || "";
    }

    const coverUrl = item.coverImage || item.image || item.itunes?.image?.href;
    const wrapper = this.rootEl?.querySelector(".rss-mini-cover-wrapper") as HTMLElement | null;
    if (wrapper) {
      if (coverUrl && activeDocument.defaultView) {
        if (!this.coverEl) {
          this.coverEl = new activeDocument.defaultView.Image();
          this.coverEl.classList.add("rss-mini-cover");
          this.coverEl.alt = item.title;
          wrapper.appendChild(this.coverEl);
        }
        this.coverEl.src = coverUrl;
        if (this.coverPlaceholderEl) {
          this.coverPlaceholderEl.addClass("is-hidden");
        }
      } else {
        if (this.coverEl) {
          this.coverEl.remove();
          this.coverEl = null;
        }
        if (this.coverPlaceholderEl) {
          this.coverPlaceholderEl.removeClass("is-hidden");
        }
      }
    }
  }

  private updatePlaybackState(state: PlaybackState): void {
    if (!this.playBtn) return;
    const isPlaying = state === "playing";
    setIcon(this.playBtn, isPlaying ? "pause" : "play");
    this.playBtn.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
    this.playBtn.setAttribute("title", isPlaying ? "Pause" : "Play");
  }

  private updateTime(currentTime: number, duration: number): void {
    if (this.progressFilledEl && duration > 0) {
      const pct = Math.max(0, Math.min(100, (currentTime / duration) * 100));
      this.progressFilledEl.style.width = `${pct}%`;
      this.progressTrackEl?.setAttribute("aria-valuenow", Math.round(pct).toString());
    }

    if (this.timeEl) {
      const curStr = this.formatTime(currentTime);
      const durStr = duration > 0 ? this.formatTime(duration) : "--:--";
      this.timeEl.textContent = `${curStr} / ${durStr}`;
    }
  }

  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const hrs = Math.floor(mins / 60);
    if (hrs > 0) {
      const remMins = mins % 60;
      return `${hrs}:${remMins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  public destroy(): void {
    this.unsubs.forEach((unsub) => unsub());
    this.unsubs = [];
    if (this.rootEl) {
      this.rootEl.remove();
      this.rootEl = null;
    }
  }
}
