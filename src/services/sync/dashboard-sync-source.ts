import { Notice } from "obsidian";
import type RssDashboardPlugin from "../../../main";
import type { FeedItem, Folder, RssDashboardSettings } from "../../types/types";
import { MediaService } from "../media-service";
import { extractFirstImageSrc } from "../../components/article-list/utils/article-preview-utils";
import { SyncError } from "./sync-provider";
import type { SyncRuntime } from "./sync-runtime";
import type { SyncState } from "./sync-service";

type RemoteFolderView = Folder & { remoteId?: string };
export function remoteArticleId(guid: string, accountId: string): string | undefined {
  const prefix = "freshrss:" + accountId + ":";
  return guid.startsWith(prefix) ? guid.slice(prefix.length) : undefined;
}

/** A view-scoped adapter; the host's local settings are never replaced. */
export class DashboardSyncSource {
  readonly settings: RssDashboardSettings;
  private baseline: SyncState;
  private writes: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  /** Articles known to differ from baseline; avoids full-collection diffing. */
  private changedArticles = new Map<string, Partial<FeedItem>>();

  constructor(private readonly host: RssDashboardPlugin, readonly runtime: SyncRuntime) {
    const state = runtime.service?.snapshot();
    if (!state) throw new SyncError("Connect FreshRSS first", "invalid");
    this.settings = structuredClone(host.settings);
    this.baseline = state;
    this.refresh();
  }

  refresh(): void {
    if (this.pendingWrites) return;
    const state = this.runtime.service?.snapshot();
    if (!state) return;
    const names = new Map(state.folders.map((folder) => [folder.id, folder.name]));
    this.settings.folders = state.folders.map((folder): RemoteFolderView => ({ name: folder.name, subfolders: [], remoteId: folder.id }));
    this.settings.feeds = state.subscriptions.map((feed) => ({
      feedId: feed.id, title: feed.title, url: feed.url, folder: names.get(feed.folder) ?? "Uncategorized",
      lastUpdated: state.lastSuccess ?? 0, excludeFromRefresh: true, iconUrl: feed.iconUrl,
      items: Object.values(state.articles).filter((article) => article.feedId === feed.id).map((article): FeedItem => ({
        ...article, guid: "freshrss:" + state.accountId + ":" + article.id,
        feedUrl: feed.url, feedTitle: feed.title, description: article.content,
        pubDate: new Date(article.published * 1000).toISOString(),
        coverImage: extractFirstImageSrc(article.content) ?? "",
        ...describeFreshRssArticleMedia(article),
      })),
    }));
    if (this.settings.feeds.some((feed) => feed.folder === "Uncategorized") && !this.settings.folders.some((folder) => folder.name === "Uncategorized")) {
      this.settings.folders.push({ name: "Uncategorized", subfolders: [] });
    }
    const tags = new Map(this.settings.availableTags.map((tag) => [tag.name, tag]));
    for (const article of Object.values(state.articles)) for (const tag of article.tags ?? []) tags.set(tag.name, tag);
    this.settings.availableTags = [...tags.values()];
    this.baseline = state;
  }

  folderId(name: string): string {
    const folder = (this.settings.folders as RemoteFolderView[]).find((item) => item.name === name);
    return folder?.remoteId ?? (name && name !== "Uncategorized" ? "user/-/label/" + name : "");
  }

  persist(): Promise<void> {
    const desired = this.settings;
    this.pendingWrites++;
    const task = this.writes.then(async () => {
      const baseline = this.baseline;
      const folders = desired.folders as RemoteFolderView[];
      if (folders.some((folder) => folder.subfolders.length)) throw new SyncError("FreshRSS folders use a single level", "invalid");
      await this.runtime.perform(async (service) => {
        const removed = new Set(baseline.folders.filter((folder) => !folders.some((item) => item.remoteId === folder.id)).map((folder) => folder.id));
        const renamed = new Set<string>();
        for (const folder of folders) {
          const old = baseline.folders.find((item) => item.id === folder.remoteId);
          if (old && old.name !== folder.name) {
            await service.renameFolder(old.id, folder.name);
            renamed.add(old.id);
          } else if (!old && folder.name !== "Uncategorized" && !service.snapshot().folders.some((item) => item.name === folder.name)) {
            await service.createFolder(folder.name);
          }
        }
        for (const id of removed) await service.deleteFolder(id);
        for (const old of baseline.subscriptions) {
          const feed = desired.feeds.find((item) => item.feedId === old.id);
          if (!feed) {
            if (!removed.has(old.folder)) await service.unsubscribe(old.id);
            continue;
          }
          if (feed.url !== old.url) throw new SyncError("Change the feed URL in FreshRSS, then sync", "invalid");
          const folder = folders.find((item) => item.name === feed.folder);
          const folderId = folder?.remoteId ?? (feed.folder && feed.folder !== "Uncategorized" ? "user/-/label/" + feed.folder : "");
          if (feed.title !== old.title || (folderId !== old.folder && !removed.has(old.folder) && !renamed.has(old.folder))) {
            await service.editFeed(old.id, feed.title, folderId);
          }
          if (this.changedArticles.size > 0) {
            for (const [guid, updates] of this.changedArticles) {
              const id = remoteArticleId(guid, baseline.accountId);
              const previous = id ? baseline.articles[id] : undefined;
              const item = feed.items.find((entry) => entry.guid === guid);
              if (!id || !previous || !item) continue;
              for (const field of ["read", "starred"] as const) {
                if (updates[field] !== undefined && !!item[field] !== !!previous[field]) {
                  await service.setArticleState(id, field, !!item[field]);
                }
              }
              await service.updateLocalArticle(id, {
                tags: item.tags, saved: item.saved,
                savedFilePath: item.savedFilePath, playbackProgress: item.playbackProgress,
              });
            }
            this.changedArticles.clear();
          } else {
            for (const item of feed.items) {
              const id = remoteArticleId(item.guid, baseline.accountId);
              const previous = id ? baseline.articles[id] : undefined;
              if (!id || !previous) continue;
              for (const field of ["read", "starred"] as const) {
                if (!!item[field] !== !!previous[field]) await service.setArticleState(id, field, !!item[field]);
              }
              const updates = { tags: item.tags, saved: item.saved, savedFilePath: item.savedFilePath, playbackProgress: item.playbackProgress };
              const prior = { tags: previous.tags, saved: previous.saved, savedFilePath: previous.savedFilePath, playbackProgress: previous.playbackProgress };
              if (JSON.stringify(updates) !== JSON.stringify(prior)) await service.updateLocalArticle(id, updates);
            }
          }
        }
      });
      this.baseline = this.runtime.service!.snapshot();
    });
    this.writes = task.catch(() => {});
    return task.finally(() => {
      this.pendingWrites--;
      if (!this.pendingWrites) this.refresh();
    });
  }

  updateArticle(guid: string, updates: Partial<FeedItem>): Promise<void> {
    const article = this.settings.feeds.flatMap((feed) => feed.items).find((item) => item.guid === guid);
    if (article) Object.assign(article, updates);
    this.changedArticles.set(guid, { ...this.changedArticles.get(guid), ...updates });
    return this.persist();
  }

  createPluginAdapter(): RssDashboardPlugin {
    const plugin = Object.create(this.host) as RssDashboardPlugin;
    Object.defineProperty(plugin, "settings", { get: () => this.settings });
    plugin.saveSettings = () => this.persist();
    plugin.refreshFeeds = async () => { await this.runtime.sync(); this.refresh(); };
    plugin.refreshFailedFeeds = async () => { await this.runtime.sync(); this.refresh(); };
    plugin.refreshSelectedFeed = async () => { await this.runtime.sync(); this.refresh(); };
    plugin.refreshFeedsInFolder = async () => { await this.runtime.sync(); this.refresh(); };
    plugin.ensureFolderExists = async (name) => {
      if (this.settings.folders.some((folder) => folder.name === name)) return false;
      await this.runtime.perform((service) => service.createFolder(name));
      this.refresh();
      return true;
    };
    plugin.addSubfolder = async () => { new Notice("FreshRSS supports single-level folders"); };
    plugin.addFeed = async (title, url, folder) => {
      await this.runtime.perform((service) => service.subscribe(url, title, this.folderId(folder)));
      this.refresh();
      return true;
    };
    plugin.editFeed = async (feed, title, url, folder) => {
      if (url !== feed.url) throw new SyncError("Change the feed URL in FreshRSS, then sync", "invalid");
      if (feed.feedId) await this.runtime.perform((service) => service.editFeed(feed.feedId!, title, this.folderId(folder)));
      this.refresh();
    };
    plugin.updateArticle = async (guid, _url, updates) => { await this.updateArticle(guid, updates); };
    plugin.updatePlaybackProgress = (_url, guid, position, duration) => {
      void this.updateArticle(guid, { playbackProgress: { position, duration, lastUpdated: Date.now() } }).catch(() => new Notice("Could not save playback progress"));
    };
    plugin.removeCachedImagesForDeletedFeed = async () => {};
    plugin.importOpml = () => { new Notice("Import subscriptions in FreshRSS, then sync"); };
    plugin.exportOpml = () => { new Notice("Export this library from FreshRSS"); };
    plugin.activateDiscoverView = this.host.activateDiscoverView.bind(this.host);
    plugin.openSettingsToTab = this.host.openSettingsToTab.bind(this.host);
    plugin.openTagsSettings = this.host.openTagsSettings.bind(this.host);
    return plugin;
  }
}

function describeFreshRssArticleMedia(article: { link: string; audioUrl?: string; videoUrl?: string }): Partial<FeedItem> {
  const videoId = article.videoUrl ? undefined : MediaService.extractYouTubeVideoId(article.link);
  if (article.audioUrl) return { mediaType: "podcast" };
  if (article.videoUrl) return { mediaType: "video" };
  if (videoId) return { mediaType: "video", videoId };
  return { mediaType: "article" };
}
