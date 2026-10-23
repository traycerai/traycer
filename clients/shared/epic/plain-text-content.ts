import type { JsonContent } from "@traycer/protocol/common/registry";

/**
 * A message's plain text as the composer document a chat stores: one
 * paragraph, with no text node at all for an empty prompt.
 */
export function plainTextPromptContent(prompt: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: prompt.length === 0 ? [] : [{ type: "text", text: prompt }],
      },
    ],
  };
}
