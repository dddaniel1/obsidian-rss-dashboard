import { requestUrl } from "obsidian";

export type TranslationProvider = "microsoft" | "google";

export interface TranslationResult {
  text: string;
  provider: TranslationProvider;
}

interface MicrosoftTranslationResponse {
  translations?: Array<{ text?: string }>;
}

type GoogleTranslationResponse = [string, string, unknown, unknown];

const MICROSOFT_TRANSLATE_URL =
  "https://edge.microsoft.com/translate/auth";
const MICROSOFT_API_URL = "https://api-edge.cognitive.microsofttranslator.com/translate";

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
  /** Microsoft auth token, refreshed when expired. */
  private static microsoftToken: { value: string; expiresAt: number } | null =
    null;

  private static async getMicrosoftToken(): Promise<string> {
    const now = Date.now();
    if (
      this.microsoftToken &&
      this.microsoftToken.expiresAt > now + 30_000
    ) {
      return this.microsoftToken.value;
    }

    const response = await requestUrl({
      url: MICROSOFT_TRANSLATE_URL,
      method: "GET",
    });

    if (response.status !== 200) {
      throw new Error(
        `Microsoft translation auth failed with status ${response.status}`,
      );
    }

    const token = response.text;
    this.microsoftToken = { value: token, expiresAt: now + 8 * 60_000 };
    return token;
  }

  public static async translateText(
    text: string,
    targetLang: string,
    provider: TranslationProvider,
  ): Promise<TranslationResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { text: "", provider };
    }

    if (provider === "google") {
      try {
        return await this.translateWithGoogle(trimmed, targetLang);
      } catch (error) {
        throw new Error(
          `Translation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    try {
      const results = await this.translateWithMicrosoft([trimmed], targetLang);
      return results[0];
    } catch (error) {
      throw new Error(
        `Translation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Translate a batch of paragraphs. Microsoft accepts up to a small array of
   * texts per request; Google's free endpoint accepts a single text per call,
   * so paragraphs are translated sequentially.
   */
  public static async translateBatch(
    paragraphs: string[],
    targetLang: string,
    provider: TranslationProvider,
  ): Promise<TranslationResult[]> {
    const nonEmpty = paragraphs.map((p) => p.trim()).filter(Boolean);
    if (nonEmpty.length === 0) {
      return [];
    }

    if (provider === "google") {
      const results: TranslationResult[] = [];
      for (const paragraph of nonEmpty) {
        results.push(await this.translateWithGoogle(paragraph, targetLang));
      }
      return results;
    }

    const out: TranslationResult[] = [];
    const chunkSize = 20;
    for (let i = 0; i < nonEmpty.length; i += chunkSize) {
      const chunk = nonEmpty.slice(i, i + chunkSize);
      const chunkResults = await this.translateWithMicrosoft(
        chunk,
        targetLang,
      );
      out.push(...chunkResults);
    }
    return out;
  }

  private static async translateWithMicrosoft(
    texts: string[],
    targetLang: string,
  ): Promise<TranslationResult[]> {
    const token = await this.getMicrosoftToken();
    const url = `${MICROSOFT_API_URL}?api-version=3.0&to=${encodeURIComponent(targetLang)}`;

    let response;
    try {
      response = await requestUrl({
        url,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(texts.map((text) => ({ Text: text }))),
      });
    } catch (error) {
      // Token may have been revoked; retry once with a fresh token.
      this.microsoftToken = null;
      const freshToken = await this.getMicrosoftToken();
      response = await requestUrl({
        url,
        method: "POST",
        headers: {
          Authorization: `Bearer ${freshToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(texts.map((text) => ({ Text: text }))),
      });
      void error;
    }

    if (response.status !== 200) {
      throw new Error(
        `Microsoft translation failed with status ${response.status}`,
      );
    }

    const data = response.json as MicrosoftTranslationResponse[];
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("Microsoft translation returned no results");
    }

    const translations = data[0]?.translations ?? [];
    return texts.map((text, index) => ({
      text: translations[index]?.text ?? text,
      provider: "microsoft" as const,
    }));
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
