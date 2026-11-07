/**
 * A bot message box's content, the agent composer's editor document, and the
 * text a message carries. The wire takes Markdown with the three mention
 * tokens (`bot-mentions.ts`), so a chip in the box is its token as text and an
 * image is not text at all: it rides `attachments` beside it.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";
import { jsonContentToMarkdown } from "@traycer/protocol/common/json-content-serializer";
import {
  BOT_CONVERSATION_ATTACHMENT_MEDIA_TYPES,
  type BotConversationAttachment,
} from "@traycer/protocol/host/bot/conversation-schemas";
import {
  BOT_MENTION_TOKEN,
  mentionOfToken,
  type BotMentionKind,
} from "@/lib/bots/bot-mentions";
import { base64ToBytes } from "@/lib/composer/image-base64";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import {
  BOT_TOKEN_CONTEXT_TYPE,
  mentionChipText,
} from "@/lib/composer/tiptap-json-content";

export const EMPTY_BOT_BOX: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

/** `content` as text: each chip what `chip` says, its images left out. */
function withoutImages(
  content: JsonContent,
  chip: (attrs: Record<string, unknown>) => string,
): JsonContent {
  const children = content.content?.flatMap((child): JsonContent[] => {
    if (child.type === "imageAttachment" || child.type === "attachmentGroup") {
      return [];
    }
    if (
      child.type === "mention" &&
      child.attrs?.contextType === BOT_TOKEN_CONTEXT_TYPE
    ) {
      return [{ type: "text", text: chip(child.attrs), marks: child.marks }];
    }
    if (child.type === "mention" && child.attrs?.contextType === "host") {
      return [
        {
          type: "text",
          text: `@host:${String(child.attrs.label)} [hostId=${String(child.attrs.hostId ?? child.attrs.id)}]`,
          marks: child.marks,
        },
      ];
    }
    const kept = withoutImages(child, chip);
    return [child.type === "blockquote" ? quotedLines(kept) : kept];
  });
  return children === undefined ? content : { ...content, content: children };
}

/**
 * A quote as a person writes one: the serializer would wrap it for a model,
 * and a channel's row and the bot read Markdown.
 */
function quotedLines(blockquote: JsonContent): JsonContent {
  const lines = asMarkdown({ ...blockquote, type: "doc" }).split("\n");
  return {
    type: "paragraph",
    content: lines.flatMap((line, index): JsonContent[] => [
      ...(index === 0 ? [] : [{ type: "hardBreak" }]),
      { type: "text", text: line.length === 0 ? ">" : `> ${line}` },
    ]),
  };
}

function asMarkdown(content: JsonContent): string {
  return jsonContentToMarkdown(content, {
    mentionFormat: "user",
    platform: "POSIX",
  }).trim();
}

/** The message's text as sent: Markdown, each chip its token. */
export function botBoxWire(content: JsonContent): string {
  return asMarkdown(withoutImages(content, (attrs) => String(attrs.id)));
}

/** The message's text as the person reads it: each chip its `@Name`. */
export function botBoxText(content: JsonContent): string {
  return asMarkdown(withoutImages(content, mentionChipText));
}

function inlineContentOf(
  line: string,
  nameOf: (kind: BotMentionKind, id: string) => string | null,
): JsonContent[] {
  const nodes: JsonContent[] = [];
  let at = 0;
  for (const match of line.matchAll(BOT_MENTION_TOKEN)) {
    const token = match[0];
    const { kind, id } = mentionOfToken(token);
    const name = nameOf(kind, id);
    if (name === null) continue;
    if (match.index > at) {
      nodes.push({ type: "text", text: line.slice(at, match.index) });
    }
    nodes.push({
      type: "mention",
      attrs: { contextType: BOT_TOKEN_CONTEXT_TYPE, id: token, label: name },
    });
    at = match.index + token.length;
  }
  if (at < line.length) nodes.push({ type: "text", text: line.slice(at) });
  return nodes;
}

/**
 * Text the box did not write as content: a failed row's, or a draft put in it
 * from elsewhere. Each token the box can name is a chip; one it cannot stays
 * as written, as it does on the row. The rest is the text as typed, which the
 * send writes back unchanged.
 */
export function botBoxContentOf(
  text: string,
  nameOf: (kind: BotMentionKind, id: string) => string | null,
): JsonContent {
  return {
    type: "doc",
    content: text.split("\n\n").map((paragraph) => {
      const content = paragraph
        .split("\n")
        .flatMap((line, index): JsonContent[] => [
          ...(index === 0 ? [] : [{ type: "hardBreak" }]),
          ...inlineContentOf(line, nameOf),
        ]);
      return content.length === 0
        ? { type: "paragraph" }
        : { type: "paragraph", content };
    }),
  };
}

/** The images the box holds, as `bot.conversation.send@1.4` carries them. */
export function botBoxAttachments(
  content: JsonContent,
): ReadonlyArray<BotConversationAttachment> {
  return collectImageAtoms(content).flatMap(
    ({ b64content, fileName, mimeType }) => {
      const mediaType = BOT_CONVERSATION_ATTACHMENT_MEDIA_TYPES.find(
        (type) => type === mimeType,
      );
      if (mediaType === undefined || b64content === null) return [];
      const bytes = base64ToBytes(b64content);
      if (bytes === null) return [];
      return [
        {
          b64content,
          mediaType,
          fileName,
          size: bytes.byteLength,
        },
      ];
    },
  );
}
