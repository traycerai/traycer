import DOMPurify from "dompurify";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_SVG_SOURCE_LENGTH = 5 * 1024 * 1024;
const MAX_SVG_DIMENSION = 8192;
const MAX_SVG_NODES = 10_000;
const MAX_FILTERS = 16;
const MAX_FILTER_PRIMITIVES = 128;
const FORBIDDEN_DECLARATION = /<!\s*(?:doctype|entity)\b/i;
const CSS_URL = /url\s*\(/i;
const NUMERIC_DIMENSION = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/i;

export function sanitizeUntrustedSvg(source: string): string {
  if (
    source.length === 0 ||
    source.length > MAX_SVG_SOURCE_LENGTH ||
    FORBIDDEN_DECLARATION.test(source)
  ) {
    throw new Error("SVG source is empty, oversized, or contains declarations");
  }

  const parsed = parseSvg(source);
  assertSvgBounds(parsed.documentElement);

  const sanitized = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_ATTR: ["style"],
    FORBID_TAGS: ["foreignObject", "script", "style"],
  });
  const clean = parseSvg(sanitized);
  stripNetworkReferences(clean.documentElement);
  assertSvgBounds(clean.documentElement);
  return new XMLSerializer().serializeToString(clean.documentElement);
}

function parseSvg(source: string): XMLDocument {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement;
  if (
    root.tagName.toLowerCase() !== "svg" ||
    root.namespaceURI !== SVG_NAMESPACE ||
    parsed.querySelector("parsererror") !== null
  ) {
    throw new Error("Image is not a valid SVG document");
  }
  return parsed;
}

function assertSvgBounds(root: Element): void {
  const nodes = root.querySelectorAll("*");
  if (nodes.length + 1 > MAX_SVG_NODES) {
    throw new Error("SVG contains too many nodes");
  }
  if (root.querySelector("svg") !== null) {
    throw new Error("Nested SVG roots are not allowed");
  }

  assertDimension(root.getAttribute("width"));
  assertDimension(root.getAttribute("height"));
  const viewBox = root.getAttribute("viewBox");
  if (viewBox !== null) assertViewBox(viewBox);

  const filters = root.querySelectorAll("filter");
  if (filters.length > MAX_FILTERS) {
    throw new Error("SVG contains too many filters");
  }
  let primitives = 0;
  for (const filter of filters)
    primitives += filter.querySelectorAll("*").length;
  if (primitives > MAX_FILTER_PRIMITIVES) {
    throw new Error("SVG filters are too complex");
  }
}

function assertDimension(value: string | null): void {
  if (value === null || value.endsWith("%")) return;
  const match = NUMERIC_DIMENSION.exec(value);
  if (match === null || Number(match[1]) > MAX_SVG_DIMENSION) {
    throw new Error("SVG dimensions exceed the supported bounds");
  }
}

function assertViewBox(value: string): void {
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isFinite(part)) ||
    parts[2] <= 0 ||
    parts[3] <= 0 ||
    parts[2] > MAX_SVG_DIMENSION ||
    parts[3] > MAX_SVG_DIMENSION
  ) {
    throw new Error("SVG viewBox exceeds the supported bounds");
  }
}

function stripNetworkReferences(root: Element): void {
  const elements: Element[] = [root, ...root.querySelectorAll("*")];
  for (const element of elements) {
    for (const attribute of [...element.attributes]) {
      if (
        attribute.localName.toLowerCase() === "href" ||
        CSS_URL.test(attribute.value)
      ) {
        element.removeAttributeNode(attribute);
      }
    }
  }
}
