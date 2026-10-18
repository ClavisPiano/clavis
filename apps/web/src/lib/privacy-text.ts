/*
 * The privacy page renders `docs/privacy.md`, so the policy has one source. The file uses a tiny
 * subset of Markdown on purpose: one `#` title, `##` headings, `-` bullets and paragraphs.
 */

export type PrivacyBlock =
  | { kind: "title"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

export function parsePrivacy(markdown: string): PrivacyBlock[] {
  const blocks: PrivacyBlock[] = [];
  let list: string[] | undefined;
  const closeList = (): void => {
    if (list) blocks.push({ kind: "list", items: list });
    list = undefined;
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      closeList();
    } else if (line.startsWith("- ")) {
      (list ??= []).push(line.slice(2).trim());
    } else {
      closeList();
      if (line.startsWith("## ")) blocks.push({ kind: "heading", text: line.slice(3).trim() });
      else if (line.startsWith("# ")) blocks.push({ kind: "title", text: line.slice(2).trim() });
      else blocks.push({ kind: "paragraph", text: line });
    }
  }
  closeList();
  return blocks;
}
