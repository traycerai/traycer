const HEADING_TAGS: ReadonlySet<string> = new Set([
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

const STRIP_TAGS: ReadonlySet<string> = new Set(["BLOCKQUOTE"]);

export function sanitizeMarkdownHtml(html: string): HTMLElement | null {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    return null;
  }
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const body = parsed.body;
  demoteHeadingsToBoldParagraphs(body);
  unwrapTags(body, STRIP_TAGS);
  return body;
}

function demoteHeadingsToBoldParagraphs(root: HTMLElement): void {
  HEADING_TAGS.forEach((tag) => {
    const headings = Array.from(root.querySelectorAll(tag.toLowerCase()));
    headings.forEach((heading) => {
      const paragraph = root.ownerDocument.createElement("p");
      const strong = root.ownerDocument.createElement("strong");
      while (heading.firstChild !== null) {
        strong.appendChild(heading.firstChild);
      }
      paragraph.appendChild(strong);
      heading.replaceWith(paragraph);
    });
  });
}

function unwrapTags(root: HTMLElement, tags: ReadonlySet<string>): void {
  tags.forEach((tag) => {
    const matches = Array.from(root.querySelectorAll(tag.toLowerCase()));
    matches.forEach((element) => {
      const parent = element.parentNode;
      if (parent === null) return;
      while (element.firstChild !== null) {
        parent.insertBefore(element.firstChild, element);
      }
      parent.removeChild(element);
    });
  });
}
