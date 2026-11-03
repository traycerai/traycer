import { useEffect } from "react";
import { useStore } from "zustand";
import type { ChatMessageDelivery } from "@traycer/protocol/host/agent/gui/message-delivery";
import type { OpenChatQueueState } from "@traycer/protocol/host/agent/gui/subscribe";
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

import type { OpenChatEvent } from "@traycer/protocol/host/agent/gui/open-harness-wire";

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
 * the add finished (its first snapshot is already `started`), and a create the
 * host silently sent down its synchronous fallback (no delivery record, no
 * creating window - its message is a transcript row). An edge-triggered
 * "left `creating`" driver would miss both and run to the timeout.
 *
 * Holds unconditionally while `snapshotLoaded` is false. A store is constructed
 * with `snapshotLoaded: false`, no delivery record and an EMPTY queue, and a
 * reconnect clears it again; the tile mounts its hooks before the snapshot, so
 * an unguarded read would find nothing waiting and release before the host had
 * even committed the chat. It is also what makes the UNHELD landing entry's
 * release benign: a snapshot implies `ready`, and `ready` implies the owner
 * binding is written (by the pre-commit `resolveIntent`, or else by the
 * session's own Local heal inside `initialize`), so that refetch returns host
 * truth.
 *
 * SCOPED TO THE PAIR THIS TILE OWNS. It returns early unless `handle.chatId`
 * owns a marker entry, so a sibling chat tile opened in the epic during the
 * window - which would read the seeded message id, find neither a delivery
 * naming it nor a queue item and release on its first snapshot - releases
 * nothing. The terminal-agent landing create files under `chatId: null` and is
 * therefore never this driver's.
 */
export function useEpicCreateSeedHoldDriver(
  options: EpicCreateSeedHoldDriverOptions,
): void {
  const { handle } = options;
  const snapshotLoaded = useStore(
    handle.store,
    (state) => state.snapshotLoaded,
  );
  const messageDelivery = useStore(
    handle.store,
    (state) => state.messageDelivery,
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
        messageDelivery,
        queue,
        events,
        setupCardWindows: setupCardWindows ?? EMPTY_SETUP_CARD_WINDOWS,
      })
    ) {
      return;
    }
    releaseEpicCreateSeed(epicId, chatId);
  }, [
    epicId,
    chatId,
    snapshotLoaded,
    messageDelivery,
    queue,
    events,
    setupCardWindows,
  ]);
}

interface StillProvisioningInput {
  readonly seededMessageId: string | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly messageDelivery: ChatMessageDelivery | null;
  readonly queue: OpenChatQueueState;
  readonly events: ReadonlyArray<OpenChatEvent>;
  readonly setupCardWindows: ReadonlyArray<SetupCardWindowIdentity>;
}

/**
 * The hold condition: the seeded message is STILL WAITING TO RUN and its setup
 * card has not reached an outcome.
 *
 * Both conjuncts are needed and neither is redundant:
 *
 *  - {@link seededOpeningStillWaiting}, the host's own answer for whether the
 *    opening has run.
 *  - the card row is `creating` or does not exist yet. `setting-up` and `ready`
 *    both mean the add is done, even while the delivery is still `preparing`;
 *    `failed` means the rows stay the source folders - which is what the seed
 *    already showed - and the card offers Retry; `cancelled` is terminal too.
 *    "Does not exist yet" is the window between the response and the drain's
 *    `setup.creating`.
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
  if (
    !seededOpeningStillWaiting(
      input.messageDelivery,
      input.queue,
      seededMessageId,
    )
  ) {
    return false;
  }
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

/**
 * A deferred create seeds its opening as a transcript row plus a host-private
 * delivery record, never as a queue item, so while `state.messageDelivery` names
 * the seeded message its phase is the whole answer: `pending` and `preparing`
 * wait (the add runs inside `preparing`), `started` means the binding was
 * committed, and `withdrawn` means the opening left the transcript and the
 * listing can read host truth.
 *
 * A delivery that is null or names another message says nothing about this one,
 * which is the synchronous fallback, where the opening really is a queue item.
 * There it counts as waiting while it is in the queue in ANY status, because a
 * user pause flips it to `paused` mid-add and a status-narrowed read would
 * release there.
 */
function seededOpeningStillWaiting(
  delivery: ChatMessageDelivery | null,
  queue: OpenChatQueueState,
  seededMessageId: string,
): boolean {
  if (delivery !== null && delivery.messageId === seededMessageId) {
    const { phase } = delivery.state;
    return phase === "pending" || phase === "preparing";
  }
  return queue.items.some(
    (item) => item.kind === "prompt" && item.messageId === seededMessageId,
  );
}
