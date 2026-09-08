import { FreshRssProvider } from "./freshrss-provider";
import { SyncJournal, type SyncStorageIO } from "./sync-journal";
import { SyncError, type SyncTransport } from "./sync-provider";
import { SyncService, emptySyncState, type SyncState } from "./sync-service";

interface Account {
  id: string;
  endpoint: string;
  username: string;
  automatic: boolean;
  connected: boolean;
  auth: string;
}
export class SyncRuntime {
  service?: SyncService;
  error = "";
  busy = false;
  private config?: Account;
  private configJournal: SyncJournal<Account>;
  private timer?: number;
  private stopped = false;
  private failures = 0;
  private listeners = new Set<() => void>();
  private active?: Promise<void>;

  constructor(private readonly io: SyncStorageIO, private readonly directory: string, private readonly transport: SyncTransport) {
    this.configJournal = new SyncJournal(io, directory + "/account");
  }

  get account(): Omit<Account, "auth"> | undefined {
    if (!this.config) return undefined;
    const { auth: _auth, ...account } = this.config;
    return account;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  async load(): Promise<void> {
    this.config = await this.configJournal.load();
    if (this.config) await this.loadService(this.config.id);
    this.schedule(5000);
  }

  private async loadService(id: string): Promise<void> {
    const journal = new SyncJournal<SyncState>(this.io, this.directory + "/state-" + id);
    const saved = await journal.load();
    if (saved && (saved.version !== 1 || saved.accountId !== id || !Array.isArray(saved.operations))) throw new SyncError("Unsupported sync data", "invalid");
    this.service = new SyncService(saved ?? emptySyncState(id), (state) => journal.save(state));
  }

  async testConnection(endpoint: string, username: string, password: string): Promise<void> {
    const provider = new FreshRssProvider(endpoint, this.transport);
    await provider.login(username, password);
    await provider.getFolders();
    await provider.getSubscriptions();
  }

  async connect(endpoint: string, username: string, password: string): Promise<void> {
    if (this.busy) throw new SyncError("Wait for the current sync to finish", "conflict");
    const normalized = endpoint.replace(/\/+$/, "");
    if (this.config && (this.config.endpoint !== normalized || this.config.username !== username)) {
      throw new SyncError("This sync area belongs to another account. Use its existing API address and username.", "conflict");
    }
    const provider = new FreshRssProvider(normalized, this.transport);
    await provider.login(username, password);
    await provider.getSubscriptions();
    const config: Account = { id: this.config?.id ?? window.crypto.randomUUID(), endpoint: normalized, username, auth: provider.getSession(), connected: true, automatic: this.config?.automatic ?? true };
    await this.configJournal.save(config);
    this.config = config;
    await this.loadService(config.id);
    this.error = "";
    this.emit();
    this.schedule(5000);
  }

  async disconnect(): Promise<void> {
    if (this.busy) throw new SyncError("Wait for the current sync to finish", "conflict");
    if (!this.config) return;
    const config = { ...this.config, auth: "", connected: false };
    await this.configJournal.save(config);
    // Replace both recovery slots so disconnect also forgets the previous session.
    await this.configJournal.save(config);
    this.config = config;
    this.clearTimer();
    this.emit();
  }

  async setAutomatic(automatic: boolean): Promise<void> {
    if (!this.config) return;
    const config = { ...this.config, automatic };
    await this.configJournal.save(config);
    this.config = config;
    this.schedule();
    this.emit();
  }

  async perform(action: (service: SyncService) => Promise<void>): Promise<void> {
    if (!this.service) throw new SyncError("Connect an account first", "invalid");
    await action(this.service);
    this.emit();
    this.schedule(1000);
  }

  sync(): Promise<void> {
    if (this.active) return this.active;
    const task = this.run();
    this.active = task;
    void task.finally(() => { this.active = undefined; }).catch(() => {});
    return task;
  }

  private async run(): Promise<void> {
    if (!this.config?.connected || !this.service || this.stopped) return;
    this.clearTimer();
    this.busy = true;
    this.error = "";
    this.emit();
    try {
      const provider = new FreshRssProvider(this.config.endpoint, this.transport);
      provider.restoreSession(this.config.auth);
      await this.service.synchronize(provider);
      this.failures = 0;
    } catch (error) {
      this.error = error instanceof SyncError ? error.message : "Sync could not finish. Check the connection and available storage, then retry.";
      this.failures++;
      throw error;
    } finally {
      this.busy = false;
      this.emit();
      this.schedule(this.failures ? Math.min(300000, 10000 * 2 ** Math.min(this.failures, 5)) : 300000);
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delay = 300000): void {
    this.clearTimer();
    if (this.stopped || !this.config?.connected || !this.config.automatic) return;
    this.timer = window.setTimeout(() => { void this.sync().catch(() => {}); }, delay);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.listeners.clear();
  }
}
