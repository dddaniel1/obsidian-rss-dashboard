import { describe, expect, it } from "vitest";
import { SyncRuntime } from "../../../../src/services/sync/sync-runtime";
import type { SyncRequest } from "../../../../src/services/sync/sync-provider";

describe("Sync runtime", () => {
  function setup() {
    const files = new Map<string, string>();
    const io = { exists: (path: string) => Promise.resolve(files.has(path)), read: (path: string) => Promise.resolve(files.get(path)!), write: (path: string, value: string) => { files.set(path, value); return Promise.resolve(); } };
    const request = (input: SyncRequest) => Promise.resolve({ status: 200, text: input.url.endsWith("ClientLogin") ? "Auth=private-token" : input.url.includes("subscription/list") ? '{"subscriptions":[]}' : input.url.includes("tag/list") ? '{"tags":[]}' : input.url.includes("items/ids") ? '{"itemRefs":[]}' : '{"items":[]}' });
    return { io, request, files };
  }
  it("restores the account and keeps secrets out of public status", async () => {
    const { io, request, files } = setup();
    const runtime = new SyncRuntime(io, "sync", request);
    await runtime.load();
    await runtime.connect("https://example.com/api/greader.php", "alice", "private-password");
    await runtime.setAutomatic(false);
    runtime.stop();
    const restored = new SyncRuntime(io, "sync", request);
    await restored.load();
    expect(restored.account?.username).toBe("alice");
    expect(JSON.stringify(restored.account)).not.toContain("private-token");
    expect([...files.values()].join("")).not.toContain("private-password");
    restored.stop();
  });
  it("retains cached data while disconnecting and forgets both credential slots", async () => {
    const { io, request, files } = setup();
    const runtime = new SyncRuntime(io, "sync", request);
    await runtime.load();
    await runtime.connect("https://example.com/api/greader.php", "alice", "p");
    await runtime.service!.createFolder("Local");
    await runtime.disconnect();
    expect(runtime.service!.snapshot().folders[0].name).toBe("Local");
    expect([...files.values()].join("")).not.toContain("private-token");
    runtime.stop();
  });
});
