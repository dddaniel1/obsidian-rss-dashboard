import { requestUrl } from "obsidian";
import { ConcurrencySemaphore } from "../utils/concurrency";

const IMAGE_ACCEPT_HEADER = "image/avif,image/webp,image/*,*/*;q=0.8";
const MAX_RECOVERED_IMAGE_BYTES = 20 * 1_024 * 1_024;
const FAILURE_COOLDOWN_MS = 60_000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const NODE_FETCH_TIMEOUT_MS = 10_000;
const NODE_FETCH_MAX_REDIRECTS = 3;

interface ImageFetchRequest {
  url: string;
  method: "GET";
  headers: Record<string, string>;
  throw: false;
}

interface ImageFetchResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
}

interface NodeResponseLike {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  destroy(error?: Error): void;
}

interface NodeRequestLike {
  on(event: "error", listener: (error: Error) => void): void;
  end(): void;
  destroy(error?: Error): void;
}

interface NodeHttpLikeModule {
  request(
    url: string,
    options: { method: "GET"; headers: Record<string, string> },
    callback: (response: NodeResponseLike) => void,
  ): NodeRequestLike;
}

type NodeRequireLike = (moduleId: string) => unknown;

interface RecoveredImage {
  data: ArrayBuffer;
  contentType: string;
}

interface ImageRecoveryEntry {
  objectUrl: string;
  references: number;
}

type RefererKind = "none" | "article" | "origin" | "image-origin";

export interface ImageRecoveryLease {
  url: string;
  release(): void;
}

interface ImageRecoveryServiceOptions {
  fetchImage?: (request: ImageFetchRequest) => Promise<ImageFetchResponse>;
  fetchImageWithUserAgent?: (
    request: ImageFetchRequest,
  ) => Promise<ImageFetchResponse | null>;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  now?: () => number;
}

interface RequestCandidate {
  kind: RefererKind;
  referer?: string;
}

export class ImageRecoveryService {
  private readonly fetchImage: (
    request: ImageFetchRequest,
  ) => Promise<ImageFetchResponse>;
  private readonly fetchImageWithUserAgent: (
    request: ImageFetchRequest,
  ) => Promise<ImageFetchResponse | null>;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly now: () => number;
  private readonly entries = new Map<string, ImageRecoveryEntry>();
  private readonly inFlight = new Map<string, Promise<RecoveredImage | null>>();
  private readonly failedUntil = new Map<string, number>();
  private readonly preferredReferer = new Map<string, RefererKind>();
  private readonly requestSemaphore = new ConcurrencySemaphore(4);
  private destroyed = false;

  constructor(options: ImageRecoveryServiceOptions = {}) {
    this.fetchImage = options.fetchImage ?? ((request) => requestUrl(request));
    this.fetchImageWithUserAgent =
      options.fetchImageWithUserAgent ?? ((request) => this.fetchWithNode(request));
    this.createObjectUrl =
      options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl =
      options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
    this.now = options.now ?? (() => Date.now());
  }

  async acquire(
    rawImageUrl: string,
    rawArticleUrl: string,
  ): Promise<ImageRecoveryLease | null> {
    if (this.destroyed) return null;
    const imageUrl = this.normalizeHttpUrl(rawImageUrl);
    if (!imageUrl) return null;
    const articleUrl = this.normalizeHttpUrl(rawArticleUrl) ?? "";

    const existingEntry = this.entries.get(imageUrl);
    if (existingEntry) return this.createLease(imageUrl, existingEntry);

    const failureKey = this.getFailureKey(imageUrl, articleUrl);
    if ((this.failedUntil.get(failureKey) ?? 0) > this.now()) return null;

    let pending = this.inFlight.get(imageUrl);
    if (!pending) {
      pending = this.fetchRecoveredImage(imageUrl, articleUrl);
      this.inFlight.set(imageUrl, pending);
    }

    let recovered: RecoveredImage | null;
    try {
      recovered = await pending;
    } finally {
      if (this.inFlight.get(imageUrl) === pending) {
        this.inFlight.delete(imageUrl);
      }
    }

    if (!recovered || this.destroyed) {
      this.recordFailure(failureKey);
      return null;
    }

    const entry = this.entries.get(imageUrl) ?? {
      objectUrl: this.createObjectUrl(
        new Blob([recovered.data], { type: recovered.contentType }),
      ),
      references: 0,
    };
    this.entries.set(imageUrl, entry);
    return this.createLease(imageUrl, entry);
  }

  destroy(): void {
    this.destroyed = true;
    for (const entry of this.entries.values()) {
      this.revokeObjectUrl(entry.objectUrl);
    }
    this.entries.clear();
    this.inFlight.clear();
    this.failedUntil.clear();
    this.preferredReferer.clear();
  }

  private createLease(
    imageUrl: string,
    entry: ImageRecoveryEntry,
  ): ImageRecoveryLease {
    entry.references += 1;
    let released = false;
    return {
      url: entry.objectUrl,
      release: () => {
        if (released) return;
        released = true;
        entry.references -= 1;
        if (entry.references > 0 || this.entries.get(imageUrl) !== entry) return;
        this.entries.delete(imageUrl);
        this.revokeObjectUrl(entry.objectUrl);
      },
    };
  }

  private async fetchRecoveredImage(
    imageUrl: string,
    articleUrl: string,
  ): Promise<RecoveredImage | null> {
    await this.requestSemaphore.acquire();
    try {
      if (this.destroyed) return null;
      return await this.fetchRecoveredImageWithCandidates(imageUrl, articleUrl);
    } finally {
      this.requestSemaphore.release();
    }
  }

  private async fetchRecoveredImageWithCandidates(
    imageUrl: string,
    articleUrl: string,
  ): Promise<RecoveredImage | null> {
    const strategyKey = this.getStrategyKey(imageUrl, articleUrl);
    const candidates = this.getRequestCandidates(
      articleUrl,
      imageUrl,
      this.preferredReferer.get(strategyKey),
    );

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const request: ImageFetchRequest = {
        url: imageUrl,
        method: "GET",
        headers: {
          Accept: IMAGE_ACCEPT_HEADER,
          ...(candidate.referer ? { Referer: candidate.referer } : {}),
        },
        throw: false,
      };
      let response: ImageFetchResponse | null = null;
      try {
        response = await this.fetchImage(request);
      } catch {
        response = null;
      }

      if (response?.status === 404 || response?.status === 410) return null;
      let recovered = response ? this.validateResponse(response) : null;
      if (!recovered) {
        let userAgentResponse: ImageFetchResponse | null = null;
        const userAgentRequest: ImageFetchRequest = {
          ...request,
          headers: {
            ...request.headers,
            "User-Agent": USER_AGENT,
          },
        };
        try {
          userAgentResponse = await this.fetchImageWithUserAgent(userAgentRequest);
        } catch {
          userAgentResponse = null;
        }
        if (
          userAgentResponse?.status === 404 ||
          userAgentResponse?.status === 410
        ) {
          return null;
        }
        recovered = userAgentResponse
          ? this.validateResponse(userAgentResponse)
          : null;
      }
      if (recovered) {
        this.preferredReferer.set(strategyKey, candidate.kind);
        return recovered;
      }

      if (
        response &&
        !this.shouldTryAnotherReferer(response, index, candidates.length)
      ) {
        break;
      }
    }

    const fallbackUrl = this.getTrustedFallbackImageUrl(imageUrl);
    if (fallbackUrl) {
      try {
        const fallbackResponse = await this.fetchImage({
          url: fallbackUrl,
          method: "GET",
          headers: { Accept: IMAGE_ACCEPT_HEADER },
          throw: false,
        });
        return this.validateResponse(fallbackResponse);
      } catch {
        return null;
      }
    }

    return null;
  }

  private getRequestCandidates(
    articleUrl: string,
    imageUrl: string,
    preferred?: RefererKind,
  ): RequestCandidate[] {
    const candidates: RequestCandidate[] = [{ kind: "none" }];
    if (articleUrl) {
      candidates.push({ kind: "article", referer: articleUrl });
      candidates.push({
        kind: "origin",
        referer: `${new URL(articleUrl).origin}/`,
      });
    }
    if (imageUrl) {
      candidates.push({
        kind: "image-origin",
        referer: `${new URL(imageUrl).origin}/`,
      });
    }

    if (!preferred) return candidates;
    return candidates.sort((left, right) => {
      if (left.kind === preferred) return -1;
      if (right.kind === preferred) return 1;
      return 0;
    });
  }

  private shouldTryAnotherReferer(
    response: ImageFetchResponse,
    index: number,
    candidateCount: number,
  ): boolean {
    if (index >= candidateCount - 1) return false;
    if (response.status === 429) return false;
    const contentType = this.getHeader(response.headers, "content-type");
    return !contentType.startsWith("image/");
  }

  private async fetchWithNode(
    request: ImageFetchRequest,
  ): Promise<ImageFetchResponse | null> {
    const nodeRuntime = window as unknown as { require?: NodeRequireLike };
    const nodeRequire =
      typeof nodeRuntime.require === "function" ? nodeRuntime.require : null;
    if (!nodeRequire) return null;

    let currentUrl: URL;
    try {
      currentUrl = new URL(request.url);
    } catch {
      return null;
    }

    for (
      let redirectCount = 0;
      redirectCount <= NODE_FETCH_MAX_REDIRECTS;
      redirectCount += 1
    ) {
      const moduleId = currentUrl.protocol === "https:" ? "node:https" : "node:http";
      let httpModule: NodeHttpLikeModule;
      try {
        const requiredModule: unknown = nodeRequire(moduleId);
        if (!this.isNodeHttpLikeModule(requiredModule)) return null;
        httpModule = requiredModule;
      } catch {
        return null;
      }

      const response = await this.requestWithNode(
        httpModule,
        currentUrl.toString(),
        {
          ...request.headers,
          "User-Agent": USER_AGENT,
        },
      ).catch(() => null);
      if (!response) return null;

      const status = response.status;
      if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
        if (redirectCount === NODE_FETCH_MAX_REDIRECTS) return null;
        const nextUrl = this.getRedirectUrl(currentUrl, response.headers);
        if (!nextUrl) return null;
        currentUrl = nextUrl;
        continue;
      }

      return response;
    }

    return null;
  }

  private requestWithNode(
    httpModule: NodeHttpLikeModule,
    url: string,
    headers: Record<string, string>,
  ): Promise<ImageFetchResponse> {
    return new Promise((resolve, reject) => {
      let nodeRequest: NodeRequestLike | undefined;
      const timeoutId = window.setTimeout(() => {
        nodeRequest?.destroy(new Error("Image request timed out"));
      }, NODE_FETCH_TIMEOUT_MS);
      const finish = (response: ImageFetchResponse) => {
        window.clearTimeout(timeoutId);
        resolve(response);
      };
      const fail = (error: Error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      };

      nodeRequest = httpModule.request(
        url,
        { method: "GET", headers },
        (nodeResponse) => {
          const chunks: Uint8Array[] = [];
          let byteLength = 0;
          let completed = false;

          nodeResponse.on("data", (chunk) => {
            if (completed) return;
            if (byteLength + chunk.byteLength > MAX_RECOVERED_IMAGE_BYTES) {
              completed = true;
              nodeResponse.destroy(new Error("Recovered image exceeds size limit"));
              fail(new Error("Recovered image exceeds size limit"));
              return;
            }
            chunks.push(chunk);
            byteLength += chunk.byteLength;
          });
          nodeResponse.on("end", () => {
            if (completed) return;
            completed = true;
            const body = new Uint8Array(byteLength);
            let offset = 0;
            for (const chunk of chunks) {
              body.set(chunk, offset);
              offset += chunk.byteLength;
            }
            finish({
              status: nodeResponse.statusCode ?? 0,
              headers: this.normalizeNodeHeaders(nodeResponse.headers),
              arrayBuffer: body.buffer,
            });
          });
          nodeResponse.on("error", (error) => {
            if (completed) return;
            completed = true;
            fail(error);
          });
        },
      );
      nodeRequest.on("error", (error) => {
        fail(error);
      });
      nodeRequest.end();
    });
  }

  private isNodeHttpLikeModule(value: unknown): value is NodeHttpLikeModule {
    if (!value || typeof value !== "object") return false;
    const candidate = value as { request?: unknown };
    return typeof candidate.request === "function";
  }

  private getRedirectUrl(
    currentUrl: URL,
    headers: Record<string, string | string[] | undefined>,
  ): URL | null {
    const location = headers.location;
    const locationUrl = Array.isArray(location) ? location[0] : location;
    if (!locationUrl) return null;
    try {
      const nextUrl = new URL(locationUrl, currentUrl);
      if (nextUrl.protocol !== "https:" && nextUrl.protocol !== "http:") {
        return null;
      }
      nextUrl.username = "";
      nextUrl.password = "";
      nextUrl.hash = "";
      return nextUrl;
    } catch {
      return null;
    }
  }

  private normalizeNodeHeaders(
    headers: Record<string, string | string[] | undefined>,
  ): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === "string") {
        normalized[name] = value;
      } else if (Array.isArray(value) && value.length > 0) {
        normalized[name] = value.join(", ");
      }
    }
    return normalized;
  }

  private validateResponse(response: ImageFetchResponse): RecoveredImage | null {
    if (response.status < 200 || response.status >= 300) return null;
    const contentType = this.getHeader(response.headers, "content-type")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!contentType.startsWith("image/")) return null;
    const declaredLength = Number.parseInt(
      this.getHeader(response.headers, "content-length"),
      10,
    );
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_RECOVERED_IMAGE_BYTES
    ) {
      return null;
    }
    if (
      response.arrayBuffer.byteLength === 0 ||
      response.arrayBuffer.byteLength > MAX_RECOVERED_IMAGE_BYTES ||
      !this.hasValidSignature(response.arrayBuffer, contentType)
    ) {
      return null;
    }
    return { data: response.arrayBuffer, contentType };
  }

  private hasValidSignature(data: ArrayBuffer, contentType: string): boolean {
    const bytes = new Uint8Array(data);
    if (contentType === "image/jpeg") {
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (contentType === "image/png") {
      return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    }
    if (contentType === "image/gif") {
      return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)));
    }
    if (contentType === "image/webp") {
      return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    }
    if (contentType === "image/avif") {
      return bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp" && String.fromCharCode(...bytes.slice(8, 12)).startsWith("avif");
    }
    return false;
  }

  private normalizeHttpUrl(rawUrl: string): string | null {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      url.username = "";
      url.password = "";
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }

  private getHeader(headers: Record<string, string>, name: string): string {
    return Object.entries(headers).find(
      ([headerName]) => headerName.toLowerCase() === name,
    )?.[1] ?? "";
  }

  private getFailureKey(imageUrl: string, articleUrl: string): string {
    return `${imageUrl}\n${articleUrl}`;
  }

  private getStrategyKey(imageUrl: string, articleUrl: string): string {
    const imageHost = new URL(imageUrl).host;
    const articleOrigin = articleUrl ? new URL(articleUrl).origin : "";
    return `${imageHost}\n${articleOrigin}`;
  }

  private recordFailure(failureKey: string): void {
    this.failedUntil.delete(failureKey);
    this.failedUntil.set(failureKey, this.now() + FAILURE_COOLDOWN_MS);
    if (this.failedUntil.size <= 500) return;
    const oldestKey = this.failedUntil.keys().next().value;
    if (oldestKey) this.failedUntil.delete(oldestKey);
  }

  private getTrustedFallbackImageUrl(imageUrl: string): string | null {
    const url = new URL(imageUrl);
    if (url.hostname !== "cdnfile.sspai.com") return null;
    url.hostname = "rssfile.sspai.com";
    return url.toString();
  }
}
