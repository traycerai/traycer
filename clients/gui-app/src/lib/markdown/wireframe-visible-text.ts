// What a rendered document never shows: code, styles, fallbacks, the head
// title, and anything the author hid outright.
const NEVER_RENDERED_SELECTOR =
  "script, style, noscript, template, title, [hidden]";

// Input types whose `value` is never drawn as a label.
const UNLABELLED_INPUT_TYPES = new Set([
  "hidden",
  "password",
  "checkbox",
  "radio",
  "file",
  "image",
  "color",
  "range",
]);

// Input types whose `value` is the button's caption.
const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset"]);

// What Chromium writes on a submit or reset input that names no value; a
// plain button without one is empty.
const DEFAULT_BUTTON_CAPTIONS = new Map([
  ["submit", "Submit"],
  ["reset", "Reset"],
]);

/**
 * The words a person can read in a rendered wireframe.
 *
 * Chat find counts a wireframe fence on this text rather than on its HTML, so
 * a tag name, a class or a script can never match, and the wireframe block
 * renders the same text as its find mirror so every counted hit has a home in
 * the block. Text nodes are joined with a space so words in neighbouring
 * elements do not run together; a word split across an inline element (rare
 * in a mockup) is the accepted cost of not laying the document out.
 *
 * A form control shows its words through attributes rather than text nodes,
 * so it contributes what the browser would draw for it, at its place in the
 * document: a button's caption, a text field's value or, when empty, its
 * placeholder, a closed dropdown's chosen option. Content hidden with an
 * inline `display: none` or `visibility: hidden` is left out; hiding through
 * a stylesheet rule is not seen, since the document is parsed and never laid
 * out.
 */
export function wireframeVisibleText(html: string): string {
  if (typeof DOMParser === "undefined") return "";
  const body = new DOMParser().parseFromString(html, "text/html").body;
  reduceToWhatIsDrawn(body);
  const words: string[] = [];
  const push = (text: string | null): void => {
    const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
    if (collapsed.length > 0) words.push(collapsed);
  };
  const walker = body.ownerDocument.createTreeWalker(
    body,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) {
      push(node.data);
    } else if (node instanceof HTMLInputElement) {
      push(inputCaption(node));
    } else if (node instanceof HTMLTextAreaElement) {
      // A textarea's content is a text node the walk reaches on its own; the
      // placeholder only shows while that content is empty. Exactly empty:
      // a whitespace-only value hides the placeholder too.
      if (node.value.length === 0) {
        push(node.getAttribute("placeholder"));
      }
    }
  }
  return words.join(" ");
}

/**
 * Drops what the document never draws and collapses a closed dropdown to the
 * one option it shows, so the walk that follows meets only drawn text.
 */
function reduceToWhatIsDrawn(body: HTMLElement): void {
  for (const element of body.querySelectorAll(NEVER_RENDERED_SELECTOR)) {
    element.remove();
  }
  for (const element of body.querySelectorAll<HTMLElement>("[style]")) {
    if (
      element.style.display === "none" ||
      element.style.visibility === "hidden"
    ) {
      element.remove();
    }
  }
  // A closed dropdown draws only its chosen option; a list box (multiple, or
  // sized to several rows) draws every option and keeps its text nodes.
  for (const select of body.querySelectorAll("select")) {
    if (select.multiple || select.size > 1) continue;
    const chosen =
      select.querySelector("option[selected]") ??
      select.querySelector("option");
    select.replaceWith(
      body.ownerDocument.createTextNode(chosen?.textContent ?? ""),
    );
  }
}

/** The words an input draws: its caption, its value, or its placeholder. */
function inputCaption(input: HTMLInputElement): string | null {
  const type = input.type;
  if (UNLABELLED_INPUT_TYPES.has(type)) return null;
  const value = input.getAttribute("value");
  // A submit or reset input without a value draws the browser's own caption
  // (the frame is Chromium, so these are its exact words); an explicitly
  // empty value draws an empty button.
  if (BUTTON_INPUT_TYPES.has(type)) {
    if (value !== null) return value;
    return DEFAULT_BUTTON_CAPTIONS.get(type) ?? null;
  }
  // The placeholder shows only while the value is exactly empty; a
  // whitespace-only value hides it and draws nothing readable itself.
  if (value !== null && value.length > 0) return value;
  return input.getAttribute("placeholder");
}
