import { resolveAbsoluteHttpUrl, resolveObsidianAppUrl } from "./url-utils";

export function optimizeImageUrl(url: string, maxWidth = 600): string {
  if (!url) return url;

  // NPR / Brightspot CDN
  if (url.includes("brightspotcdn.com") || url.includes("media.npr.org")) {
    return url
      .replace(/\/resize\/\d+x\d+!?\//g, `/resize/${maxWidth}x/`)
      .replace(
        /\/(?:crop\/)?\d+x\d+(?:[+]\d+[+]\d*)?\//g,
        "/",
      );
  }

  // WordPress Photon / Jetpack CDN
  if (
    url.includes("i0.wp.com") ||
    url.includes("i1.wp.com") ||
    url.includes("i2.wp.com")
  ) {
    try {
      const parsed = new URL(url);
      parsed.searchParams.set("w", String(maxWidth));
      parsed.searchParams.delete("h");
      return parsed.toString();
    } catch {
      return url;
    }
  }

  // Cloudinary
  if (url.includes("cloudinary.com")) {
    return url.replace(/\/upload\//, `/upload/w_${maxWidth},c_scale/`);
  }

  // Generic: return unchanged (unknown CDN, no safe transform)
  return url;
}

/** Returns whether an image is a WordPress-rendered LaTeX formula. */
export function isLatexFormulaImage(
  src: string | null | undefined,
  className?: string | null,
): boolean {
  const hasLatexClass = (className ?? "")
    .split(/\s+/)
    .some((token) => token.toLowerCase() === "latex");
  if (hasLatexClass) return true;

  const trimmedSrc = src?.trim();
  if (!trimmedSrc) return false;

  try {
    const parsed = new URL(trimmedSrc, "https://rss-dashboard.invalid");
    return (
      parsed.pathname.toLowerCase().endsWith("/latex.php") &&
      parsed.searchParams.has("latex")
    );
  } catch {
    return /(?:^|\/)latex\.php\?[^#]*\blatex=/i.test(trimmedSrc);
  }
}

/** DOM convenience wrapper for {@link isLatexFormulaImage}. */
export function isLatexFormulaImageElement(image: Element): boolean {
  return isLatexFormulaImage(
    image.getAttribute("src"),
    image.getAttribute("class"),
  );
}

/** Returns the first non-empty URL that is not a rendered formula image. */
export function firstNonFormulaImageUrl(
  candidates: readonly (string | null | undefined)[],
): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed && !isLatexFormulaImage(trimmed)) return trimmed;
  }
  return undefined;
}

/** Returns the first image element that is eligible for an article-media role. */
export function findFirstNonFormulaImage(
  root: ParentNode,
): HTMLImageElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLImageElement>("img")).find(
      (image) => !isLatexFormulaImageElement(image),
    ) ?? null
  );
}

/** Returns whether an element is or contains a rendered formula image. */
export function containsLatexFormulaImage(root: Element): boolean {
  if (
    root.tagName.toLowerCase() === "img" &&
    isLatexFormulaImageElement(root)
  ) {
    return true;
  }

  return Array.from(root.querySelectorAll("img")).some((image) =>
    isLatexFormulaImageElement(image),
  );
}

export function optimizeImageUrlsInContent(content: string, maxWidth = 600): string {
  if (!content) return content;

  return content.replace(
    /<img([^>]+)src=["']([^"']+)["']/gi,
    (match: string, attributes: string, src: string) => {
      const optimizedSrc = optimizeImageUrl(src, maxWidth);
      return `<img${attributes}src="${optimizedSrc}"`;
    }
  );
}

export function sanitizeImageUrl(raw: unknown): string {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return "";
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://"))
    return "";
  return trimmed;
}

/** Retries a failed lazy-loaded image with the remote URL retained by the feed. */
export function retryLazyImageSource(image: HTMLImageElement): boolean {
  if (image.dataset.rssLazySourceAttempted === "true") return false;
  image.dataset.rssLazySourceAttempted = "true";

  const currentSource = image.getAttribute("src")?.trim() ?? "";
  const candidate = [
    image.getAttribute("data-src"),
    image.getAttribute("data-original"),
  ]
    .map((value) => sanitizeImageUrl(value))
    .find((value) => value && value !== currentSource);
  if (!candidate) return false;

  image.closest("picture")?.querySelectorAll("source").forEach((source) =>
    source.remove(),
  );
  image.removeAttribute("srcset");
  image.removeAttribute("sizes");
  image.setAttribute("src", candidate);
  return true;
}

/** Retries a remote image while allowing the app origin to be sent as Referer. */
export function retryImageWithOriginReferrer(image: HTMLImageElement): boolean {
  if (image.dataset.rssOriginReferrerAttempted === "true") return false;
  const source = image.currentSrc || image.getAttribute("src") || "";
  if (!/^https?:\/\//i.test(source)) return false;

  image.dataset.rssOriginReferrerAttempted = "true";
  image.closest("picture")?.querySelectorAll("source").forEach((sourceEl) =>
    sourceEl.remove(),
  );
  image.removeAttribute("srcset");
  image.removeAttribute("sizes");
  image.setAttribute("referrerpolicy", "origin");
  image.removeAttribute("src");
  image.setAttribute("src", source);
  return true;
}

/** Chooses a trustworthy HTTP base for resolving relative article image URLs. */
export function resolveArticleImageBaseUrl(
  articleUrl: string | null | undefined,
  feedUrl: string | null | undefined,
): string {
  for (const candidate of [articleUrl, feedUrl]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        return parsed.toString();
      }
    } catch {
      // Continue to the feed URL.
    }
  }
  return "";
}

/**
 * Resolves every candidate URL in a srcset attribute against the article base
 * URL while preserving descriptors. Absolute and data URI candidates are kept
 * as-is; candidates that cannot be resolved safely (for example URLs that
 * contain commas) are returned unchanged so the HTML sanitizer can decide
 * whether to keep them.
 */
export function resolveSrcsetUrls(
  srcset: string | null | undefined,
  baseUrl: string,
): string {
  const trimmed = srcset?.trim() ?? "";
  if (!trimmed || !baseUrl) return trimmed;

  // Candidate grammar: URL token, optional width/density descriptor, optional
  // comma. A greedy URL token keeps commas inside data URIs and URLs intact.
  const candidatePattern = /(\S+)(\s+[\d.]+[whx])?(\s*(?:,|$))/g;
  const resolvedCandidates: string[] = [];

  for (const match of trimmed.matchAll(candidatePattern)) {
    const url = match[1];
    const descriptor = (match[2] ?? "").trim();

    let resolvedUrl = url;
    if (!url.toLowerCase().startsWith("data:") && !url.includes(",")) {
      resolvedUrl =
        resolveAbsoluteHttpUrl(url, baseUrl) ??
        resolveObsidianAppUrl(url, baseUrl) ??
        url;
    }

    resolvedCandidates.push(
      descriptor ? `${resolvedUrl} ${descriptor}` : resolvedUrl,
    );
  }

  return resolvedCandidates.join(", ");
}
