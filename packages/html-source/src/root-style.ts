import { parseHtmlSource } from "./parse";
import { applySplices } from "./source";
import { declarationSplices, declarations, scanCss } from "./style";
import type { HtmlElement, SourceChange, SourceRange } from "./types";

export interface RootCustomProperty {
  name: string;
  value: string;
  important: boolean;
}
export type RootStyleMiss = {
  ok: false;
  reason:
    | "missing-style"
    | "missing-root"
    | "malformed-style"
    | "invalid-style-property"
    | "invalid-style-value"
    | "unsafe-context";
};

function rootBlock(
  text: string,
):
  | { ok: true; element: HtmlElement; range: SourceRange; css: string }
  | RootStyleMiss {
  const element = parseHtmlSource(text).elements.find(
    (node) => node.tagName === "style",
  );
  if (!element) return { ok: false, reason: "missing-style" };
  if (
    !element.startTag ||
    !element.endTag ||
    !element.isUniqueSource ||
    element.namespaceURI !== "http://www.w3.org/1999/xhtml"
  )
    return { ok: false, reason: "unsafe-context" };
  const source = text.slice(element.startTag.end, element.endTag.start);
  const scan = scanCss(source);
  if (!scan) return { ok: false, reason: "malformed-style" };
  let previous = 0;
  for (const block of scan.blocks) {
    for (const semicolon of scan.semicolons) {
      if (semicolon >= previous && semicolon < block.start)
        previous = semicolon + 1;
    }
    const selector = source
      .slice(previous, block.start)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .trim();
    if (selector.toLowerCase() === ":root") {
      const range = {
        start: element.startTag.end + block.start + 1,
        end: element.startTag.end + block.end - 1,
      };
      return {
        ok: true,
        element,
        range,
        css: text.slice(range.start, range.end),
      };
    }
    previous = block.end;
  }
  return { ok: false, reason: "missing-root" };
}

/** Winning declarations in the first style element's first top-level :root. */
export function readRootCustomProperties(
  text: string,
): { ok: true; properties: RootCustomProperty[] } | RootStyleMiss {
  const root = rootBlock(text);
  if (!root.ok) return root;
  const scan = scanCss(root.css);
  if (!scan) return { ok: false, reason: "malformed-style" };
  const properties = new Map<string, RootCustomProperty>();
  for (const declaration of declarations(root.css, scan)) {
    if (!/^--[\w-]+$/.test(declaration.name)) continue;
    const previous = properties.get(declaration.name);
    if (previous?.important && !declaration.important) continue;
    properties.set(declaration.name, {
      name: declaration.name,
      value: root.css.slice(
        declaration.valueRange.start,
        declaration.valueRange.end,
      ),
      important: declaration.important,
    });
  }
  return { ok: true, properties: [...properties.values()] };
}

/** Raw CSS is not HTML-decoded or serialized; only this declaration changes. */
export function setRootCustomProperty(
  text: string,
  name: string,
  value: string | null,
): ({ ok: true } & SourceChange) | RootStyleMiss {
  if (!/^--[\w-]+$/.test(name))
    return { ok: false, reason: "invalid-style-property" };
  if (
    value !== null &&
    (!value.isWellFormed() ||
      /<\/style[\t\n\r\f />]/i.test(value) ||
      value.includes("\0"))
  )
    return { ok: false, reason: "invalid-style-value" };
  const root = rootBlock(text);
  if (!root.ok) return root;
  const plan = declarationSplices(root.css, name, value);
  if (!plan.ok) return plan;
  const changed = applySplices(
    text,
    plan.splices.map((splice) => ({
      ...splice,
      start: splice.start + root.range.start,
      end: splice.end + root.range.start,
    })),
  );
  // A raw-text terminator must never turn CSS data into sibling HTML.
  const after = rootBlock(changed.text);
  const delta = changed.text.length - text.length;
  if (
    !after.ok ||
    after.element.startTag?.start !== root.element.startTag?.start ||
    after.element.endTag?.start !== (root.element.endTag?.start ?? 0) + delta
  )
    return { ok: false, reason: "unsafe-context" };
  return { ok: true, ...changed };
}
