import { extractPlainTextFromComposerNodes } from "@traycer/protocol/common/composer-plain-text";
import type { JsonContent } from "@traycer/protocol/common/registry";

/**
 * A member's message in a bot conversation, as the member sent it. The host
 * stores the text sent as one paragraph per block between blank lines, with
 * a hard break for each newline inside a block, so this reads it back with a
 * blank line between top-level blocks: its Markdown then means what it meant
 * in the box, a plain line under a quote staying out of the quote and two
 * paragraphs staying two.
 */
export function botMemberText(content: JsonContent): string {
  return (content.content ?? [])
    .flatMap((block) => {
      const text = extractPlainTextFromComposerNodes([block]);
      return text.length > 0 ? [text] : [];
    })
    .join("\n\n");
}
