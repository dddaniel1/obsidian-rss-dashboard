import { Notice, Setting } from "obsidian";
import { SyncError } from "../../services/sync/sync-provider";
import type { SyncRuntime } from "../../services/sync/sync-runtime";

export interface SyncSettingsHost {
  syncRuntime?: SyncRuntime;
  openSyncView(): Promise<void>;
}
export function renderSyncSettingsTab(container: HTMLElement, host: SyncSettingsHost): () => void {
  const runtime = host.syncRuntime;
  if (!runtime) {
    container.createEl("p", { text: "Sync could not initialize. Reload the plugin after checking storage access." });
    return () => {};
  }
  let endpoint = runtime.account?.endpoint ?? "";
  let username = runtime.account?.username ?? "";
  let password = "";
  new Setting(container).setName("FreshRSS").setDesc("Keep a separate subscription library synchronized with your FreshRSS server. Local subscriptions are unchanged.");
  new Setting(container).setName("API address").setDesc("Use the API address ending in /api/greader.php shown by FreshRSS.").addText((text) => {
    text.setPlaceholder("https://example.com/api/greader.php").setValue(endpoint).onChange((value) => { endpoint = value.trim(); });
  });
  new Setting(container).setName("Username").addText((text) => {
    text.setValue(username).onChange((value) => { username = value.trim(); });
  });
  let passwordInput: HTMLInputElement | undefined;
  new Setting(container).setName("API password").setDesc("Use the dedicated API password. Only the resulting session token is retained in separate plugin files; it is excluded from plugin exports.").addText((text) => {
    text.inputEl.type = "password";
    passwordInput = text.inputEl;
    text.onChange((value) => { password = value; });
  });
  const status = container.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
  const showStatus = () => {
    const state = runtime.service?.snapshot();
    status.setText([
      runtime.busy ? "Syncing…" : runtime.account?.connected ? "Connected" : "Disconnected",
      "Pending: " + (state?.operations.length ?? 0),
      "Last success: " + (state?.lastSuccess ? new Date(state.lastSuccess).toLocaleString() : "Never"),
      runtime.error,
    ].filter(Boolean).join(" · "));
  };
  const run = (action: () => Promise<void>, success?: string) => {
    void action().then(() => { if (success) new Notice(success); showStatus(); }).catch((error: unknown) => {
      new Notice(error instanceof SyncError ? error.message : "The operation could not finish. Check storage and connection, then retry.");
      showStatus();
    });
  };
  new Setting(container)
    .addButton((button) => button.setButtonText("Test connection").onClick(() => {
      run(() => runtime.testConnection(endpoint, username, password), "Connection succeeded");
    }))
    .addButton((button) => button.setButtonText("Connect").setCta().onClick(() => {
      run(async () => {
        await runtime.connect(endpoint, username, password);
        password = "";
        if (passwordInput) passwordInput.value = "";
      }, "Account connected");
    }));
  new Setting(container).setName("Automatic sync").setDesc("Sync every five minutes while the plugin is running; retry temporary failures automatically.").addToggle((toggle) => {
    toggle.setValue(runtime.account?.automatic ?? true).onChange((value) => { run(() => runtime.setAutomatic(value)); });
  });
  new Setting(container)
    .addButton((button) => button.setButtonText("Sync now").onClick(() => { run(() => runtime.sync()); }))
    .addButton((button) => button.setButtonText("Open FreshRSS library").onClick(() => { run(() => host.openSyncView()); }))
    .addButton((button) => button.setButtonText("Disconnect").onClick(() => { run(() => runtime.disconnect(), "Disconnected; cached articles remain available"); }));
  showStatus();
  return runtime.subscribe(showStatus);
}
