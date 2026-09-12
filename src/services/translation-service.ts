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
  public static async translateText(
    text: string,
    targetLang: string,
  ): Promise<TranslationResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { text: "", provider: "google" };
    }

    try {
      return await this.translateWithGoogle(trimmed, targetLang);
    } catch (error) {
      throw new Error(
        `Translation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Translate a batch of paragraphs. Google's free endpoint accepts a single
   * text per call, so paragraphs are translated sequentially.
   */
  public static async translateBatch(
    paragraphs: string[],
    targetLang: string,
  ): Promise<TranslationResult[]> {
    const nonEmpty = paragraphs.map((p) => p.trim()).filter(Boolean);
    if (nonEmpty.length === 0) {
      return [];
    }

    const results: TranslationResult[] = [];
    for (const paragraph of nonEmpty) {
      results.push(await this.translateWithGoogle(paragraph, targetLang));
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
