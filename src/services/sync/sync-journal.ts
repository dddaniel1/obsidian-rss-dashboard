export interface SyncStorageIO {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
}
interface Envelope {
  version: 1;
  revision: number;
  payload: string;
  checksum: string;
}
function checksum(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
function decode(text: string): Envelope {
  const envelope = JSON.parse(text) as Partial<Envelope>;
  if (envelope.version !== 1 || !Number.isSafeInteger(envelope.revision) || (envelope.revision ?? 0) < 1 || typeof envelope.payload !== "string" || envelope.checksum !== checksum(envelope.payload)) {
    throw new Error("Invalid sync journal");
  }
  JSON.parse(envelope.payload);
  return envelope as Envelope;
}

/** Alternating verified slots preserve the previous commit after interrupted writes. */
export class SyncJournal<T> {
  private revision = 0;
  private loaded = false;
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly io: SyncStorageIO, private readonly basePath: string) {}

  async load(): Promise<T | undefined> {
    const valid: Envelope[] = [];
    let existing = 0;
    for (const slot of ["a", "b"]) {
      const path = this.basePath + "." + slot + ".json";
      if (!await this.io.exists(path)) continue;
      existing++;
      // Read failures are not corruption: do not silently fall back on permission or I/O errors.
      const text = await this.io.read(path);
      try { valid.push(decode(text)); } catch { /* The other slot may still be intact. */ }
    }
    valid.sort((a, b) => b.revision - a.revision);
    if (!valid.length && existing) throw new Error("Cannot recover sync data. Restore a backup before reconnecting.");
    this.revision = valid[0]?.revision ?? 0;
    this.loaded = true;
    return valid[0] ? JSON.parse(valid[0].payload) as T : undefined;
  }

  save(value: T): Promise<void> {
    const payload = JSON.stringify(value);
    const task = this.writes.then(async () => {
      if (!this.loaded) await this.load();
      const revision = this.revision + 1;
      const envelope: Envelope = { version: 1, revision, payload, checksum: checksum(payload) };
      const path = this.basePath + (revision % 2 ? ".a.json" : ".b.json");
      await this.io.write(path, JSON.stringify(envelope));
      const stored = decode(await this.io.read(path));
      if (stored.revision !== revision || stored.payload !== payload) throw new Error("Sync data verification failed");
      this.revision = revision;
    });
    this.writes = task.catch(() => {});
    return task;
  }
}
