import { createElement, type CSSProperties, type ReactNode } from "react";
import DOMPurify, { type Config } from "dompurify";

export type TrustedMarkupContentType = "html" | "svg";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const ATTRIBUTE_NAME_MAP: Readonly<Record<string, string>> = {
  class: "className",
  for: "htmlFor",
  "accept-charset": "acceptCharset",
  "alignment-baseline": "alignmentBaseline",
  "baseline-shift": "baselineShift",
  "clip-path": "clipPath",
  "clip-rule": "clipRule",
  "color-interpolation": "colorInterpolation",
  "color-interpolation-filters": "colorInterpolationFilters",
  "dominant-baseline": "dominantBaseline",
  "fill-opacity": "fillOpacity",
  "fill-rule": "fillRule",
  "flood-color": "floodColor",
  "flood-opacity": "floodOpacity",
  "font-family": "fontFamily",
  "font-size": "fontSize",
  "font-style": "fontStyle",
  "font-weight": "fontWeight",
  "letter-spacing": "letterSpacing",
  "marker-end": "markerEnd",
  "marker-mid": "markerMid",
  "marker-start": "markerStart",
  "paint-order": "paintOrder",
  "shape-rendering": "shapeRendering",
  "stop-color": "stopColor",
  "stop-opacity": "stopOpacity",
  "stroke-dasharray": "strokeDasharray",
  "stroke-dashoffset": "strokeDashoffset",
  "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin",
  "stroke-miterlimit": "strokeMiterlimit",
  "stroke-opacity": "strokeOpacity",
  "stroke-width": "strokeWidth",
  "text-anchor": "textAnchor",
  "text-decoration": "textDecoration",
  "vector-effect": "vectorEffect",
  "word-spacing": "wordSpacing",
  "xlink:href": "xlinkHref",
  "xml:space": "xmlSpace",
};

type TrustedMarkupPropValue = string | number | CSSProperties;

const HTML_SANITIZE_CONFIG = {
  RETURN_DOM_FRAGMENT: true,
  USE_PROFILES: { html: true },
} satisfies Config;

const SVG_SANITIZE_CONFIG = {
  RETURN_DOM_FRAGMENT: true,
  USE_PROFILES: {
    html: true,
    svg: true,
    svgFilters: true,
  },
  ADD_TAGS: ["foreignObject"],
  FORBID_CONTENTS: [],
  HTML_INTEGRATION_POINTS: {
    foreignobject: true,
  },
} satisfies Config;

/**
 * Converts generated markup from trusted libraries into React elements while
 * stripping active content. Use only for markup we generate locally, such as
 * Shiki-highlighted code, Mermaid SVG, and bundled icon SVG.
 */
export function trustedMarkupToReactNodes(
  markup: string,
  contentType: TrustedMarkupContentType,
): ReactNode {
  const fragment = sanitizeTrustedMarkup(markup, contentType);
  if (contentType === "svg") {
    const svg = fragment.querySelector("svg");
    return svg === null ? null : renderTrustedNode(svg, 0);
  }
  return Array.from(fragment.childNodes).map((node, index) =>
    renderTrustedNode(node, index),
  );
}

function sanitizeTrustedMarkup(
  markup: string,
  contentType: TrustedMarkupContentType,
): DocumentFragment {
  return DOMPurify.sanitize(
    markup,
    contentType === "svg" ? SVG_SANITIZE_CONFIG : HTML_SANITIZE_CONFIG,
  );
}

function renderTrustedNode(node: Node, key: number): ReactNode {
  if (node.nodeType === TEXT_NODE) return node.textContent;
  if (node.nodeType !== ELEMENT_NODE) return null;

  const element = node as Element;
  const tagName = element.localName;
  const props = trustedAttributes(element, key);
  const children = Array.from(element.childNodes)
    .map((child, index) => renderTrustedNode(child, index))
    .filter((child) => child !== null);
  return createElement(tagName, props, ...children);
}

function trustedAttributes(
  element: Element,
  key: number,
): Record<string, TrustedMarkupPropValue> {
  const props: Record<string, TrustedMarkupPropValue> = { key };
  for (const attr of Array.from(element.attributes)) {
    const safe = trustedAttribute(attr.name, attr.value);
    if (safe === null) continue;
    props[safe.name] = safe.value;
  }
  return props;
}

function trustedAttribute(
  rawName: string,
  rawValue: string,
): { readonly name: string; readonly value: TrustedMarkupPropValue } | null {
  const lowerName = rawName.toLowerCase();
  if (lowerName === "style") {
    const style = parseStyleAttribute(rawValue);
    return Object.keys(style).length === 0
      ? null
      : { name: "style", value: style };
  }
  return {
    name: ATTRIBUTE_NAME_MAP[lowerName] ?? rawName,
    value: rawValue,
  };
}

function parseStyleAttribute(value: string): CSSProperties {
  return value.split(";").reduce<CSSProperties>((style, declaration) => {
    const separator = declaration.indexOf(":");
    if (separator === -1) return style;
    const property = declaration.slice(0, separator).trim();
    const rawValue = declaration.slice(separator + 1).trim();
    if (property.length === 0 || rawValue.length === 0) return style;
    if (isUnsafeCssValue(rawValue)) return style;
    return {
      ...style,
      [cssPropertyName(property)]: rawValue,
    };
  }, {});
}

function cssPropertyName(property: string): string {
  if (property.startsWith("--")) return property;
  return property.replace(/-([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function isUnsafeCssValue(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("expression(") ||
    normalized.includes("javascript:") ||
    normalized.includes("vbscript:")
  );
}
