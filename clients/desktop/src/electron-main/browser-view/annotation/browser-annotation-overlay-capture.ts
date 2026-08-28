import {
  ELEMENT_PICKER_LIMITS,
  ELEMENT_PICKER_STYLE_PROPS,
} from "./browser-element-picker-script";
import { boundedString } from "../guards";

/**
 * Guest-side per-element capture. Limits and curated style names come
 * from the picker sanitizer so the overlay cannot drift from main.
 */
export function captureOverlayElement(el: Element): Record<string, unknown> {
  const rect = el.getBoundingClientRect().toJSON();
  const html = String(el instanceof HTMLElement ? el.outerHTML || "" : "");
  const truncated = html.length > ELEMENT_PICKER_LIMITS.outerHtml;
  return {
    selector: boundedString(
      selectorPath(el),
      ELEMENT_PICKER_LIMITS.selector,
      "",
    ),
    tagName: boundedString(
      String(el.tagName || "").toLowerCase(),
      ELEMENT_PICKER_LIMITS.tagName,
      "",
    ),
    elementId: el.id
      ? boundedString(el.id, ELEMENT_PICKER_LIMITS.attributeValue, "")
      : null,
    classNames: classNamesOf(el),
    attributes: attributesOf(el),
    outerHtml: truncated
      ? html.slice(0, ELEMENT_PICKER_LIMITS.outerHtml)
      : html,
    outerHtmlTruncated: truncated,
    textPreview: textOf(el),
    ariaRole: roleOf(el),
    accessibleName: accessibleNameOf(el),
    boundingBox: {
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
      top: round(rect.top),
      right: round(rect.right),
      bottom: round(rect.bottom),
      left: round(rect.left),
    },
    computedStyles: stylesOf(el),
  };
}

export function overlayElementCssRect(el: Element): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  const rect = el.getBoundingClientRect().toJSON();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function round(n: number): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;
}

function classNamesOf(el: Element): string[] {
  const out: string[] = [];
  const list = el.classList ? el.classList : [];
  for (
    let i = 0;
    i < list.length && out.length < ELEMENT_PICKER_LIMITS.classCount;
    i += 1
  ) {
    const name = String(list[i]);
    if (name) {
      out.push(boundedString(name, ELEMENT_PICKER_LIMITS.className, ""));
    }
  }
  return out;
}

function attributesOf(el: Element): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const attrs = el.attributes ? el.attributes : [];
  for (
    let i = 0;
    i < attrs.length && out.length < ELEMENT_PICKER_LIMITS.attributeCount;
    i += 1
  ) {
    const attr = attrs[i];
    if (attr === undefined) continue;
    out.push({
      name: boundedString(attr.name, 120, ""),
      value: boundedString(
        attr.value,
        ELEMENT_PICKER_LIMITS.attributeValue,
        "",
      ),
    });
  }
  return out;
}

function stylesOf(el: Element): { property: string; value: string }[] {
  const out: { property: string; value: string }[] = [];
  let cs: CSSStyleDeclaration | null = null;
  try {
    cs = getComputedStyle(el);
  } catch {
    return out;
  }
  if (!cs) return out;
  for (
    let i = 0;
    i < ELEMENT_PICKER_STYLE_PROPS.length &&
    out.length < ELEMENT_PICKER_LIMITS.styleCount;
    i += 1
  ) {
    const prop = ELEMENT_PICKER_STYLE_PROPS[i];
    if (prop === undefined) continue;
    let value = "";
    try {
      value = cs.getPropertyValue(prop);
    } catch {
      value = "";
    }
    if (value) {
      out.push({
        property: prop,
        value: boundedString(
          value.trim(),
          ELEMENT_PICKER_LIMITS.styleValue,
          "",
        ),
      });
    }
  }
  return out;
}

export function selectorPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 8) {
    const tag = String(node.tagName || "").toLowerCase();
    if (!tag) break;
    if (node.id) {
      const idSel = "#" + CSS.escape(node.id);
      try {
        if (document.querySelectorAll(idSel).length === 1) {
          parts.unshift(idSel);
          break;
        }
      } catch {
        // ignore invalid id
      }
    }
    let sel = tag;
    const parent: Element | null = node.parentElement;
    if (parent) {
      const same: Element[] = [];
      const kids = parent.children;
      for (let i = 0; i < kids.length; i += 1) {
        const kid = kids[i];
        if (kid && kid.tagName === node.tagName) same.push(kid);
      }
      if (same.length > 1)
        sel += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
    }
    parts.unshift(sel);
    if (!parent || parent === document.documentElement) break;
    node = parent;
    depth += 1;
  }
  return parts.join(" > ");
}

function inputRole(type: string | null): string | null {
  const t = (type || "text").toLowerCase();
  if (t === "button" || t === "submit" || t === "reset" || t === "image") {
    return "button";
  }
  if (t === "checkbox") return "checkbox";
  if (t === "radio") return "radio";
  if (t === "range") return "slider";
  if (t === "search") return "searchbox";
  if (t === "email" || t === "tel" || t === "url" || t === "text")
    return "textbox";
  return null;
}

function implicitRole(el: Element): string | null {
  const t = String(el.tagName || "").toLowerCase();
  if (t === "a") return el.hasAttribute("href") ? "link" : null;
  if (t === "input") return inputRole(el.getAttribute("type"));
  if (t === "img")
    return el.getAttribute("alt") === "" ? "presentation" : "img";
  const map: Record<string, string> = {
    button: "button",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    aside: "complementary",
    article: "article",
    section: "region",
    ul: "list",
    ol: "list",
    li: "listitem",
    table: "table",
    form: "form",
    select: "combobox",
    textarea: "textbox",
    dialog: "dialog",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
  };
  return map[t] ?? null;
}

function roleOf(el: Element): string | null {
  const explicit = el.getAttribute ? el.getAttribute("role") : null;
  if (explicit) {
    const first = explicit.trim().split(/\s+/)[0];
    if (first) return boundedString(first, ELEMENT_PICKER_LIMITS.ariaRole, "");
  }
  const implicit = implicitRole(el);
  return implicit
    ? boundedString(implicit, ELEMENT_PICKER_LIMITS.ariaRole, "")
    : null;
}

function textOf(el: Element): string | null {
  const htmlEl = el instanceof HTMLElement ? el : null;
  const raw =
    htmlEl !== null && typeof htmlEl.innerText === "string"
      ? htmlEl.innerText
      : el.textContent || "";
  const text = raw.replace(/\s+/g, " ").trim();
  return text
    ? boundedString(text, ELEMENT_PICKER_LIMITS.textPreview, "")
    : null;
}

function accessibleNameOf(el: Element): string | null {
  const label = el.getAttribute ? el.getAttribute("aria-label") : null;
  if (label && label.trim()) {
    return boundedString(
      label.trim(),
      ELEMENT_PICKER_LIMITS.accessibleName,
      "",
    );
  }
  const labelledby = el.getAttribute
    ? el.getAttribute("aria-labelledby")
    : null;
  if (labelledby) {
    const names: string[] = [];
    const ids = labelledby.trim().split(/\s+/);
    for (const id of ids) {
      const ref = id ? document.getElementById(id) : null;
      if (ref && ref.textContent) {
        names.push(ref.textContent.replace(/\s+/g, " ").trim());
      }
    }
    const joined = names.join(" ").trim();
    if (joined) {
      return boundedString(joined, ELEMENT_PICKER_LIMITS.accessibleName, "");
    }
  }
  const alt = el.getAttribute ? el.getAttribute("alt") : null;
  if (alt && alt.trim()) {
    return boundedString(alt.trim(), ELEMENT_PICKER_LIMITS.accessibleName, "");
  }
  const title = el.getAttribute ? el.getAttribute("title") : null;
  if (title && title.trim()) {
    return boundedString(
      title.trim(),
      ELEMENT_PICKER_LIMITS.accessibleName,
      "",
    );
  }
  return null;
}
