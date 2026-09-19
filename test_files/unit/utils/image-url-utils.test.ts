import { describe, it, expect } from "vitest";
import {
  isLatexFormulaImage,
  optimizeImageUrl,
  resolveArticleImageBaseUrl,
  resolveSrcsetUrls,
  retryImageWithOriginReferrer,
  retryLazyImageSource,
} from "../../../src/utils/image-url-utils.js";

describe("isLatexFormulaImage", () => {
  it("recognizes WordPress LaTeX images by class", () => {
    expect(
      isLatexFormulaImage(
        "https://example.com/rendered-formula.png",
        "alignnone latex size-full",
      ),
    ).toBe(true);
  });

  it("recognizes persisted WordPress LaTeX image URLs without a class", () => {
    expect(
      isLatexFormulaImage(
        "https://s0.wp.com/latex.php?latex=%7Bx%7D&bg=ffffff&fg=000000",
      ),
    ).toBe(true);
  });

  it("does not classify ordinary WordPress images as formulas", () => {
    expect(
      isLatexFormulaImage(
        "https://i0.wp.com/example.com/wp-content/uploads/photo.jpg?w=600",
        "wp-post-image",
      ),
    ).toBe(false);
  });
});

describe("optimizeImageUrl", () => {
  it("rewrites Brightspot crop URLs without offset", () => {
    const input =
      "https://media.npr.brightspotcdn.com/dims4/default/8552x5292/legacy_icon.jpg";
    const expected =
      "https://media.npr.brightspotcdn.com/dims4/default/legacy_icon.jpg";
    expect(optimizeImageUrl(input)).toBe(expected);
  });

  it("rewrites Brightspot crop URLs with +0+0 offset", () => {
    const input =
      "https://media.npr.brightspotcdn.com/dims4/default/8552x5292+0+0/legacy_icon.jpg";
    const expected =
      "https://media.npr.brightspotcdn.com/dims4/default/legacy_icon.jpg";
    expect(optimizeImageUrl(input)).toBe(expected);
  });

  it("rewrites Brightspot resize URLs with ! delimiter", () => {
    const input =
      "https://media.npr.brightspotcdn.com/dims4/default/resize/8552x5292!/legacy_icon.jpg";
    const expected =
      "https://media.npr.brightspotcdn.com/dims4/default/resize/600x/legacy_icon.jpg";
    expect(optimizeImageUrl(input)).toBe(expected);
  });

  it("rewrites Brightspot resize URLs without ! delimiter", () => {
    const input =
      "https://media.npr.brightspotcdn.com/dims4/default/resize/8552x5292/legacy_icon.jpg";
    const expected =
      "https://media.npr.brightspotcdn.com/dims4/default/resize/600x/legacy_icon.jpg";
    expect(optimizeImageUrl(input)).toBe(expected);
  });

  it("rewrites Brightspot crop URLs on media.npr.org with +0+0 offset", () => {
    const input =
      "https://media.npr.org/assets/img/2024/01/15/test.jpg/crop/8552x5292+0+0/medium.jpg";
    const expected =
      "https://media.npr.org/assets/img/2024/01/15/test.jpg/medium.jpg";
    expect(optimizeImageUrl(input)).toBe(expected);
  });

  it("rewrites Brightspot resize URLs on media.npr.org with ! delimiter", () => {
    const input =
      "https://media.npr.org/assets/img/2024/01/15/test.jpg/resize/8552x5292!/medium.jpg";
    const expected =
      "https://media.npr.org/assets/img/2024/01/15/test.jpg/resize/600x/medium.jpg";
    expect(optimizeImageUrl(input)).toBe(expected);
  });

  it("rewrites Brightspot resize URLs on media.npr.org without ! delimiter", () => {
    const input =
      "https://media.npr.org/assets/img/2024/01/15/test.jpg/resize/8552x5292/medium.jpg";
    const expected =
      "https://media.npr.org/assets/img/2024/01/15/test.jpg/resize/600x/medium.jpg";
    expect(optimizeImageUrl(input)).toBe(expected);
  });

  it("does not mangle non-Brightspot URLs", () => {
    const url = "https://example.com/image.jpg";
    expect(optimizeImageUrl(url)).toBe(url);
  });

  it("leaves empty input as empty", () => {
    expect(optimizeImageUrl("")).toBe("");
  });
});

describe("retryLazyImageSource", () => {
  it("replaces a failed placeholder with its retained data-src once", () => {
    const image = document.createElement("img");
    image.setAttribute("src", "data:image/gif;base64,placeholder");
    image.setAttribute("data-src", "https://cdn.example.com/article.png");
    image.setAttribute("srcset", "https://cdn.example.com/other.png 2x");

    expect(retryLazyImageSource(image)).toBe(true);
    expect(image.getAttribute("src")).toBe(
      "https://cdn.example.com/article.png",
    );
    expect(image.hasAttribute("srcset")).toBe(false);
    expect(retryLazyImageSource(image)).toBe(false);
  });
});

describe("retryImageWithOriginReferrer", () => {
  it("retries one remote URL with an origin-only referrer policy", () => {
    const image = document.createElement("img");
    image.setAttribute("src", "https://cdn.example.com/article.png");
    image.setAttribute("referrerpolicy", "no-referrer");

    expect(retryImageWithOriginReferrer(image)).toBe(true);
    expect(image.getAttribute("src")).toBe(
      "https://cdn.example.com/article.png",
    );
    expect(image.getAttribute("referrerpolicy")).toBe("origin");
    expect(retryImageWithOriginReferrer(image)).toBe(false);
  });
});

describe("resolveArticleImageBaseUrl", () => {
  it("falls back to the feed URL when an article has no usable HTTP link", () => {
    expect(
      resolveArticleImageBaseUrl(
        "app://obsidian.md/blog/article",
        "https://example.com/feed.xml",
      ),
    ).toBe("https://example.com/feed.xml");
  });
});

describe("resolveSrcsetUrls", () => {
  const base = "https://addyosmani.com/blog/software-factories/";

  it("resolves root-relative candidates while preserving descriptors", () => {
    expect(
      resolveSrcsetUrls("/img/loop.svg 480w, /img/loop.svg 960w", base),
    ).toBe(
      "https://addyosmani.com/img/loop.svg 480w, https://addyosmani.com/img/loop.svg 960w",
    );
  });

  it("repairs candidates that were resolved against Obsidian's app origin", () => {
    expect(resolveSrcsetUrls("app://obsidian.md/img/loop.svg 480w", base)).toBe(
      "https://addyosmani.com/img/loop.svg 480w",
    );
  });

  it("leaves absolute and data URI candidates untouched", () => {
    const srcset =
      "https://cdn.example.com/a.png 480w, data:image/png;base64,aGVsbG8= 2x";
    expect(resolveSrcsetUrls(srcset, base)).toBe(srcset);
  });

  it("leaves comma-bearing candidate tokens untouched for the sanitizer", () => {
    const srcset = "https://cdn.example.com/fetch?url=a,b 480w";
    expect(resolveSrcsetUrls(srcset, base)).toBe(srcset);
  });

  it("returns the input unchanged when no base URL is available", () => {
    expect(resolveSrcsetUrls("/img/loop.svg", "")).toBe("/img/loop.svg");
  });
});

