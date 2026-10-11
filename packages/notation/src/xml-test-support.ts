/* A minimal well-formedness checker and tree builder for the generated MEI. Test support only. */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
}

const UNESCAPE: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function unescapeValue(raw: string): string {
  return raw.replace(/&([a-z]+);/g, (_m, name: string) => {
    const v = UNESCAPE[name];
    if (v === undefined) throw new Error(`unknown entity &${name};`);
    return v;
  });
}

const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)\s*(\/?)>/y;
const ATTR = /([A-Za-z_][\w:.-]*)="([^"<]*)"/g;

/** Parses one XML document with a single root. Throws on anything not well-formed. */
export function parseXml(xml: string): XmlElement {
  let pos = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  if (xml.startsWith("<?xml")) {
    const end = xml.indexOf("?>");
    if (end < 0) throw new Error("unterminated declaration");
    pos = end + 2;
  }
  while (pos < xml.length) {
    if (xml[pos] !== "<") {
      const next = xml.indexOf("<", pos);
      const text = xml.slice(pos, next < 0 ? xml.length : next);
      if (text.trim() !== "") throw new Error(`unexpected text "${text.trim()}"`);
      pos = next < 0 ? xml.length : next;
      continue;
    }
    TAG.lastIndex = pos;
    const m = TAG.exec(xml);
    if (m === null) throw new Error(`malformed tag at ${String(pos)}: ${xml.slice(pos, pos + 40)}`);
    const [whole, closing, name, rawAttrs, selfClosing] = m;
    pos += whole.length;
    if (closing === "/") {
      const open = stack.pop();
      if (open?.name !== name) throw new Error(`mismatched </${name ?? ""}>`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (rawAttrs ?? "").matchAll(ATTR)) {
      const key = a[1] ?? "";
      if (key in attrs) throw new Error(`duplicate attribute ${key}`);
      attrs[key] = unescapeValue(a[2] ?? "");
    }
    const el: XmlElement = { name: name ?? "", attrs, children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (root) throw new Error("multiple roots");
    else root = el;
    if (selfClosing !== "/") stack.push(el);
  }
  if (stack.length > 0) throw new Error(`unclosed <${stack[stack.length - 1]?.name ?? ""}>`);
  if (!root) throw new Error("no root element");
  return root;
}

export function findAll(el: XmlElement, name: string): XmlElement[] {
  return [...(el.name === name ? [el] : []), ...el.children.flatMap((c) => findAll(c, name))];
}
