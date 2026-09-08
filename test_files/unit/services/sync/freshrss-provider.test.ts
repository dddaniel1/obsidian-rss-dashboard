import { describe, expect, it, vi } from "vitest";
import { FreshRssProvider } from "../../../../src/services/sync/freshrss-provider";
import type { SyncRequest } from "../../../../src/services/sync/sync-provider";

describe("FreshRSS provider", () => {
  function setup(responses: { status: number; text: string }[]) {
    const request = vi.fn((_input: SyncRequest) => Promise.resolve(responses.shift()!));
    return { request, provider: new FreshRssProvider("https://rss.example/api/greader.php/", request) };
  }

  it("posts credentials and keeps authentication out of URLs", async () => {
    const { provider, request } = setup([{ status: 200, text: "SID=x\nAuth=secret-token\n" }]);
    await provider.login("用户", "private&password");
    expect(request.mock.calls[0][0]).toMatchObject({ method: "POST", url: "https://rss.example/api/greader.php/accounts/ClientLogin" });
    expect(new URLSearchParams(request.mock.calls[0][0].body).get("Passwd")).toBe("private&password");
  });

  it("rejects malformed subscription snapshots instead of treating them as empty", async () => {
    const { provider } = setup([{ status: 200, text: "Auth=x" }, { status: 200, text: "{}" }]);
    await provider.login("u", "p");
    await expect(provider.getSubscriptions()).rejects.toThrow("Invalid");
  });

  it("preserves article IDs and pagination tokens as strings", async () => {
    const { provider } = setup([
      { status: 200, text: "Auth=x" },
      { status: 200, text: JSON.stringify({ items: [{ id: "tag:google.com,2005:reader/item/ffffffffffffffff", title: "中文", origin: { streamId: "feed/1" }, categories: ["user/-/state/com.google/read"], summary: { content: "<p>Body</p>" }, published: 1 }], continuation: "18446744073709551615" }) },
    ]);
    await provider.login("u", "p");
    const page = await provider.getArticles({});
    expect(page.cursor).toBe("18446744073709551615");
    expect(page.articles[0]).toMatchObject({ id: "18446744073709551615", read: true, starred: false, title: "中文" });
  });

  it("encodes Chinese folders and sends explicit removal for unstar", async () => {
    const { provider, request } = setup([{ status: 200, text: "Auth=x" }, { status: 200, text: "token" }, { status: 200, text: "OK" }]);
    await provider.login("u", "p");
    await provider.execute({ id: "op", accountId: "a", kind: "article-state", articleId: "18446744073709551615", field: "starred", value: false });
    const body = new URLSearchParams(request.mock.calls[2][0].body);
    expect(body.get("i")).toBe("18446744073709551615");
    expect(body.get("r")).toBe("user/-/state/com.google/starred");
    expect(body.get("T")).toBe("token");
  });

  it("keeps audio enclosure URLs so podcast feeds stay playable", async () => {
    const { provider } = setup([
      { status: 200, text: "Auth=x" },
      {
        status: 200,
        text: JSON.stringify({
          items: [
            {
              id: "1687580273",
              title: "Episode 1",
              published: 1710000000,
              origin: { streamId: "feed/1" },
              categories: ["user/-/state/com.google/reading-list"],
              alternate: [{ href: "https://example.com/episode-1" }],
              summary: { content: "<p>Shownotes</p>" },
              enclosure: [{ href: "https://audio.example/episode-1.mp3", type: "audio/mpeg" }],
            },
          ],
        }),
      },
    ]);
    await provider.login("u", "p");
    const page = await provider.getArticles({});
    expect(page.articles[0].audioUrl).toBe("https://audio.example/episode-1.mp3");
  });

  it("keeps video enclosure URLs so video feeds stay playable", async () => {
    const { provider } = setup([
      { status: 200, text: "Auth=x" },
      {
        status: 200,
        text: JSON.stringify({
          items: [
            {
              id: "1687580274",
              title: "Video 1",
              published: 1710000001,
              origin: { streamId: "feed/1" },
              categories: ["user/-/state/com.google/reading-list"],
              alternate: [{ href: "https://example.com/video-1" }],
              summary: { content: "<p>Description</p>" },
              enclosure: [{ href: "https://media.example/video-1.mp4", type: "video/mp4" }],
            },
          ],
        }),
      },
    ]);
    await provider.login("u", "p");
    const page = await provider.getArticles({});
    expect(page.articles[0].videoUrl).toBe("https://media.example/video-1.mp4");
  });

  it("does not expose server response bodies or transport secrets in errors", async () => {
    const { provider } = setup([{ status: 401, text: "private-password" }]);
    await expect(provider.login("u", "private-password")).rejects.toThrow("Authentication failed");
    const request = vi.fn(() => Promise.reject(new Error("private-password")));
    const offline = new FreshRssProvider("https://rss.example/api/greader.php", request);
    await expect(offline.login("u", "private-password")).rejects.toThrow("Network request failed");
  });

  it("rejects embedded credentials and insecure remote endpoints", () => {
    expect(() => new FreshRssProvider("https://u:p@rss.example", vi.fn())).toThrow();
    expect(() => new FreshRssProvider("http://rss.example", vi.fn())).toThrow();
  });
});

