export interface ArtboardCssDeclaration {
  readonly property: string;
  readonly value: string;
}
export type ArtboardCssValidation =
  | {
      readonly ok: true;
      readonly declarations: readonly ArtboardCssDeclaration[];
    }
  | { readonly ok: false; readonly detail: string };
export type SupportsCss = (property: string, value: string) => boolean;

interface CssScanState {
  readonly stack: string[];
  quote: string | null;
  comment: boolean;
  urlDepth: number | null;
  escaped: boolean;
  buffer: string;
}

/** Returns the last consumed index, or null for punctuation in ordinary CSS. */
function scanCssLiteral(
  state: CssScanState,
  text: string,
  index: number,
): number | null {
  const char = text[index];
  if (state.comment) {
    if (char === "*" && text[index + 1] === "/") {
      state.comment = false;
      state.buffer += " ";
      return index + 1;
    }
    return index;
  }
  if (state.escaped) {
    state.buffer += char;
    state.escaped = false;
    return index;
  }
  if (char === "\\") {
    state.buffer += char;
    state.escaped = true;
    return index;
  }
  if (state.quote !== null) {
    state.buffer += char;
    if (char === state.quote) state.quote = null;
    return index;
  }
  if (char === '"' || char === "'") {
    state.quote = char;
    state.buffer += char;
    return index;
  }
  if (char === "/" && text[index + 1] === "*" && state.urlDepth === null) {
    state.comment = true;
    return index + 1;
  }
  return null;
}

function scanCssBlock(
  state: CssScanState,
  text: string,
  index: number,
): boolean {
  const char = text[index];
  if (char === "(" || char === "[" || char === "{") {
    state.stack.push(char);
    const next = text.slice(index + 1).trimStart()[0];
    if (
      char === "(" &&
      /(?:^|[^A-Za-z0-9_-])url$/i.test(state.buffer) &&
      next !== '"' &&
      next !== "'"
    )
      state.urlDepth = state.stack.length;
  }
  const pairs: Readonly<Record<string, string>> = {
    ")": "(",
    "]": "[",
    "}": "{",
  };
  if (Object.hasOwn(pairs, char)) {
    if (state.stack.length === state.urlDepth) state.urlDepth = null;
    if (state.stack.pop() !== pairs[char]) return false;
  }
  return true;
}

function invalidDeclaration(declaration: string): ArtboardCssValidation {
  return {
    ok: false,
    detail: `Invalid declaration: ${declaration.trim().slice(0, 120) || "unfinished value"}`,
  };
}

/** Split only top-level declarations; the browser decides property/value validity. */
export function validateArtboardCss(
  text: string,
  supports: SupportsCss,
): ArtboardCssValidation {
  const declarations: ArtboardCssDeclaration[] = [];
  const state: CssScanState = {
    stack: [],
    quote: null,
    comment: false,
    urlDepth: null,
    escaped: false,
    buffer: "",
  };
  const accept = (): ArtboardCssValidation | null => {
    const declaration = state.buffer.trim();
    state.buffer = "";
    if (declaration === "") return null;
    const colon = declaration.indexOf(":");
    if (colon < 1) return invalidDeclaration(declaration);
    const property = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    const browserValue = value.replace(/\s*!\s*important\s*$/i, "").trim();
    if (
      !/^(?:--[A-Za-z0-9_-]+|-?[A-Za-z][A-Za-z0-9-]*)$/.test(property) ||
      browserValue === "" ||
      !supports(property, browserValue)
    )
      return invalidDeclaration(declaration);
    declarations.push({
      property: property.startsWith("--") ? property : property.toLowerCase(),
      value,
    });
    return null;
  };
  for (let index = 0; index < text.length; index++) {
    const consumed = scanCssLiteral(state, text, index);
    if (consumed !== null) {
      index = consumed;
      continue;
    }
    const char = text[index];
    if (!scanCssBlock(state, text, index))
      return invalidDeclaration(state.buffer + char);
    if (char === ";" && state.stack.length === 0) {
      const result = accept();
      if (result !== null) return result;
    } else state.buffer += char;
  }
  if (
    state.quote !== null ||
    state.comment ||
    state.escaped ||
    state.stack.length > 0
  )
    return invalidDeclaration(state.buffer);
  const result = accept();
  return result ?? { ok: true, declarations };
}
export function browserSupportsCss(property: string, value: string): boolean {
  return CSS.supports(property, value);
}
