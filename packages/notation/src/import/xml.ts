import { ImportError } from "./errors.js";

/*
 * A small tolerant XML reader for MusicXML. It works in the browser and in Node without a DOM or a
 * dependency. It handles the XML declaration, processing instructions, comments, a DOCTYPE (skipped,
 * external DTDs are never fetched), CDATA, quoted attributes and the predefined and numeric entities.
 * It does not validate. Anything not well-formed raises ImportError("malformed").
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated character data directly inside this element. */
  text: string;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (_m, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
        throw new ImportError("malformed", `bad character reference &${body};`);
      }
      return String.fromCodePoint(code);
    }
    const v = NAMED[body];
    if (v === undefined) throw new ImportError("malformed", `unknown entity &${body};`);
    return v;
  });
}

const NAME = /[A-Za-z_:][\w:.-]*/y;
const ATTR = /\s*([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const MAX_DEPTH = 200;

/** Skips a DOCTYPE, which may hold an internal subset in square brackets. Returns the index after it. */
function skipDoctype(xml: string, from: number): number {
  let depth = 0;
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ">" && depth <= 0) return i + 1;
  }
  throw new ImportError("malformed", "unterminated DOCTYPE");
}

/** Parses a document and returns its single root element. */
export function parseXml(input: string): XmlNode {
  const xml = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let pos = 0;

  const fail = (msg: string): never => {
    throw new ImportError("malformed", `${msg} at offset ${String(pos)}`);
  };

  while (pos < xml.length) {
    if (xml[pos] !== "<") {
      const next = xml.indexOf("<", pos);
      const end = next < 0 ? xml.length : next;
      const raw = xml.slice(pos, end);
      const top = stack[stack.length - 1];
      if (top !== undefined) top.text += decodeEntities(raw);
      else if (raw.trim() !== "") fail("text outside the root element");
      pos = end;
    } else if (xml.startsWith("<!--", pos)) {
      const end = xml.indexOf("-->", pos + 4);
      if (end < 0) fail("unterminated comment");
      pos = end + 3;
    } else if (xml.startsWith("<![CDATA[", pos)) {
      const end = xml.indexOf("]]>", pos + 9);
      const top = stack[stack.length - 1];
      if (end < 0 || top === undefined) return fail("bad CDATA section");
      top.text += xml.slice(pos + 9, end);
      pos = end + 3;
    } else if (xml.startsWith("<?", pos)) {
      const end = xml.indexOf("?>", pos + 2);
      if (end < 0) fail("unterminated processing instruction");
      pos = end + 2;
    } else if (xml.startsWith("<!DOCTYPE", pos)) {
      pos = skipDoctype(xml, pos + 9);
    } else if (xml.startsWith("</", pos)) {
      NAME.lastIndex = pos + 2;
      const m = NAME.exec(xml);
      const open = stack.pop();
      if (m === null || m[0] !== open?.name) {
        return fail(`unexpected closing tag at ${xml.slice(pos, pos + 12)}`);
      }
      pos = NAME.lastIndex;
      while (/\s/.test(xml[pos] ?? "")) pos++;
      if (xml[pos] !== ">") fail("bad closing tag");
      pos++;
    } else {
      NAME.lastIndex = pos + 1;
      const m = NAME.exec(xml);
      if (m === null) return fail("bad tag");
      const node: XmlNode = { name: m[0], attrs: {}, children: [], text: "" };
      pos = NAME.lastIndex;
      for (;;) {
        ATTR.lastIndex = pos;
        const a = ATTR.exec(xml);
        if (a === null) break;
        node.attrs[a[1] ?? ""] = decodeEntities(a[2] ?? a[3] ?? "");
        pos = ATTR.lastIndex;
      }
      while (/\s/.test(xml[pos] ?? "")) pos++;
      let selfClosing = false;
      if (xml[pos] === "/") {
        selfClosing = true;
        pos++;
      }
      if (xml[pos] !== ">") fail(`bad tag <${node.name}>`);
      pos++;
      const parent = stack[stack.length - 1];
      if (parent !== undefined) parent.children.push(node);
      else if (root === undefined) root = node;
      else fail("more than one root element");
      if (!selfClosing) {
        stack.push(node);
        if (stack.length > MAX_DEPTH) fail("document nested too deeply");
      }
    }
  }
  if (stack.length > 0) fail(`unclosed element <${stack[stack.length - 1]?.name ?? ""}>`);
  if (root === undefined) return fail("no root element");
  return root;
}

export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

/** Trimmed text of the first child called `name`, or undefined. */
export function childText(node: XmlNode, name: string): string | undefined {
  const c = child(node, name);
  return c === undefined ? undefined : c.text.trim();
}
