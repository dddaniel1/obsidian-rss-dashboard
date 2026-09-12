import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import * as obsidian from "obsidian";
import {
  TranslationService,
} from "../../../src/services/translation-service";

interface MockResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

function createMockResponse(text: string, json?: unknown): MockResponse {
  return {
    status: 200,
    headers: {},
    arrayBuffer: new TextEncoder().encode(text).buffer,
    json: json ?? {},
    text,
  };
}

describe("TranslationService", () => {
  let requestUrlSpy: Mock;

  beforeEach(() => {
    vi.restoreAllMocks();
    requestUrlSpy = vi.spyOn(obsidian, "requestUrl");
  });

  describe("translateText", () => {
    it("translates text with the Google provider", async () => {
      requestUrlSpy.mockResolvedValue(
        createMockResponse("", [
          [["你好世界", "en", null, null], null, null, null],
        ]) as unknown as MockResponse,
      );

      const result = await TranslationService.translateText(
        "Hello world",
        "zh-CN",
      );

      expect(result.text).toBe("你好世界");
      expect(result.provider).toBe("google");
      expect(requestUrlSpy).toHaveBeenCalledTimes(1);
      const requestArg = requestUrlSpy.mock.calls[0][0] as { url: string };
      expect(requestArg.url).toContain("translate.googleapis.com");
      expect(requestArg.url).toContain("zh-CN");
    });

    it("returns an empty result for empty input", async () => {
      const result = await TranslationService.translateText(
        "  ",
        "zh-Hans",
      );

      expect(result.text).toBe("");
      expect(requestUrlSpy).not.toHaveBeenCalled();
    });

    it("throws a descriptive error when the provider fails", async () => {
      requestUrlSpy.mockRejectedValue(new Error("network down"));

      await expect(
        TranslationService.translateText("Hello", "zh-Hans"),
      ).rejects.toThrow(/translation failed/i);
    });
  });

  describe("translateBatch", () => {
    it("translates each paragraph separately", async () => {
      requestUrlSpy.mockImplementation(async () =>
        createMockResponse("", [
          [["translated", "en", null, null], null, null, null],
        ]) as unknown as MockResponse,
      );

      const results = await TranslationService.translateBatch(
        ["One", "Two"],
        "zh-CN",
      );

      expect(results.map((r) => r.text)).toEqual(["translated", "translated"]);
      expect(requestUrlSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("collectTranslatableBlocks", () => {
    it("collects text blocks and preserves structure", () => {
      const container = document.createElement("div");
      const paragraphOne = document.createElement("p");
      paragraphOne.textContent = "First paragraph";
      const paragraphTwo = document.createElement("p");
      paragraphTwo.textContent = "Second paragraph";
      const list = document.createElement("ul");
      const listItem = document.createElement("li");
      listItem.textContent = "Item one";
      list.appendChild(listItem);
      const image = document.createElement("div");
      image.appendChild(document.createElement("img"));
      container.append(paragraphOne, paragraphTwo, list, image);

      const blocks = TranslationService.collectTranslatableBlocks(container);

      expect(blocks.length).toBe(3);
      expect(blocks.map((b) => b.textContent)).toEqual([
        "First paragraph",
        "Second paragraph",
        "Item one",
      ]);
    });

    it("skips blocks that contain no meaningful text", () => {
      const container = document.createElement("div");
      const emptyParagraph = document.createElement("p");
      emptyParagraph.textContent = "   ";
      const numberParagraph = document.createElement("p");
      numberParagraph.textContent = "123";
      const figure = document.createElement("figure");
      figure.appendChild(document.createElement("img"));
      container.append(emptyParagraph, numberParagraph, figure);

      const blocks = TranslationService.collectTranslatableBlocks(container);

      expect(blocks.length).toBe(0);
    });
  });
});
