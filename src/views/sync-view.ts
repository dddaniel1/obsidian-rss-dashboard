import { ItemView, Modal, Notice, Setting, type App, type WorkspaceLeaf } from "obsidian";
import { SyncError } from "../services/sync/sync-provider";
import type { SyncRuntime } from "../services/sync/sync-runtime";
import type { SyncState, SyncService } from "../services/sync/sync-service";
import { sanitizeAndAppendHtml } from "../utils/safe-html";

export const SYNC_VIEW_TYPE = "rss-freshrss-library";
export interface SyncViewHost {
  app: App;
  syncRuntime?: SyncRuntime;
  openSyncView(): Promise<void>;
  openSyncSettings(): void;
  saveSyncArticle(id: string): Promise<void>;
}
type Field = { name: string; value: string; options?: Record<string, string> };

class SyncForm extends Modal {
  constructor(app: App, private readonly heading: string, private readonly fields: Field[], private readonly submit: (values: string[]) => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.heading });
    const values = this.fields.map((field) => field.value);
    this.fields.forEach((field, index) => {
      const setting = new Setting(this.contentEl).setName(field.name);
      if (field.options) {
        setting.addDropdown((input) => input.addOptions(field.options ?? {}).setValue(field.value).onChange((value) => { values[index] = value; }));
      } else setting.addText((input) => input.setValue(field.value).onChange((value) => { values[index] = value; }));
    });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Confirm").setCta().onClick(() => {
        button.setDisabled(true);
        void this.submit(values).then(() => this.close()).catch((error: unknown) => {
          new Notice(error instanceof SyncError ? error.message : "Could not save this change. Please retry.");
          button.setDisabled(false);
        });
      }));
  }
}

export class SyncView extends ItemView {
  private unsubscribe?: () => void;
  private folder = "*";
  private feed = "*";
  private filter = "all";
  private page = 0;
  private articleId?: string;
  constructor(leaf: WorkspaceLeaf, private readonly host: SyncViewHost) { super(leaf); }
  getViewType(): string { return SYNC_VIEW_TYPE; }
  getDisplayText(): string { return "FreshRSS"; }
  getIcon(): string { return "rss"; }
  onOpen(): Promise<void> {
    this.unsubscribe = this.host.syncRuntime?.subscribe(() => this.render());
    this.render();
    return Promise.resolve();
  }
  onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    return Promise.resolve();
  }
  private run(action: () => Promise<void>): void {
    void action().catch((error: unknown) => new Notice(error instanceof SyncError ? error.message : "The operation could not finish. Please retry."));
  }
  private act(action: (service: SyncService) => Promise<void>): Promise<void> {
    const runtime = this.host.syncRuntime;
    return runtime ? runtime.perform(action) : Promise.reject(new Error("Sync unavailable"));
  }
  private button(parent: HTMLElement, text: string, callback: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { text, attr: { type: "button" } });
    button.addEventListener("click", callback);
    return button;
  }
  render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("rss-sync-view");
    const runtime = this.host.syncRuntime;
    const state = runtime?.service?.snapshot();
    const toolbar = root.createDiv("rss-sync-toolbar");
    toolbar.createEl("h2", { text: "FreshRSS" });
    this.button(toolbar, "Settings", () => this.host.openSyncSettings());
    if (!state) {
      root.createEl("p", { text: "Connect FreshRSS to start your synchronized library." });
      this.button(root, "Connect FreshRSS", () => this.host.openSyncSettings());
      return;
    }
    this.button(toolbar, runtime?.busy ? "Syncing…" : "Sync now", () => this.run(() => runtime?.sync() ?? Promise.resolve())).disabled = !!runtime?.busy;
    root.createEl("p", { text: (runtime?.error || (runtime?.account?.connected ? "Connected" : "Offline library")) + " · Pending: " + state.operations.length, attr: { role: "status" } });
    if (this.articleId && state.articles[this.articleId]) {
      this.renderArticle(root, state, this.articleId);
      return;
    }
    const layout = root.createDiv("rss-sync-layout");
    this.renderLibrary(layout.createDiv("rss-sync-library"), state);
    this.renderArticles(layout.createDiv("rss-sync-articles"), state);
    if (state.conflicts.length) {
      const conflicts = root.createDiv("rss-sync-conflicts");
      conflicts.createEl("h3", { text: "Sync conflicts" });
      for (const conflict of state.conflicts) {
        new Setting(conflicts).setName(conflict.operation.kind).setDesc(conflict.reason)
          .addButton((button) => button.setButtonText("Accept remote state").onClick(() => this.run(() => this.act((service) => service.dismissConflict(conflict.operation.id)))));
      }
    }
  }
  private renderLibrary(root: HTMLElement, state: SyncState): void {
    this.button(root, "New folder", () => new SyncForm(this.app, "New folder", [{ name: "Name", value: "" }], (values) => this.act((service) => service.createFolder(values[0]))).open());
    const options = Object.fromEntries(state.folders.map((folder) => [folder.id, folder.name]));
    options[""] = "Uncategorized";
    this.button(root, "Subscribe", () => new SyncForm(this.app, "Subscribe to feed", [
      { name: "Feed URL", value: "" }, { name: "Title", value: "" }, { name: "Folder", value: this.folder === "*" ? "" : this.folder, options },
    ], (values) => this.act((service) => service.subscribe(values[0], values[1], values[2]))).open());
    new Setting(root).setName("Folder").addDropdown((input) => input.addOptions({ "*": "All folders", ...options }).setValue(this.folder).onChange((value) => {
      this.folder = value; this.feed = "*"; this.page = 0; this.render();
    }));
    const folder = state.folders.find((item) => item.id === this.folder);
    if (folder) {
      root.createEl("p", { text: folder.pending ? "Empty folder · Waiting for its first feed to sync" : folder.name });
      this.button(root, "Rename folder", () => new SyncForm(this.app, "Rename folder", [{ name: "Name", value: folder.name }], (values) => this.act((service) => service.renameFolder(folder.id, values[0]))).open());
      this.button(root, "Delete folder", () => new SyncForm(this.app, "Delete folder and move feeds to uncategorized?", [], async () => {
        await this.act((service) => service.deleteFolder(folder.id)); this.folder = "*"; this.render();
      }).open());
    }
    this.button(root, "All feeds", () => { this.feed = "*"; this.page = 0; this.render(); });
    for (const feed of state.subscriptions.filter((item) => this.folder === "*" || item.folder === this.folder)) {
      const row = root.createDiv("rss-sync-feed");
      this.button(row, feed.title || feed.url, () => { this.feed = feed.id; this.page = 0; this.render(); });
      this.button(row, "Edit", () => new SyncForm(this.app, "Edit subscription", [
        { name: "Title", value: feed.title }, { name: "Folder", value: feed.folder, options },
      ], (values) => this.act((service) => service.editFeed(feed.id, values[0], values[1]))).open());
      this.button(row, "Unsubscribe", () => new SyncForm(this.app, "Unsubscribe from " + feed.title + "?", [], () => this.act((service) => service.unsubscribe(feed.id))).open());
    }
  }
  private renderArticles(root: HTMLElement, state: SyncState): void {
    new Setting(root).setName("Articles").addDropdown((input) => input.addOptions({ all: "All", unread: "Unread", read: "Read", starred: "Starred" }).setValue(this.filter).onChange((value) => {
      this.filter = value; this.page = 0; this.render();
    }));
    const feeds = new Set(state.subscriptions.filter((feed) => (this.folder === "*" || feed.folder === this.folder) && (this.feed === "*" || feed.id === this.feed)).map((feed) => feed.id));
    const articles = Object.values(state.articles).filter((article) => feeds.has(article.feedId) && (this.filter === "all" || (this.filter === "unread" && !article.read) || (this.filter === "read" && article.read) || (this.filter === "starred" && article.starred))).sort((a, b) => b.published - a.published);
    const tools = root.createDiv("rss-sync-toolbar");
    this.button(tools, "Mark filtered articles read", () => this.run(() => this.act((service) => service.setManyArticleStates(articles.map((item) => item.id), "read", true))));
    this.button(tools, "Mark filtered articles unread", () => this.run(() => this.act((service) => service.setManyArticleStates(articles.map((item) => item.id), "read", false))));
    root.createEl("p", { text: articles.length + " cached articles" });
    this.page = Math.min(this.page, Math.max(0, Math.ceil(articles.length / 50) - 1));
    for (const article of articles.slice(this.page * 50, this.page * 50 + 50)) {
      const row = root.createDiv("rss-sync-article");
      this.button(row, article.title || "Untitled article", () => { this.articleId = article.id; this.render(); });
      row.createEl("small", { text: new Date(article.published * 1000).toLocaleDateString() });
      this.button(row, article.read ? "Mark unread" : "Mark read", () => this.run(() => this.act((service) => service.setArticleState(article.id, "read", !article.read))));
      this.button(row, article.starred ? "Unstar" : "Star", () => this.run(() => this.act((service) => service.setArticleState(article.id, "starred", !article.starred))));
    }
    if (!articles.length) root.createEl("p", { text: "No articles in this selection. Sync to download articles from FreshRSS." });
    const paging = root.createDiv("rss-sync-toolbar");
    this.button(paging, "Previous", () => { this.page--; this.render(); }).disabled = this.page === 0;
    paging.createSpan({ text: "Page " + (this.page + 1) });
    this.button(paging, "Next", () => { this.page++; this.render(); }).disabled = (this.page + 1) * 50 >= articles.length;
  }
  private renderArticle(root: HTMLElement, state: SyncState, id: string): void {
    const article = state.articles[id];
    const tools = root.createDiv("rss-sync-toolbar");
    this.button(tools, "Back to articles", () => { this.articleId = undefined; this.render(); });
    this.button(tools, article.read ? "Mark unread" : "Mark read", () => this.run(() => this.act((service) => service.setArticleState(id, "read", !article.read))));
    this.button(tools, article.starred ? "Unstar" : "Star", () => this.run(() => this.act((service) => service.setArticleState(id, "starred", !article.starred))));
    this.button(tools, article.saved ? "Open saved note" : "Save note", () => this.run(() => this.host.saveSyncArticle(id)));
    this.button(tools, "Local tags", () => new SyncForm(this.app, "Local article tags", [{ name: "Comma-separated tags", value: article.tags?.map((tag) => tag.name).join(", ") ?? "" }], (values) => this.act((service) => service.updateLocalArticle(id, { tags: [...new Set(values[0].split(",").map((name) => name.trim()).filter(Boolean))].map((name) => ({ name, color: "" })) }))).open());
    root.createEl("h1", { text: article.title });
    if (/^https?:\/\//i.test(article.link)) root.createEl("a", { text: "Open original", href: article.link, attr: { target: "_blank", rel: "noopener noreferrer" } });
    const content = root.createDiv("rss-sync-content");
    sanitizeAndAppendHtml(content, article.content, { mode: "rich" });
  }
}
