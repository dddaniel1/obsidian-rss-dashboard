import { describe, expect, it } from "vitest";
import { SyncOutbox } from "../../../../src/services/sync/sync-outbox";

describe("SyncOutbox", () => {
  it("persists an operation before exposing it for transmission", async () => {
    const snapshots: unknown[] = [];
    const queue = new SyncOutbox([], async (items) => { snapshots.push(items); });
    await queue.enqueue({ id: "one", accountId: "a", kind: "article-state", articleId: "18446744073709551615", field: "read", value: true });
    expect(snapshots).toEqual([queue.list()]);
    expect(queue.list()[0]).toMatchObject({ articleId: "18446744073709551615" });
  });

  it("preserves the previous durable queue when persistence fails", async () => {
    const queue = new SyncOutbox([], () => Promise.reject(new Error("Disk full")));
    await expect(queue.enqueue({ id: "one", accountId: "a", kind: "article-state", articleId: "1", field: "starred", value: true })).rejects.toThrow("Disk full");
    expect(queue.list()).toEqual([]);
  });

  it("keeps a newer action when an older in-flight action is acknowledged", async () => {
    const queue = new SyncOutbox([], () => Promise.resolve());
    await queue.enqueue({ id: "one", accountId: "a", kind: "article-state", articleId: "1", field: "read", value: true });
    const sent = queue.list()[0];
    await queue.enqueue({ id: "two", accountId: "a", kind: "article-state", articleId: "1", field: "read", value: false });
    await queue.acknowledge(sent.id);
    expect(queue.list()).toEqual([expect.objectContaining({ id: "two", value: false })]);
  });

  it("serializes concurrent writes and survives reconstruction", async () => {
    let durable: ReturnType<SyncOutbox["list"]> = [];
    const queue = new SyncOutbox([], (items) => { durable = items; return Promise.resolve(); });
    await Promise.all([
      queue.enqueue({ id: "one", accountId: "a", kind: "article-state", articleId: "1", field: "read", value: true }),
      queue.enqueue({ id: "two", accountId: "b", kind: "article-state", articleId: "1", field: "starred", value: true }),
    ]);
    const restored = new SyncOutbox(durable, () => Promise.resolve());
    expect(restored.list().map((item) => item.accountId)).toEqual(["a", "b"]);
    const snapshot = restored.list();
    snapshot.length = 0;
    expect(restored.list()).toHaveLength(2);
  });

  it("does not lose an operation if acknowledging it cannot be persisted", async () => {
    let fail = false;
    const queue = new SyncOutbox([], () => fail ? Promise.reject(new Error("Disk full")) : Promise.resolve());
    await queue.enqueue({ id: "one", accountId: "a", kind: "article-state", articleId: "1", field: "read", value: true });
    fail = true;
    await expect(queue.acknowledge("one")).rejects.toThrow("Disk full");
    expect(queue.list()).toHaveLength(1);
  });
});
