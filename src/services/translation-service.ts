import { requestUrl } from "obsidian";

export type TranslationProvider = "google";

export interface TranslationResult {
  text: string;
  provider: TranslationProvider;
}

type GoogleTranslationResponse = [string, string, unknown, unknown];

const GOOGLE_TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single";

/** Block-level elements whose text content should be translated. */
const TRANSLATABLE_BLOCK_SELECTOR = [
  "p",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "figcaption",
  "td",
  "th",
  "dd",
  "dt",
].join(", ");

function hasMeaningfulText(element: Element): boolean {
  const text = (element.textContent || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  // Skip pure numbers, punctuation, or single symbols.
  return /[\p{L}]/u.test(text) && text.length > 1;
}

export class TranslationService {
  private static cache = new Map<string, string>();
  private static readonly MAX_CACHE_SIZE = 1000;

  public static clearCache(): void {
    this.cache.clear();
  }

  public static async translateText(
    text: string,
    targetLang: string,
  ): Promise<TranslationResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { text: "", provider: "google" };
    }

    const cacheKey = `${targetLang}:${trimmed}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return { text: cached, provider: "google" };
    }

    try {
      const result = await this.translateWithGoogle(trimmed, targetLang);
      if (this.cache.size >= this.MAX_CACHE_SIZE) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) {
          this.cache.delete(firstKey);
        }
      }
      this.cache.set(cacheKey, result.text);
      return result;
    } catch (error) {
      throw new Error(
        `Translation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Translate a batch of paragraphs with bounded concurrency and optional
   * progress reporting. Preserves the exact array length and 1:1 index mapping
   * with the input paragraphs.
   */
  public static async translateBatch(
    paragraphs: string[],
    targetLang: string,
    onProgress?: (
      completed: number,
      total: number,
      index: number,
      result: TranslationResult,
    ) => void,
    concurrency = 4,
  ): Promise<TranslationResult[]> {
    if (paragraphs.length === 0) {
      return [];
    }

    const results: TranslationResult[] = new Array<TranslationResult>(
      paragraphs.length,
    );
    let completedCount = 0;
    const totalCount = paragraphs.length;

    const tasks: Array<{ index: number; text: string }> = [];
    for (let i = 0; i < paragraphs.length; i++) {
      const trimmed = (paragraphs[i] || "").trim();
      if (!trimmed) {
        results[i] = { text: "", provider: "google" };
        completedCount++;
        onProgress?.(completedCount, totalCount, i, results[i]);
      } else {
        tasks.push({ index: i, text: trimmed });
      }
    }

    if (tasks.length === 0) {
      return results;
    }

    let nextTaskIndex = 0;
    let lastErrorMessage: string | null = null;
    let successCount = 0;

    const workerCount = Math.min(concurrency, tasks.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextTaskIndex < tasks.length) {
        const current = tasks[nextTaskIndex++];
        try {
          const res = await this.translateText(current.text, targetLang);
          results[current.index] = res;
          if (res.text) {
            successCount++;
          }
        } catch (error) {
          const msg =
            error instanceof Error ? error.message : "Translation failed";
          lastErrorMessage = msg;
          console.warn(
            "[RSS Dashboard] Paragraph translation failed:",
            msg,
          );
          results[current.index] = { text: "", provider: "google" };
        }
        completedCount++;
        onProgress?.(
          completedCount,
          totalCount,
          current.index,
          results[current.index],
        );
      }
    });

    await Promise.all(workers);

    if (successCount === 0 && lastErrorMessage !== null) {
      throw new Error(lastErrorMessage);
    }

    return results;
  }

  private static async translateWithGoogle(
    text: string,
    targetLang: string,
  ): Promise<TranslationResult> {
    const url =
      `${GOOGLE_TRANSLATE_URL}?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}` +
      `&dt=t&q=${encodeURIComponent(text)}`;

    const response = await requestUrl({ url, method: "GET" });

    if (response.status !== 200) {
      throw new Error(
        `Google translation failed with status ${response.status}`,
      );
    }

    const data = response.json as GoogleTranslationResponse[];
    const sentences = Array.isArray(data) && Array.isArray(data[0]);
    if (!sentences) {
      throw new Error("Google translation returned no results");
    }

    const translated = (data[0] as unknown as Array<[string, unknown]>)
      .map((segment) => segment?.[0] ?? "")
      .join("");

    return { text: translated, provider: "google" };
  }

  /**
   * Collect block-level elements from a container that contain translatable
   * text. Returns them in document order so translations can be inserted
   * under the matching originals.
   */
  public static collectTranslatableBlocks(root: Element): Element[] {
    const candidates = Array.from(
      root.querySelectorAll(TRANSLATABLE_BLOCK_SELECTOR),
    );
    const result: Element[] = [];
    for (const candidate of candidates) {
      // Nested blocks (e.g. a paragraph inside a blockquote) translate at the
      // outermost level only, to avoid double translation.
      const isNested = result.some((kept) => kept.contains(candidate));
      if (isNested) continue;
      if (!hasMeaningfulText(candidate)) continue;
      result.push(candidate);
    }
    return result;
  }
}
