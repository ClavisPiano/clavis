import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parsePrivacy } from "./privacy-text";

describe("parsePrivacy", () => {
  it("parses titles, headings, paragraphs and bullet lists", () => {
    expect(parsePrivacy("# T\n\nIntro line.\n\n## H\n- a\n- b\n\nAfter.\n")).toEqual([
      { kind: "title", text: "T" },
      { kind: "paragraph", text: "Intro line." },
      { kind: "heading", text: "H" },
      { kind: "list", items: ["a", "b"] },
      { kind: "paragraph", text: "After." },
    ]);
  });

  it("closes a list at a heading or the end, and ignores blank input", () => {
    expect(parsePrivacy("- a\n## H\n- b")).toEqual([
      { kind: "list", items: ["a"] },
      { kind: "heading", text: "H" },
      { kind: "list", items: ["b"] },
    ]);
    expect(parsePrivacy("\n\n")).toEqual([]);
  });

  it("the real policy parses into a title, sections that cover the promises, and no stray markup", () => {
    const text = readFileSync(new URL("../../../../docs/privacy.md", import.meta.url), "utf8");
    const blocks = parsePrivacy(text);
    expect(blocks[0]).toEqual({ kind: "title", text: "Privacy" });
    const headings = blocks.flatMap((b) => (b.kind === "heading" ? [b.text] : []));
    expect(headings).toEqual(
      expect.arrayContaining([
        "On your device",
        "If you create an account",
        "Keeping a copy",
        "Deleting your account",
      ]),
    );
    const all = blocks.flatMap((b) => (b.kind === "list" ? b.items : "text" in b ? [b.text] : []));
    expect(all.some((t) => /[*`[\]]/.test(t))).toBe(false);
    expect(text).not.toContain("—");
  });
});
