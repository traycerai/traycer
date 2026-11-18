import type {
  OpencodeLine,
  OpencodeLineHeld,
} from "@traycer/protocol/common/opencode-line";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";

type ChatLineFacts = Pick<Chat, "activeSessionChain"> & {
  readonly opencodeLine?: OpencodeLine | undefined;
};

/** The harnesses that run the `opencode` binary. */
const OPENCODE_FAMILY_HARNESSES: ReadonlySet<string> = new Set([
  "opencode",
  "traycer",
  "openrouter",
  "huggingface",
]);

/** Whether `harnessId` runs the `opencode` binary, and so a chat's line. */
export function isOpencodeFamilyHarness(harnessId: string): boolean {
  return OPENCODE_FAMILY_HARNESSES.has(harnessId);
}

/**
 * The OpenCode line an open chat runs, for the catalogs its composer reads:
 * the line on its record, or 1 for a chat whose OpenCode-family session
 * started before lines were recorded. `null` for a chat that has not run OpenCode yet,
 * which the host answers with the line a new chat would start on.
 */
export function chatOpencodeLine(chat: ChatLineFacts): OpencodeLine | null {
  if (chat.opencodeLine !== undefined) return chat.opencodeLine;
  const chainHarness = chat.activeSessionChain?.harnessId;
  return chainHarness !== undefined && isOpencodeFamilyHarness(chainHarness)
    ? 1
    : null;
}

/** Whether this chat runs OpenCode 1.x, so it can be continued on 2.x. */
export function chatRunsOpencodeLineOne(
  chat: ChatLineFacts & Pick<Chat, "settings">,
): boolean {
  return (
    chat.settings?.harnessId === "opencode" && chatOpencodeLine(chat) === 1
  );
}

/** Whether a host's negotiated `epic.createChat` takes a line (1.3). */
export function epicCreateChatCarriesOpencodeLine(
  version: SchemaVersion | null,
): boolean {
  if (version === null) return false;
  return version.major > 1 || (version.major === 1 && version.minor >= 3);
}

/**
 * Whether a host's negotiated `providers.setSelection` is 2.3 or later, where a
 * Managed line picked in Settings moves existing chats too.
 */
export function providersSetSelectionMovesChats(
  version: SchemaVersion | null,
): boolean {
  if (version === null) return false;
  return version.major > 2 || (version.major === 2 && version.minor >= 3);
}

/**
 * The composer's line for a chat the host holds on its current line. Only
 * `model_unavailable` names the other line: for it, the host compared the two
 * lines. A binary that cannot be read may be a PATH or custom pick of either
 * line, so that sentence names the pick rather than a line.
 */
export function opencodeLineHeldCopy(held: OpencodeLineHeld): string {
  const current = `OpenCode ${String(held.line)}.x`;
  switch (held.reason) {
    case "background_work":
      return `Stays on ${current} until its background work ends.`;
    case "model_unavailable":
      return `Stays on ${current} because OpenCode ${String(held.line === 1 ? 2 : 1)}.x can't run this message.`;
    case "binary_unavailable":
      return `Stays on ${current} until the OpenCode you picked is ready.`;
  }
}
