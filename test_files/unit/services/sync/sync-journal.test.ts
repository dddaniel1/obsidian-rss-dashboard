import { describe, expect, it } from "vitest";
import { SyncJournal } from "../../../../src/services/sync/sync-journal";

describe("Sync journal", () => {
  function storage() {
    const files = new Map<string, string>();
    return { files, io: { exists: (path: string) => Promise.resolve(files.has(path)), read: (path: string) => Promise.resolve(files.get(path)!), write: (path: string, value: string) => { files.set(path, value); return Promise.resolve(); } } };
  }
  it("recovers the previous committed state if the newest slot is damaged", async () => {
    const { files, io } = storage();
    const journal = new SyncJournal<{ count: number }>(io, "sync");
    await journal.save({ count: 1 });
    await journal.save({ count: 2 });
    files.set("sync.b.json", "{partial");
    expect(await new SyncJournal<{ count: number }>(io, "sync").load()).toEqual({ count: 1 });
  });
  it("does not replace corrupt existing storage with empty state", async () => {
    const { files, io } = storage();
    files.set("sync.a.json", "broken");
    await expect(new SyncJournal(io, "sync").load()).rejects.toThrow("recover");
  });
  it("detects truncated writes before acknowledging persistence", async () => {
    const { files, io } = storage();
    const journal = new SyncJournal(io, "sync");
    await journal.save({ count: 1 });
    io.write = (path, _value) => { files.set(path, "{}"); return Promise.resolve(); };
    await expect(journal.save({ count: 2 })).rejects.toThrow();
    expect(await new SyncJournal(io, "sync").load()).toEqual({ count: 1 });
  });
});
