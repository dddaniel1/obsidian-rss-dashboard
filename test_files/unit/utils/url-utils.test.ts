import { describe, expect, it } from "vitest";
import { resolveObsidianAppUrl } from "../../../src/utils/url-utils";

describe("resolveObsidianAppUrl", () => {
  it("repairs a URL that was resolved against Obsidian's app origin", () => {
    expect(
      resolveObsidianAppUrl(
        "app://obsidian.md/assets/images/software-factories/loop-harness-factory.svg",
        "https://addyosmani.com/blog/software-factories/",
      ),
    ).toBe(
      "https://addyosmani.com/assets/images/software-factories/loop-harness-factory.svg",
    );
  });

  it("keeps the query string when repairing a mangled URL", () => {
    expect(
      resolveObsidianAppUrl(
        "app://obsidian.md/img/a.png?w=480",
        "https://example.com/post/",
      ),
    ).toBe("https://example.com/img/a.png?w=480");
  });

  it("returns null for ordinary absolute and relative URLs", () => {
    expect(
      resolveObsidianAppUrl(
        "https://example.com/a.png",
        "https://example.com/post/",
      ),
    ).toBeNull();
    expect(
      resolveObsidianAppUrl("/a.png", "https://example.com/post/"),
    ).toBeNull();
  });

  it("returns null for other app-scheme hosts", () => {
    expect(
      resolveObsidianAppUrl(
        "app://other.host/a.png",
        "https://example.com/post/",
      ),
    ).toBeNull();
  });

  it("returns null for empty input or a missing base URL", () => {
    expect(resolveObsidianAppUrl("", "https://example.com/")).toBeNull();
    expect(resolveObsidianAppUrl("app://obsidian.md/a.png", "")).toBeNull();
  });
});
