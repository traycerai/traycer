import { useEffect } from "react";
import { useStore } from "zustand";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatQueueState } from "@traycer/protocol/host/agent/gui/subscribe";
import type { SetupCardWindowIdentity } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import {
  buildSetupCardRows,
  type SetupCardRow,
} from "@/stores/chats/setup-card-rows";
import {
  readEpicCreateSeed,
  releaseEpicCreateSeed,
} from "@/lib/worktree/pending-epic-create-seeds";

/**
 * Module-private stable empty partition, mirroring `chat-tile.tsx`'s own. A
 * fresh `[]` per pass would be a new identity on every store change; the value
 * is only read, never stored, so one constant is enough.
 */
const EMPTY_SETUP_CARD_WINDOWS: ReadonlyArray<SetupCardWindowIdentity> = [];

interface EpicCreateSeedHoldDriverOptions {
  readonly handle: ChatSessionStoreHandle;
}

/**
 * Releases this chat's create-time binding-seed hold once the chat's own
 * worktree provisioning has an outcome.
 *
 * A DEFERRED `epic.create` responds before its `git worktree add` runs, so the
 * host has no binding row for the new epic at the response and the create-path
 * refetch would return `{ rows: [] }` and clobber the folders the user picked.
 * The marker module holds that epic's listing; this driver is what ends the
 * hold, and `worktree.listBindingsForEpic` then refetches into the worktree row.
 *
 * READ AS A LEVEL, NOT AN EDGE. Every store change re-asks "is this chat still
 * provisioning?" rather than watching for a transition, because two of the
 * cases that must release produce no transition at all: a tile mounted AFTER
 * the add finished (its first snapshot is already `ready`), and a create the
 * host silently sent down its synchronous fallback (no seeded queue item, no
 * creating window - its message is a transcript row). An edge-triggered
 * "left `creating`" driver would miss both and run to the timeout.
 *
 * Holds unconditionally while `snapshotLoaded` is false. A store is constructed
 * with `snapshotLoaded: false` and an EMPTY queue, and a reconnect clears it
 * again; the tile mounts its hooks before the snapshot, so an unguarded read
 * would see the empty queue and release before the host had even committed the
 * chat. It is also what makes the UNHELD landing entry's release benign: a
 * snapshot implies `ready`, and `ready` implies the owner binding is written
 * (by the pre-commit `resolveIntent`, or else by the session's own Local heal
 * inside `initialize`), so that refetch returns host truth.
 *
 * SCOPED TO THE PAIR THIS TILE OWNS. It returns early unless `handle.chatId`
 * owns a marker entry, so a sibling chat tile opened in the epic during the
 * window - which would read the seeded message id, miss it in its own queue and
 * release on its first snapshot - releases nothing. The terminal-agent landing
 * create files under `chatId: null` and is therefore never this driver's.
 */
export function useEpicCreateSeedHoldDriver(
  options: EpicCreateSeedHoldDriverOptions,
): void {
  const { handle } = options;
  const snapshotLoaded = useStore(
    handle.store,
    (state) => state.snapshotLoaded,
  );
  const queue = useStore(handle.store, (state) => state.queue);
  const events = useStore(handle.store, (state) => state.events);
  // The whole-log setup partition, for the same reason the transcript takes it:
  // on the windowed line `events` alone is not authoritative about how many
  // windows exist, and the card row's state is the rollup of ONE window.
  const setupCardWindows = useStore(
    handle.store,
    (state) => state.transcriptDerived?.setupCardWindows,
  );

  const { epicId, chatId } = handle;
  useEffect(() => {
    const entry = readEpicCreateSeed(epicId, chatId);
    if (entry === null) return;
    if (!snapshotLoaded) return;
    if (
      stillProvisioning({
        seededMessageId: entry.seededMessageId,
        epicId,
        chatId,
        queue,
        events,
        setupCardWindows: setupCardWindows ?? EMPTY_SETUP_CARD_WINDOWS,
      })
    ) {
      return;
    }
    releaseEpicCreateSeed(epicId, chatId);
  }, [epicId, chatId, snapshotLoaded, queue, events, setupCardWindows]);
}

interface StillProvisioningInput {
  readonly seededMessageId: string | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly queue: ChatQueueState;
  readonly events: ReadonlyArray<ChatEvent>;
  readonly setupCardWindows: ReadonlyArray<SetupCardWindowIdentity>;
}

/**
 * The hold condition: the seeded message is STILL QUEUED and its setup card has
 * not reached an outcome.
 *
 * Both conjuncts are needed and neither is redundant:
 *
 *  - "in `state.queue.items` in ANY status", because a user pause flips the
 *    seeded row to `paused` mid-add and a status-narrowed read would release
 *    there. A row that has LEFT the queue was accepted (the add succeeded and
 *    the turn started) or cancelled (which materializes the intent first), so
 *    either way the outcome exists.
 *  - the card row is `creating` or does not exist yet. `setting-up` and `ready`
 *    both mean the add is done; `failed` means the rows stay the source folders
 *    - which is what the seed already showed - and the card offers Retry;
 *    `cancelled` is terminal too. "Does not exist yet" is the window between
 *    the response and the drain's `setup.creating`.
 *
 * The LAST row with this triggering id, not the first: a Retry opens a fresh
 * window under the same seeded message id, and the live one is the answer.
 */
function stillProvisioning(input: StillProvisioningInput): boolean {
  const { seededMessageId } = input;
  // Nothing was seeded, so there is nothing to wait for. (The unheld landing
  // entry of a create with no initial message; the driver never owns the
  // terminal-agent entry, which is filed under a null chat id.)
  if (seededMessageId === null) return false;
  const stillQueued = input.queue.items.some(
    (item) => item.kind === "prompt" && item.messageId === seededMessageId,
  );
  if (!stillQueued) return false;
  const rows = buildSetupCardRows(
    input.events,
    { epicId: input.epicId, ownerId: input.chatId, ownerKind: "chat" },
    input.setupCardWindows,
  );
  let seededRow: SetupCardRow | null = null;
  for (const row of rows) {
    if (row.triggeringMessageId === seededMessageId) seededRow = row;
  }
  if (seededRow === null) return true;
  return seededRow.model.aggregate.state === "creating";
}
