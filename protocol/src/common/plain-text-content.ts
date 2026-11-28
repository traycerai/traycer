import type { JsonContent } from "./registry";

/**
 * Plain text as a stored message's document. Blank lines split paragraphs; a
 * single newline is a hard break INSIDE its paragraph. The markdown
 * serializer joins paragraphs with a blank line and renders a hard break as
 * "\n", so this is the only mapping under which the stored message
 * re-serializes to the original text. One paragraph per line doubled every
 * newline on the way back out.
 *
 * Shared because a member's bot post is stored this way by the host and
 * drawn this way by the app before the host's row arrives (Tracy Bots T249):
 * the two must be the same document.
 */
export function plainTextJsonContent(text: string): JsonContent {
  if (text.length === 0) return { type: "doc", content: [] };
  return {
    type: "doc",
    content: text.split(/\n{2,}/).map((paragraph) => ({
      type: "paragraph",
      ...(paragraph.length === 0
        ? {}
        : {
            content: paragraph
              .split("\n")
              .flatMap((line, index) => [
                ...(index === 0 ? [] : [{ type: "hardBreak" as const }]),
                ...(line.length === 0
                  ? []
                  : [{ type: "text" as const, text: line }]),
              ]),
          }),
    })),
  };
}

/**
 * `content` with its images after it, in a paragraph of their own (an
 * `imageAttachment` node is inline), as a member's bot post stores the images
 * it carries.
 */
export function withImageParagraph(
  content: JsonContent,
  images: ReadonlyArray<JsonContent>,
): JsonContent {
  if (images.length === 0) return content;
  return {
    ...content,
    content: [
      ...(content.content ?? []),
      { type: "paragraph", content: [...images] },
    ],
  };
}
