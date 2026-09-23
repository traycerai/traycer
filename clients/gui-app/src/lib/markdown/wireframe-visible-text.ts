// What a rendered document never shows: code, styles, fallbacks, the head
// title, and anything the author hid outright.
const NEVER_RENDERED_SELECTOR =
  "script, style, noscript, template, title, [hidden]";

/**
 * The words a person can read in a rendered wireframe.
 *
 * Chat find counts a wireframe fence on this text rather than on its HTML, so
 * a tag name, a class or a script can never match, and the wireframe block
 * renders the same text as its find mirror so every counted hit has a home in
 * the block. Text nodes are joined with a space so words in neighbouring
 * elements do not run together; a word split across an inline element (rare
 * in a mockup) is the accepted cost of not laying the document out. A form
 * control shows its words through attributes rather than text nodes (a
 * placeholder, a submit button's value), so those count too, at the control's
 * place in the document.
 */
export function wireframeVisibleText(html: string): string {
  if (typeof DOMParser === "undefined") return "";
  const body = new DOMParser().parseFromString(html, "text/html").body;
  for (const element of body.querySelectorAll(NEVER_RENDERED_SELECTOR)) {
    element.remove();
  }
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
      if (node.type === "hidden" || node.type === "password") continue;
      push(node.getAttribute("placeholder"));
      push(node.getAttribute("value"));
    } else if (node instanceof HTMLTextAreaElement) {
      push(node.getAttribute("placeholder"));
    }
  }
  return words.join(" ");
}
