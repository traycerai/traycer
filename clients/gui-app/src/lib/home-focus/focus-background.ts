import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  compareAscending,
  shallowEqualRow,
  stabilizeRows,
} from "@/lib/home-focus/focus-identity";
import type { FocusBackgroundRow } from "@/lib/home-focus/focus-model";

/**
 * One warm chat session's contribution to the Background section. Assembled by
 * the hook from the chat session registry, which is the ONLY client-side source
 * for either list: both ride that chat's own `chat.subscribe` stream, so a chat
 * this window has never opened contributes nothing and cannot be made to.
 */
export interface FocusBackgroundChat {
  readonly epicId: string;
  readonly chatId: string;
  /** The host the session is bound to. `null` for a handle whose host the
   * registry cannot name, which makes its managed commands unaddressable and
   * therefore unstoppable. */
  readonly hostId: string | null;
  readonly taskTitle: string | null;
  /** The chat's own title, from this window's live projection. `null` when the
   * epic is not mounted here, which is the same limit that makes this whole
   * list window-local. */
  readonly chatTitle: string | null;
  /** Running commands only - the caller filters, because "running" is a
   * property of the live status rather than of the row. */
  readonly managedCommands: ReadonlyArray<ManagedCommand>;
  readonly backgroundItems: ReadonlyArray<BackgroundItem>;
}

const BACKGROUND_KIND_ORDER: Readonly<
  Record<FocusBackgroundRow["kind"], number>
> = {
  "managed-command": 0,
  "background-item": 1,
};

/**
 * The "Background" section: durable shells and in-turn background work, for the
 * tasks open in this window only.
 *
 * TWO PLANES, deliberately not merged. A managed command is a durable shell the
 * host owns across turns and restarts; a background item is a node of the turn
 * that is running right now. They can describe the same shell and they are
 * still different objects with different lifetimes, so the section lists both
 * and labels each - collapsing them would need an identity relation neither
 * plane publishes.
 *
 * `startedAtMs` is populated for managed commands only, because only their
 * `running` status carries one. Background items have no start timestamp on the
 * wire, which is the same gap that keeps elapsed time off the agent rows.
 *
 * `stoppable`:
 * - A managed command is stoppable whenever its host is known.
 *   `managedCommand.stop` is a UNARY RPC pinned to the command's own host
 *   (`useManagedCommandStop`), so the stop does not need the chat session that
 *   revealed the command - only the id and the machine.
 * - A background item is NOT stoppable from here. Its stop is a `chat.subscribe`
 *   ACTION on a warm session (`ChatSessionState.stopBackgroundItem`), which is
 *   a chat-scoped capability rather than a cross-task one; the row still opens
 *   the chat, where the action lives. This is the same "no unary decision RPC"
 *   shape that makes approvals click-through rather than inline.
 *
 * ORDERING groups a task's rows together and is total: epic, then chat, then
 * plane, then key. Not "newest first" - a background list that re-sorts itself
 * whenever a shell prints is harder to read than one that stays put, and
 * neither plane reports a start time for every row anyway.
 */
export function buildFocusBackground(
  chats: ReadonlyArray<FocusBackgroundChat>,
  previous: ReadonlyArray<FocusBackgroundRow>,
): ReadonlyArray<FocusBackgroundRow> {
  const rows = chats.flatMap((chat) => [
    ...chat.managedCommands.map((command): FocusBackgroundRow => ({
      key: managedCommandRowKey(chat, command.id),
      epicId: chat.epicId,
      chatId: chat.chatId,
      taskTitle: chat.taskTitle,
      chatTitle: chat.chatTitle,
      hostId: chat.hostId,
      label: command.description,
      kind: "managed-command",
      itemKind: null,
      startedAtMs:
        command.status.state === "running" ? command.status.startedAtMs : null,
      stoppable: chat.hostId !== null,
    })),
    ...chat.backgroundItems
      .filter(isRunningBackgroundRoot)
      .map((item): FocusBackgroundRow => ({
        key: backgroundItemRowKey(chat, item.taskId),
        epicId: chat.epicId,
        chatId: chat.chatId,
        taskTitle: chat.taskTitle,
        chatTitle: chat.chatTitle,
        hostId: chat.hostId,
        label: item.title,
        kind: "background-item",
        itemKind: item.kind,
        startedAtMs: null,
        stoppable: false,
      })),
  ]);
  rows.sort(compareFocusBackground);
  return stabilizeRows(rows, previous, shallowEqualRow);
}

/**
 * Root items only, and never a `wakeup`.
 *
 * Roots because the nested items are that root's own tree - the chat's
 * Background panel renders them as children, and Home has one line per piece of
 * work, not one per node. A `wakeup` is excluded because it is a SCHEDULE, not
 * something running: it is due at `scheduledFor` and nothing is happening in
 * the meantime, so counting it here would overstate what is live.
 */
export function isRunningBackgroundRoot(item: BackgroundItem): boolean {
  return item.parentTaskId === null && item.kind !== "wakeup";
}

/**
 * A managed-command row's key is also its ADDRESS: `managedCommand.stop` needs
 * the host, the epic and the command id, and `FocusBackgroundRow` carries none
 * of the three separately - the contract the view codes against is one flat row
 * with one opaque key. Composed and parsed in this one module, on a NUL
 * separator no id can contain, so the two halves cannot drift; an empty host
 * segment is the unaddressable case, which is exactly when `stoppable` is
 * false.
 */
const MANAGED_COMMAND_KEY_PREFIX = "managed-command";
const FOCUS_KEY_SEPARATOR = "\u0000";

function managedCommandRowKey(
  chat: FocusBackgroundChat,
  commandId: string,
): string {
  return [
    MANAGED_COMMAND_KEY_PREFIX,
    chat.hostId ?? "",
    chat.epicId,
    commandId,
  ].join(FOCUS_KEY_SEPARATOR);
}

export interface ManagedCommandRowTarget {
  readonly hostId: string;
  readonly epicId: string;
  readonly commandId: string;
}

/** `null` for any key that is not an addressable managed command - a
 * background-item row, or a command whose host was unknown when the row was
 * built. */
export function parseManagedCommandRowKey(
  key: string,
): ManagedCommandRowTarget | null {
  const segments = key.split(FOCUS_KEY_SEPARATOR);
  if (segments.length !== 4) return null;
  const [prefix, hostId, epicId, commandId] = segments;
  if (prefix !== MANAGED_COMMAND_KEY_PREFIX) return null;
  if (hostId.length === 0 || epicId.length === 0 || commandId.length === 0) {
    return null;
  }
  return { hostId, epicId, commandId };
}

function backgroundItemRowKey(
  chat: FocusBackgroundChat,
  taskId: string,
): string {
  return ["background-item", chat.epicId, chat.chatId, taskId].join(
    FOCUS_KEY_SEPARATOR,
  );
}

function compareFocusBackground(
  a: FocusBackgroundRow,
  b: FocusBackgroundRow,
): number {
  const epicDelta = compareAscending(a.epicId, b.epicId);
  if (epicDelta !== 0) return epicDelta;
  const chatDelta = compareAscending(a.chatId, b.chatId);
  if (chatDelta !== 0) return chatDelta;
  const kindDelta =
    BACKGROUND_KIND_ORDER[a.kind] - BACKGROUND_KIND_ORDER[b.kind];
  if (kindDelta !== 0) return kindDelta;
  return compareAscending(a.key, b.key);
}
