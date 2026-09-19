import { describe, expect, it, vi } from "vitest";
import { ImageRecoveryService } from "../../../src/services/image-recovery-service";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]).buffer;

function response(
  status: number,
  contentType: string,
  arrayBuffer: ArrayBuffer = new ArrayBuffer(0),
) {
  return {
    status,
    headers: { "content-type": contentType },
    arrayBuffer,
  };
}

describe("ImageRecoveryService", () => {
  it("retries a blocked image with its full article URL as Referer", async () => {
    const fetchImage = vi
      .fn()
      .mockResolvedValueOnce(response(403, "text/html"))
      .mockResolvedValueOnce(response(200, "image/png", PNG_BYTES));
    const createObjectUrl = vi.fn(() => "blob:recovered-image");
    const service = new ImageRecoveryService({
      fetchImage,
      fetchImageWithUserAgent: vi.fn().mockResolvedValue(null),
      createObjectUrl,
      revokeObjectUrl: vi.fn(),
    });

    const lease = await service.acquire(
      "https://cdn.example.com/image.png",
      "https://news.example.com/posts/42#comments",
    );

    expect(lease?.url).toBe("blob:recovered-image");
    expect(fetchImage).toHaveBeenNthCalledWith(1, {
      url: "https://cdn.example.com/image.png",
      headers: { Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      method: "GET",
      throw: false,
    });
    expect(fetchImage).toHaveBeenNthCalledWith(2, {
      url: "https://cdn.example.com/image.png",
      headers: {
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        Referer: "https://news.example.com/posts/42",
      },
      method: "GET",
      throw: false,
    });
  });

  it("does not retry a missing image with different Referers", async () => {
    const fetchImage = vi
      .fn()
      .mockResolvedValue(response(404, "text/html"));
    const service = new ImageRecoveryService({
      fetchImage,
      fetchImageWithUserAgent: vi.fn().mockResolvedValue(null),
      createObjectUrl: vi.fn(),
      revokeObjectUrl: vi.fn(),
    });

    await expect(
      service.acquire(
        "https://cdn.example.com/missing.png",
        "https://news.example.com/posts/42",
      ),
    ).resolves.toBeNull();
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it("falls back to the article origin when the full article Referer is rejected", async () => {
    const fetchImage = vi
      .fn()
      .mockResolvedValueOnce(response(403, "text/html"))
      .mockResolvedValueOnce(response(403, "text/html"))
      .mockResolvedValueOnce(response(200, "image/png", PNG_BYTES));
    const service = new ImageRecoveryService({
      fetchImage,
      fetchImageWithUserAgent: vi.fn().mockResolvedValue(null),
      createObjectUrl: vi.fn(() => "blob:origin-recovered"),
      revokeObjectUrl: vi.fn(),
    });

    await expect(
      service.acquire(
        "https://cdn.example.com/image.png",
        "https://news.example.com/posts/42",
      ),
    ).resolves.toMatchObject({ url: "blob:origin-recovered" });
    expect(fetchImage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        headers: expect.objectContaining({ Referer: "https://news.example.com/" }),
      }),
    );
  });

  it("treats HTTP 418 as hotlink protection and retries with the article Referer", async () => {
    const fetchImage = vi
      .fn()
      .mockResolvedValueOnce(response(418, "text/html"))
      .mockResolvedValueOnce(response(200, "image/png", PNG_BYTES));
    const service = new ImageRecoveryService({
      fetchImage,
      fetchImageWithUserAgent: vi.fn().mockResolvedValue(null),
      createObjectUrl: vi.fn(() => "blob:418-recovered"),
      revokeObjectUrl: vi.fn(),
    });

    await expect(
      service.acquire(
        "https://img.example.com/poster.png",
        "https://news.example.com/posts/42",
      ),
    ).resolves.toMatchObject({ url: "blob:418-recovered" });
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it("falls back to the image host origin when the article host is unrelated", async () => {
    const fetchImage = vi
      .fn()
      .mockResolvedValueOnce(response(403, "text/html"))
      .mockResolvedValueOnce(response(403, "text/html"))
      .mockResolvedValueOnce(response(403, "text/html"))
      .mockResolvedValueOnce(response(200, "image/png", PNG_BYTES));
    const service = new ImageRecoveryService({
      fetchImage,
      fetchImageWithUserAgent: vi.fn().mockResolvedValue(null),
      createObjectUrl: vi.fn(() => "blob:image-origin-recovered"),
      revokeObjectUrl: vi.fn(),
    });

    await expect(
      service.acquire(
        "https://images.example-cdn.com/photo.jpg",
        "https://bridge.example.net/feed/42",
      ),
    ).resolves.toMatchObject({ url: "blob:image-origin-recovered" });
    expect(fetchImage).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        headers: expect.objectContaining({
          Referer: "https://images.example-cdn.com/",
        }),
      }),
    );
  });

  it("uses the verified SSPAI RSS image host when Referer requests remain blocked", async () => {
    const fetchImage = vi
      .fn()
      .mockResolvedValueOnce(response(403, "text/html"))
      .mockRejectedValueOnce(new Error("Referer header is not allowed"))
      .mockRejectedValueOnce(new Error("Referer header is not allowed"))
      .mockResolvedValueOnce(response(403, "text/html"))
      .mockResolvedValueOnce(response(200, "image/png", PNG_BYTES));
    const service = new ImageRecoveryService({
      fetchImage,
      fetchImageWithUserAgent: vi.fn().mockResolvedValue(null),
      createObjectUrl: vi.fn(() => "blob:sspai-fallback"),
      revokeObjectUrl: vi.fn(),
    });

    await expect(
      service.acquire(
        "https://cdnfile.sspai.com/2026/article/image.png?format=webp",
        "https://sspai.com/post/114641",
      ),
    ).resolves.toMatchObject({ url: "blob:sspai-fallback" });
    expect(fetchImage).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        url: "https://rssfile.sspai.com/2026/article/image.png?format=webp",
      }),
    );
  });

  it("retries a blocked candidate through Node with a User-Agent header", async () => {
    const fetchImage = vi
      .fn()
      .mockResolvedValue(response(567, "text/html"));
    const fetchImageWithUserAgent = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(response(200, "image/png", PNG_BYTES));
    const service = new ImageRecoveryService({
      fetchImage,
      fetchImageWithUserAgent,
      createObjectUrl: vi.fn(() => "blob:user-agent-recovered"),
      revokeObjectUrl: vi.fn(),
    });

    await expect(
      service.acquire(
        "https://image.coolapk.com/photo.jpg",
        "https://bridge.example.net/feed/42",
      ),
    ).resolves.toMatchObject({ url: "blob:user-agent-recovered" });
    expect(fetchImage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        headers: expect.objectContaining({
          Referer: "https://bridge.example.net/feed/42",
        }),
      }),
    );
    expect(fetchImageWithUserAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        headers: expect.objectContaining({
          Referer: "https://bridge.example.net/feed/42",
          "User-Agent": expect.stringContaining("Mozilla/5.0"),
        }),
      }),
    );
  });

  it("shares one recovery request and revokes the object URL after every lease is released", async () => {
    const fetchImage = vi
      .fn()
      .mockResolvedValue(response(200, "image/png", PNG_BYTES));
    const revokeObjectUrl = vi.fn();
    const service = new ImageRecoveryService({
      fetchImage,
      fetchImageWithUserAgent: vi.fn().mockResolvedValue(null),
      createObjectUrl: vi.fn(() => "blob:shared-image"),
      revokeObjectUrl,
    });

    const [first, second] = await Promise.all([
      service.acquire("https://cdn.example.com/shared.png", "https://example.com/a"),
      service.acquire("https://cdn.example.com/shared.png", "https://example.com/a"),
    ]);

    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(first?.url).toBe(second?.url);
    first?.release();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    second?.release();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:shared-image");
  });

  it("rejects successful HTML responses instead of displaying them as images", async () => {
    const fetchImage = vi
      .fn()
      .mockResolvedValue(response(200, "text/html", new TextEncoder().encode("blocked").buffer));
    const createObjectUrl = vi.fn();
    const service = new ImageRecoveryService({
      fetchImage,
      fetchImageWithUserAgent: vi.fn().mockResolvedValue(null),
      createObjectUrl,
      revokeObjectUrl: vi.fn(),
    });

    await expect(
      service.acquire("https://cdn.example.com/image.png", ""),
    ).resolves.toBeNull();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });
});
