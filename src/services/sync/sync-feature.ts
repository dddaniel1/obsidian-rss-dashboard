import { normalizePath, requestUrl, type Plugin } from "obsidian";
import { SyncRuntime } from "./sync-runtime";
import type { SyncTransport } from "./sync-provider";
import { SyncView, SYNC_VIEW_TYPE, type SyncViewHost } from "../../views/sync-view";

export async function initializeSyncFeature(plugin: Plugin & SyncViewHost): Promise<void> {
  const directory = normalizePath((plugin.manifest.dir ?? plugin.app.vault.configDir + "/plugins/" + plugin.manifest.id) + "/freshrss");
  const adapter = plugin.app.vault.adapter;
  if (!await adapter.exists(directory)) await adapter.mkdir(directory);
  const transport: SyncTransport = async (input) => {
    let timer: number | undefined;
    try {
      return await Promise.race([
        requestUrl({ ...input, throw: false }).then((response) => ({ status: response.status, text: response.text })),
        new Promise<never>((_resolve, reject) => {
          timer = window.setTimeout(() => reject(new Error("Sync request timed out")), 30000);
        }),
      ]);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  };
  const runtime = new SyncRuntime(adapter, directory, transport);
  plugin.syncRuntime = runtime;
  plugin.register(() => runtime.stop());
  plugin.registerView(SYNC_VIEW_TYPE, (leaf) => new SyncView(leaf, plugin));
  plugin.addCommand({ id: "open-freshrss-library", name: "Open FreshRSS library", callback: () => { void plugin.openSyncView(); } });
  plugin.addCommand({ id: "sync-freshrss", name: "Sync FreshRSS", callback: () => { void runtime.sync().catch(() => {}); } });
  await runtime.load();
}
