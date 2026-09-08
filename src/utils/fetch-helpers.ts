import { Readability } from "@mozilla/readability";
import {
  robustFetch,
  robustFetchDetailed,
  ensureUtf8Meta,
} from "./platform-utils";
import { resolveAbsoluteHttpUrl } from "./url-utils";

/** Markers that indicate the page is a WAF/bot-challenge block rather than real content. */
const BLOCKED_MARKERS = [
  "just a moment", // Cloudflare "Just a moment..." title
  "cf-browser-verification",
  "cf-challenge",
  "ddos-guard",
  "access denied",
  "403 forbidden",
  "enable javascript and cookies",
  "401 unauthorized",
];

const RESTRICTED_MARKERS = [
  "401",
  "403",
  "forbidden",
  "access denied",
  "paywall",
  "subscription required",
  "subscribe to continue",
  "unauthorized",
];

export type FullArticleFetchFailureType = "none" | "restricted" | "network";

export interface FullArticleFetchResult {
  content: string;
  failureType: FullArticleFetchFailureType;
}

function isRestrictedStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/**
 * Returns true when the fetched HTML looks like a WAF/bot-challenge block
 * rather than real article content.
 *
 * Also returns true for very short responses that can't contain a real article.
 */
export function isBlockedResponse(html: string): boolean {
  if (!html || html.trim().length < 200) {
    return true;
  }
  // Cloudflare/WAF challenge pages are small stubs (< 25KB). Substantial pages with tens of KB are not challenge screens.
  if (html.length > 30000) {
    return false;
  }
  const lower = html.toLowerCase();
  return BLOCKED_MARKERS.some((marker) => lower.includes(marker));
}

export function isRestrictedSignal(input: string): boolean {
  if (!input) return false;
  const lower = input.toLowerCase();
  return RESTRICTED_MARKERS.some((marker) => lower.includes(marker));
}

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};

/**
 * Fetch the HTML at `url`, parse it with Mozilla Readability, and return
 * the extracted article HTML.  Returns `""` on any error.
 */
export async function fetchAndParse(
  url: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const html = await robustFetch(url, {
    headers: { ...DEFAULT_HEADERS, ...extraHeaders },
  });
  if (!html) return "";

  const withMeta = ensureUtf8Meta(html);
  const doc = new DOMParser().parseFromString(withMeta, "text/html");
  const article = new Readability(doc).parse();
  return article?.content ?? "";
}

export function convertRelativeUrlsInContent(
  content: string,
  baseUrl: string,
): string {
  if (!content || !baseUrl) return content;
  try {
    const doc = new DOMParser().parseFromString(content, "text/html");
    doc.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src");
      if (src) {
        const abs = resolveAbsoluteHttpUrl(src, baseUrl);
        if (abs) img.setAttribute("src", abs);
      }
      ["data-src", "data-original"].forEach((attr) => {
        const val = img.getAttribute(attr);
        if (val) {
          const abs = resolveAbsoluteHttpUrl(val, baseUrl);
          if (abs) img.setAttribute(attr, abs);
        }
      });
    });
    doc.querySelectorAll("a").forEach((a) => {
      const href = a.getAttribute("href");
      if (href) {
        const abs = resolveAbsoluteHttpUrl(href, baseUrl);
        if (abs) a.setAttribute("href", abs);
      }
    });
    return new XMLSerializer().serializeToString(doc.body);
  } catch {
    return content;
  }
}

export function parseArticleContent(html: string, baseUrl?: string): string {
  if (!html) return "";
  const withMeta = ensureUtf8Meta(html);
  const doc = new DOMParser().parseFromString(withMeta, "text/html");
  let content = "";
  try {
    const docClone = doc.cloneNode(true) as Document;
    const article = new Readability(docClone).parse();
    if (article?.content && article.content.trim().length > 100) {
      content = article.content;
    }
  } catch (err) {
    console.debug("[RSS Dashboard] Readability parse error:", err);
  }

  if (!content) {
    const selectors = [
      "main article",
      "article",
      "[role='main']",
      "main",
      ".rich_media_content",
      "#js_content",
      ".Post-RichText",
      ".RichContent-inner",
      ".article-viewer",
      ".markdown-body",
      "#article-content",
      "#post-content",
      "#article_content",
      ".post-content",
      ".entry-content",
      ".article-content",
      ".article-body",
      ".article__body",
      ".article-text",
      ".story-body",
      ".content-body",
      ".main-content",
      ".full-text",
      ".post-body",
      ".entry-body",
      ".article-entry",
      "[itemprop='articleBody']",
      "[data-testid='article-body']",
      "#content",
      ".content",
    ];
    for (const selector of selectors) {
      const el = doc.querySelector(selector);
      if (el && (el.textContent || "").trim().length > 200) {
        content = new XMLSerializer().serializeToString(el);
        break;
      }
    }
  }

  if (!content && doc.body) {
    const cleanBody = doc.body.cloneNode(true) as HTMLElement;
    cleanBody
      .querySelectorAll(
        "script, style, iframe, nav, footer, header, noscript, aside",
      )
      .forEach((n) => n.remove());
    const cleanedText = (cleanBody.textContent || "").trim();
    if (cleanedText.length > 200) {
      content = cleanBody.innerHTML;
    }
  }

  if (content && baseUrl) {
    return convertRelativeUrlsInContent(content, baseUrl);
  }

  return content;
}

/**
 * Fetches article content with a direct request and optional proxy fallback.
 * Returns a structured result so callers can distinguish restricted pages
 * from generic network/system failures.
 */
export async function fetchWithProxyFallbackDetailed(
  url: string,
  proxyUrl?: string,
): Promise<FullArticleFetchResult> {
  let directRestricted = false;

  // 1. Direct fetch
  try {
    const directResponse = await robustFetchDetailed(url, {
      headers: DEFAULT_HEADERS,
    });
    const directHtml = directResponse.text || "";
    const directStatus = directResponse.status ?? 0;
    const directBlocked =
      isBlockedResponse(directHtml) || isRestrictedStatus(directStatus);

    if (!directBlocked) {
      const parsed = parseArticleContent(directHtml, url);
      if (parsed && parsed.trim().length > 100) {
        console.debug(
          `[RSS Dashboard] Direct fetch succeeded for ${url} (${directHtml.length} chars).`,
        );
        return {
          content: parsed,
          failureType: "none",
        };
      }
      console.warn(
        `[RSS Dashboard] Direct fetch succeeded (${directHtml.length} chars) but content could not be parsed for ${url}. Attempting proxy...`,
      );
    } else {
      directRestricted =
        isRestrictedStatus(directStatus) || isRestrictedSignal(directHtml);
      console.warn(
        `[RSS Dashboard] Direct fetch returned blocked/empty response for ${url} (${directHtml.length} chars). Attempting proxy...`,
      );
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const error = e as {
      status?: number;
      statusCode?: number;
      response?: { status?: number };
    };
    const status =
      error?.status ?? error?.statusCode ?? error?.response?.status ?? 0;
    directRestricted = isRestrictedStatus(status) || isRestrictedSignal(msg);
    const logMessage = directRestricted
      ? `[RSS Dashboard] Restricted article fetch blocked (${status || "no-status"}): ${msg}`
      : `[RSS Dashboard] fetchWithProxyFallback error: ${msg}`;
    if (directRestricted) {
      console.warn(logMessage);
    } else {
      console.error(logMessage);
    }
  }

  // 2. Proxy fallback
  if (!proxyUrl || proxyUrl.trim() === "") {
    console.warn(
      "[RSS Dashboard] No CORS proxy configured. Cannot retry blocked fetch.",
    );
    return {
      content: "",
      failureType: directRestricted ? "restricted" : "network",
    };
  }

  const proxyCandidates: string[] = [];
  if (proxyUrl === "auto") {
    proxyCandidates.push("https://r.jina.ai/");
    proxyCandidates.push("https://api.allorigins.win/raw?url=");
  } else {
    proxyCandidates.push(proxyUrl.trim());
  }

  let lastProxyRestricted = false;

  for (const proxy of proxyCandidates) {
    try {
      const isJina = proxy.includes("r.jina.ai");
      const proxyTarget = isJina
        ? (proxy.endsWith("/") ? `${proxy}${url}` : `${proxy}/${url}`)
        : proxy.replace(/\/$/, "") + encodeURIComponent(url);

      const headers: Record<string, string> = {
        ...DEFAULT_HEADERS,
        ...(isJina ? { "X-Return-Format": "html" } : {}),
      };

      const proxyResponse = await robustFetchDetailed(proxyTarget, {
        headers,
      });
      const proxyHtml = proxyResponse?.text || "";
      const status = proxyResponse?.status ?? 0;

      if (
        !proxyHtml ||
        isBlockedResponse(proxyHtml) ||
        isRestrictedStatus(status)
      ) {
        if (isRestrictedStatus(status) || isRestrictedSignal(proxyHtml)) {
          lastProxyRestricted = true;
        }
        console.warn(
          `[RSS Dashboard] Proxy fetch also returned blocked/empty response for ${url} via ${proxy}.`,
        );
        continue;
      }

      const parsed = parseArticleContent(proxyHtml, url);
      if (parsed && parsed.trim().length > 100) {
        console.debug(
          `[RSS Dashboard] Proxy fetch succeeded for ${url} (${proxyHtml.length} chars).`,
        );
        return {
          content: parsed,
          failureType: "none",
        };
      }
    } catch (proxyErr) {
      const msg =
        proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
      console.warn(
        `[RSS Dashboard] Proxy error with ${proxy} for ${url}:`,
        msg,
      );
    }
  }

  return {
    content: "",
    failureType:
      directRestricted || lastProxyRestricted ? "restricted" : "network",
  };
}

/**
 * Orchestrates the full fetch-with-proxy-fallback flow:
 *
 * 1. Direct fetch → parse with Readability.
 * 2. If the response is blocked and a proxy URL is provided, retry via proxy.
 * 3. Returns "" if both attempts fail.
 */
export async function fetchWithProxyFallback(
  url: string,
  proxyUrl?: string,
): Promise<string> {
  const result = await fetchWithProxyFallbackDetailed(url, proxyUrl);
  return result.content;
}
