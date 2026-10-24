import { FIND_BLOCK_ATTR } from "@/lib/find-engine/find-blocks";

/**
 * Marks the root of a reply's rendered text (a `TextSegment`), the only part
 * of a turn read aloud: tool cards, reasoning and notices are not the reply.
 */
export const SPOKEN_TEXT_ATTR = "data-spoken-text";

/** Marks a control whose label is prose the reader reads (a next-step option). */
export const SPOKEN_CONTROL_ATTR = "data-spoken-control";

/** Never read: code, diagrams and media, and the find mirrors beside them. */
const SKIPPED_SELECTOR = [
  "pre",
  "img",
  "svg",
  "video",
  "audio",
  "iframe",
  "script",
  "style",
  "template",
  "[inert]",
  "[hidden]",
  '[aria-hidden="true"]',
  "[data-quote-code-block]",
  `[${FIND_BLOCK_ATTR}]`,
].join(",");

const CONTROL_SELECTOR =
  'button, input, select, textarea, [role="button"], [role="menuitem"]';

/** Controls that show prose: agent and artifact chips, next-step options. */
const READ_CONTROL_SELECTOR = [
  "[data-agent-reference]",
  "[data-traycer-ref]",
  `[${SPOKEN_CONTROL_ATTR}]`,
].join(",");

const BLOCK_SELECTOR = [
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul",
].join(",");

/**
 * A reply's paragraphs as the reader sees them, read from the reply's own
 * rendered DOM when Play is pressed. Speech is the display by construction:
 * chips read their label, next steps their prose and option labels, and raw
 * HTML whatever the sanitized render kept on screen.
 *
 * `turn` is the row's `[data-assistant-turn]` element; a subagent card's
 * conversation inside it renders through the same text segment, and is not
 * this reply.
 */
export function spokenParagraphsFromRenderedReply(turn: Element): string[] {
  const reader = new ParagraphReader();
  for (const root of turn.querySelectorAll(`[${SPOKEN_TEXT_ATTR}]`)) {
    if (root.closest("[data-subagent-conversation]") !== null) continue;
    reader.flush();
    reader.read(root);
    reader.flush();
  }
  return reader.paragraphs;
}

class ParagraphReader {
  readonly paragraphs: string[] = [];
  private current = "";

  flush(): void {
    const paragraph = this.current.replace(/\s+/g, " ").trim();
    if (paragraph.length > 0) this.paragraphs.push(paragraph);
    this.current = "";
  }

  read(node: Node): void {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        this.current += child.textContent ?? "";
        continue;
      }
      if (!(child instanceof Element) || !shown(child)) continue;
      if (child.tagName === "BR") {
        this.current += " ";
        continue;
      }
      const block = child.matches(BLOCK_SELECTOR);
      if (block) this.flush();
      this.read(child);
      if (block) this.flush();
    }
  }
}

function shown(element: Element): boolean {
  if (element.matches(SKIPPED_SELECTOR)) return false;
  if (
    element.matches(CONTROL_SELECTOR) &&
    !element.matches(READ_CONTROL_SELECTOR)
  ) {
    return false;
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.display !== "none" && style?.visibility !== "hidden";
}
