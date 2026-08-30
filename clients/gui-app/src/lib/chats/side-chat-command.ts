import type { JsonContent } from "@traycer/protocol/common/registry";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

import type { LocalSlashCommand } from "@/lib/composer/types";
import {
  isTransparentToLeadingScan,
  parseLeadingSlashCommand,
} from "@/lib/composer/tiptap-json-content";

/**
 * The composer-local `/btw` (alias `/side`) command: fork the current chat at
 * its latest checkpoint and ask the rest of the prompt THERE, leaving this chat
 * untouched - Claude Code's own `/btw` semantics, done by the GUI because the
 * GUI is the only party that can open the fork as a tab.
 *
 * Intercepted client-side, never forwarded: a provider's CLI parses a prompt
 * whose first token is `/word` as one of ITS slash commands, and an unknown one
 * short-circuits before any model call (`num_turns: 0`, no assistant output) -
 * so a `/btw …` that reached the wire would answer with nothing.
 */
export type SideChatCommandName = "btw" | "side";

export const SIDE_CHAT_COMMAND_NAMES: ReadonlyArray<SideChatCommandName> = [
  "btw",
  "side",
];

export function sideChatCommandName(name: string): SideChatCommandName | null {
  const lowered = name.toLowerCase();
  return SIDE_CHAT_COMMAND_NAMES.find((known) => known === lowered) ?? null;
}

export interface SideChatCommandSplit {
  readonly command: SideChatCommandName;
  /**
   * The prompt with the command token removed - what the side chat is asked.
   * May be empty (a bare `/btw`), which callers treat as "open the side chat
   * with nothing to say yet".
   */
  readonly rest: JsonContent;
}

/**
 * Whether submitted composer content leads with a side-chat command, and the
 * content that remains once it is stripped.
 *
 * Reads the same leading position the chip converter settles on - through the
 * atoms and indent that `isTransparentToLeadingScan` names - so a `/btw` the
 * converter turned into a chip (catalog hit or the ungated `/` fallback) and
 * one it left as text (a chip it refused because the token was not closed)
 * are both recognized. Only the document's FIRST paragraph is a command
 * context, exactly as for provider commands: a `/btw` inside a code block or
 * list stays prose.
 */
export function splitLeadingSideChatCommand(
  content: JsonContent,
): SideChatCommandSplit | null {
  const blocks = content.content ?? [];
  const blockIndex = blocks.findIndex(
    (block) => !isTransparentToLeadingScan(block),
  );
  if (blockIndex === -1) return null;
  const paragraph = blocks[blockIndex];
  if (paragraph.type !== "paragraph") return null;
  const inlines = paragraph.content ?? [];
  const inlineIndex = inlines.findIndex(
    (inline) => !isTransparentToLeadingScan(inline),
  );
  if (inlineIndex === -1) return null;
  const leading = inlines[inlineIndex];
  const stripped = stripLeadingCommand(leading);
  if (stripped === null) return null;
  // The separator is stripped in exactly one place: inside the command's own
  // text node when the question shares it (`stripLeadingCommand`), otherwise
  // off the node that follows the fully-consumed command (a chip, or a text
  // node that was nothing but the command).
  const following = inlines.slice(inlineIndex + 1);
  const restInlines = [
    ...inlines.slice(0, inlineIndex),
    ...(stripped.remainder.length === 0
      ? dropLeadingBreak(following)
      : [...stripped.remainder, ...following]),
  ];
  const restParagraph: JsonContent =
    restInlines.length === 0
      ? { type: "paragraph" }
      : { ...paragraph, content: [...restInlines] };
  return {
    command: stripped.command,
    rest: {
      ...content,
      content: [
        ...blocks.slice(0, blockIndex),
        restParagraph,
        ...blocks.slice(blockIndex + 1),
      ],
    },
  };
}

function stripLeadingCommand(node: JsonContent): {
  readonly command: SideChatCommandName;
  readonly remainder: ReadonlyArray<JsonContent>;
} | null {
  if (node.type === "slashCommand") {
    const name = node.attrs?.commandName;
    const command = typeof name === "string" ? sideChatCommandName(name) : null;
    return command === null ? null : { command, remainder: [] };
  }
  if (node.type !== "text") return null;
  const text = node.text ?? "";
  const parsed = parseLeadingSlashCommand(text);
  if (parsed === null) return null;
  const command = sideChatCommandName(parsed.name);
  if (command === null) return null;
  const rest = text.slice(parsed.end).replace(/^[ \t]/, "");
  return {
    command,
    remainder: rest.length === 0 ? [] : [{ ...node, text: rest }],
  };
}

/**
 * The separator the user typed between the command and the question. A chip is
 * followed by the space the picker inserts (already dropped by the text strip
 * above when the two shared a node); `/btw⏎question` leaves a hard break whose
 * only job was to end the command token.
 */
function dropLeadingBreak(
  inlines: ReadonlyArray<JsonContent>,
): ReadonlyArray<JsonContent> {
  if (inlines.length === 0) return inlines;
  const [first, ...rest] = inlines;
  if (first.type === "hardBreak") return rest;
  if (first.type === "text") {
    const text = (first.text ?? "").replace(/^[ \t]/, "");
    if (text.length === 0) return rest;
    if (text !== first.text) return [{ ...first, text }, ...rest];
  }
  return inlines;
}

const SIDE_CHAT_COMMAND_DESCRIPTION =
  "Ask a side question in a forked copy of this chat, without interrupting it";

/**
 * The picker rows for the two names. Local to the composer - the host has no
 * catalog entry to serve, since only the renderer can open the fork as a tab -
 * and stamped with the composer's harness so the chip they produce is
 * indistinguishable from a provider command's.
 */
export function sideChatSlashCommands(
  harnessId: GuiHarnessId,
): ReadonlyArray<LocalSlashCommand> {
  return SIDE_CHAT_COMMAND_NAMES.map((name): LocalSlashCommand => ({
    source: "local",
    harnessId,
    name,
    description:
      name === "btw"
        ? SIDE_CHAT_COMMAND_DESCRIPTION
        : `Same as /btw - ${SIDE_CHAT_COMMAND_DESCRIPTION.charAt(0).toLowerCase()}${SIDE_CHAT_COMMAND_DESCRIPTION.slice(1)}`,
    argumentHint: "<question>",
    kind: "slash-command",
    metadata: {},
    preview: {
      kind: "text",
      primary: `${SIDE_CHAT_COMMAND_DESCRIPTION} <question>`,
      secondary: null,
      mono: false,
    },
  }));
}

const SIDE_CHAT_TITLE_MAX_LENGTH = 60;

/**
 * The stored title for a side chat. Explicit rather than `""` on purpose: the
 * host gap-fills an empty title on a fork with the SOURCE's title, which both
 * blocks AI titling (it only fills an empty title) and names every side chat
 * after the conversation it came from. The question is what distinguishes one
 * side chat from the next, so it is the title; a bare `/btw` (nothing asked
 * yet) falls back to the source's name, and an untitled source stays `""` so
 * the fork remains eligible for AI titling like a fresh chat.
 */
export function sideChatTitle(
  questionText: string,
  sourceTitle: string,
): string {
  const firstLine = questionText
    .trim()
    .split(/\r\n?|\n/)[0]
    .trim();
  if (firstLine.length > 0) {
    return `Side - ${truncateTitle(firstLine)}`;
  }
  const source = sourceTitle.trim();
  return source.length === 0 ? "" : `Side - ${source}`;
}

/**
 * Counted and cut in CODE POINTS, not UTF-16 units: `slice` can land between
 * the halves of a surrogate pair (an emoji, or anything outside the BMP) and
 * leave an unpaired half that renders as `�` in the sidebar.
 */
function truncateTitle(text: string): string {
  const points = Array.from(text);
  if (points.length <= SIDE_CHAT_TITLE_MAX_LENGTH) return text;
  const kept = points.slice(0, SIDE_CHAT_TITLE_MAX_LENGTH - 1).join("");
  return `${kept.trimEnd()}…`;
}
