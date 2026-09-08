import { ItemView, type App, type WorkspaceLeaf } from "obsidian";
import type { SyncRuntime } from "../services/sync/sync-runtime";

export const SYNC_VIEW_TYPE = "rss-freshrss-library";
export interface SyncViewHost {
  app: App;
  syncRuntime?: SyncRuntime;
  openSyncView(): Promise<void>;
  openSyncSettings(): void;
  saveSyncArticle(id: string): Promise<void>;
}

/** Redirect legacy preview workspace tabs into the existing RSS dashboard. */
export class SyncView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly host: SyncViewHost) { super(leaf); }
  getViewType(): string { return SYNC_VIEW_TYPE; }
  getDisplayText(): string { return "RSS dashboard"; }
  async onOpen(): Promise<void> {
    await this.host.openSyncView();
    this.leaf.detach();
  }
}