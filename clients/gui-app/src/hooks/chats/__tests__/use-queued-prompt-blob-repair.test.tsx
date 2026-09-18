import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";

import type { HostRpcRegistry } from "@/lib/host";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { putImage } from "@/lib/composer/landing-image-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  type DraftBlobClient,
  isDraftBlobConfirmed,
  putDraftBlobs,
  resetDraftBlobTransportForTests,
} from "@/lib/drafts/draft-blob-transport";
import {
  resetQueuedPromptBlobRepairForTests,
  useQueuedPromptBlobRepair,
  type QueueRepairView,
} from "@/hooks/chats/use-queued-prompt-blob-repair";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

/**
 * Item B: THE QUEUED-DRAIN MISSING-HASH ARM.
 *
 * A live send that loses its attachment bytes is refused at the host's
 * dangling-hash chokepoint, the frame is rejected, the prompt goes back to the
 * composer and the renderer retracts its upload-confirmation memo there. The
 * QUEUED drain has no such door: `failQueuedPromptPreparation` writes a durable
 * `send.failed` row and pauses the queue with the item retained, so nothing
 * reaches the composer and a Retry re-drains host-side against the same missing
 * bytes. These cases pin the arm that closes it.
 *
 * The carrier is a DURABLE event, replayed inside every subscribe snapshot, so
 * two of these cases are about re-delivery rather than about repair: the same
 * event arriving twice must produce one upload pass, and an arm mounted onto a
 * snapshot that ALREADY contains the event must still fire. Those are the two
 * properties the withdrawn one-shot stream frame would have given for free and
 * this carriage does not.
 */

const OWNER_ID = "owner-queued-repair";
const HOST_ID = "host-queued-repair";
const QUEUE_ITEM_ID = "queue-item-1";

const blobMocks = vi.hoisted(() => ({
  putBlobCalls: [] as string[],
  ackedHashes: new Set<string>(),
  // When `defer` is set, a put records its call and PARKS, so a test can move
  // the queue underneath an upload that is still in flight - which is the only
  // way to reach the fulfilment-time race at all.
  defer: false,
  pending: [] as Array<() => void>,
}));

/** The `drafts.putBlob` response, named once so the mock cannot drift from it. */
type PutBlobResponse = ResponseOfMethod<HostRpcRegistry, "drafts.putBlob">;

function draftBlobClient(): DraftBlobClient {
  return {
    request: () => Promise.reject(new Error("unexpected request call")),
    requestWithOptions: ((method: string, params: unknown) => {
      if (method !== "drafts.putBlob") {
        return Promise.reject(new Error(`unexpected method ${method}`));
      }
      const sha256 = (params as { readonly sha256: string }).sha256;
      blobMocks.putBlobCalls.push(sha256);
      // Typed as the METHOD's response rather than left to infer from the
      // branches: the inferred union widens the `resolve` below to the union
      // and stops matching `ResponseOfMethod<…, "drafts.putBlob">`.
      const answer: PutBlobResponse = blobMocks.ackedHashes.has(sha256)
        ? { ok: true }
        : { ok: false, reason: "digest-mismatch" };
      if (!blobMocks.defer) return Promise.resolve(answer);
      return new Promise<PutBlobResponse>((resolve) => {
        blobMocks.pending.push(() => {
          resolve(answer);
        });
      });
    }) as HostRequester<HostRpcRegistry>["requestWithOptions"],
  };
}

const CLIENT = draftBlobClient();

function pngBytes(marker: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, marker]);
}

/**
 * A `send.failed` event carrying a queued preparation failure.
 *
 * The bag's `queueItemId`/`messageId` are the QUEUED ITEM's, and are what the
 * arm acts on; the event's own top-level `messageId` is deliberately `null`
 * here, because that is what the host writes for a preparation that fails
 * before the queued message row is persisted. An arm that reached for the
 * event's id instead of the bag's would be reading `null` on this row.
 */
function preparationFailedEvent(input: {
  readonly eventId: string;
  readonly code: string;
  readonly missingHashes: ReadonlyArray<string>;
}): ChatEvent {
  return {
    eventId: input.eventId,
    type: "send.failed",
    timestamp: 1,
    clientActionId: null,
    actor: null,
    message: "Couldn't attach an image.",
    turnId: null,
    messageId: null,
    queueItemId: QUEUE_ITEM_ID,
    approvalId: null,
    blockId: null,
    severity: "error",
    metadata: {
      code: input.code,
      queueItemId: QUEUE_ITEM_ID,
      messageId: "queued-message-1",
      missingHashes: [...input.missingHashes],
    },
  };
}

function pausedQueue(): QueueRepairView {
  return { status: "paused", items: [{ queueItemId: QUEUE_ITEM_ID }] };
}

const resumeQueue = vi.fn<() => string | null>(() => "action-1");

/**
 * Let any in-flight repair pass run to completion.
 *
 * Used where the two outcomes being distinguished settle differently - the
 * capped path answers synchronously inside the effect, the uncapped one goes
 * through an IndexedDB read and an upload - so there is no single condition
 * `waitFor` could wait on that does not already assume the answer.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Release every parked `drafts.putBlob`. */
function releasePendingPuts(): void {
  const parked = [...blobMocks.pending];
  blobMocks.pending.length = 0;
  for (const resolve of parked) resolve();
}

interface ArmProps {
  readonly events: ReadonlyArray<ChatEvent>;
  readonly queue: QueueRepairView;
  readonly canAct: boolean;
}

/**
 * The QUEUE is a prop, not a closure capture, because the fulfilment-time race
 * is precisely about the queue changing under a pass that is still running. A
 * harness that froze it at mount could not express any of those cases.
 */
function mountArm(initial: ArmProps): {
  readonly rerender: (next: ArmProps) => void;
  readonly unmount: () => void;
} {
  const view = renderHook(
    (props: ArmProps) =>
      useQueuedPromptBlobRepair({
        hostId: HOST_ID,
        client: CLIENT,
        events: props.events,
        queue: props.queue,
        canAct: props.canAct,
        resumeQueue,
      }),
    { initialProps: initial },
  );
  return {
    rerender: (next) => {
      view.rerender(next);
    },
    unmount: () => {
      view.unmount();
    },
  };
}

beforeEach(() => {
  installFreshIndexedDb();
  // Confirmations are recorded and read PER ACCOUNT, and a null owner confirms
  // nothing - so without an identity every `isDraftBlobConfirmed(...)` below
  // answers false. The `toBe(true)` cases would red loudly; the `toBe(false)`
  // ones would pass for the wrong reason, which is the failure this seeding
  // exists to prevent.
  useAuthStore.setState({
    contextMetadata: { userId: OWNER_ID, username: OWNER_ID },
  });
  blobMocks.putBlobCalls.length = 0;
  blobMocks.ackedHashes.clear();
  blobMocks.pending.length = 0;
  blobMocks.defer = false;
  resumeQueue.mockClear();
  vi.mocked(toast.error).mockClear();
  resetQueuedPromptBlobRepairForTests();
  resetDraftBlobTransportForTests();
});

afterEach(() => {
  resetQueuedPromptBlobRepairForTests();
  resetDraftBlobTransportForTests();
});

describe("useQueuedPromptBlobRepair", () => {
  it("forgets the stale ack, re-uploads every named hash, and resumes the queue", async () => {
    const hash = await putImage(pngBytes(1));
    blobMocks.ackedHashes.add(hash);
    // This window already uploaded these bytes once and holds the host's ack -
    // the state the queued failure actually happens in.
    //
    // NOT a test of the retraction, despite the ack being here: `putDraftBlobs`
    // does not consult `confirmedBlobsByHost` at all (the confirmed-filter
    // lives a layer up, in `confirmAttachmentsByHash`), so the put below
    // happens with or without the forget. What this case pins is the ordinary
    // path end to end - upload, then resume. The retraction is pinned by the
    // failure-memo case further down, which is the only one that can see it,
    // because the forget only shows up in the memo state left behind when the
    // re-upload FAILS.
    await putDraftBlobs(HOST_ID, CLIENT, [hash], OWNER_ID);
    expect(isDraftBlobConfirmed(HOST_ID, hash, OWNER_ID)).toBe(true);
    blobMocks.putBlobCalls.length = 0;

    mountArm({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
      ],
      queue: pausedQueue(),
      canAct: true,
    });

    await waitFor(() => {
      expect(resumeQueue).toHaveBeenCalledTimes(1);
    });
    // The upload really happened again rather than being skipped as confirmed.
    expect(blobMocks.putBlobCalls).toEqual([hash]);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("a hash with no local bytes leaves the queue paused and says so", async () => {
    // Never written to the image store, so there are no bytes to put back.
    const lostHash = "ab".repeat(32);

    mountArm({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [lostHash],
        }),
      ],
      queue: pausedQueue(),
      canAct: true,
    });

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    });
    expect(resumeQueue).not.toHaveBeenCalled();
    // The toast names neither the hash nor the item.
    const message = vi.mocked(toast.error).mock.calls[0]?.[0];
    expect(message).toBe("Couldn't attach an image");
  });

  /**
   * THE PIN ON THE MEMO RETRACTION ITSELF, and it has to be this one.
   *
   * The obvious pin - "the re-upload happened even though the hash was already
   * confirmed" - proves nothing here, because `putDraftBlobs` does not consult
   * `confirmedBlobsByHost` at all: the confirmed-filter lives one layer up, in
   * `confirmAttachmentsByHash`. So the re-upload runs whether or not the arm
   * forgets, and a case asserting only `putBlobCalls` stays green with the
   * forget deleted. (Verified by ablation, not assumed.)
   *
   * What the forget actually buys is the state the memo is left in when the
   * re-upload FAILS. Without it the renderer still believes this host holds
   * these bytes, so the NEXT send skips the upload at
   * `confirmAttachmentsByHash` and ships a hash the host has already said it
   * does not have - the exact loop this arm exists to break.
   */
  it("retracts the stale ack even when the re-upload fails, so the next send cannot skip it", async () => {
    const hash = await putImage(pngBytes(6));
    // Confirmed on this host first...
    blobMocks.ackedHashes.add(hash);
    await putDraftBlobs(HOST_ID, CLIENT, [hash], OWNER_ID);
    expect(isDraftBlobConfirmed(HOST_ID, hash, OWNER_ID)).toBe(true);
    // ...and now the host refuses it, so the repair's own put cannot restore
    // the confirmation.
    blobMocks.ackedHashes.clear();

    mountArm({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
      ],
      queue: pausedQueue(),
      canAct: true,
    });

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    });
    expect(resumeQueue).not.toHaveBeenCalled();
    // The claim: the renderer no longer believes this host holds these bytes.
    expect(isDraftBlobConfirmed(HOST_ID, hash, OWNER_ID)).toBe(false);
  });

  it("an empty missingHashes set is paused-with-nothing-to-do, not a vacuous success", async () => {
    // The host filters the hash set to well-formed sha256 before writing, so a
    // wholly malformed set reaches the renderer as the code plus `[]`. There is
    // nothing to re-upload, so resuming would re-run the drain into the same
    // refusal - and on a durable event that is a loop.
    const arm = mountArm({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [],
        }),
      ],
      queue: pausedQueue(),
      canAct: true,
    });

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    });
    expect(blobMocks.putBlobCalls).toEqual([]);
    expect(resumeQueue).not.toHaveBeenCalled();

    // And the attempt is NOT spent: nothing resumed, so nothing can loop, and a
    // later row for this item that does name hashes must still repair.
    const hash = await putImage(pngBytes(17));
    blobMocks.ackedHashes.add(hash);
    arm.rerender({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [],
        }),
        preparationFailedEvent({
          eventId: "event-2",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
      ],
      queue: pausedQueue(),
      canAct: true,
    });
    await settle();
    expect(blobMocks.putBlobCalls).toEqual([hash]);
    expect(resumeQueue).toHaveBeenCalledTimes(1);
  });

  it("the same event delivered twice runs one upload pass and resumes once", async () => {
    const hash = await putImage(pngBytes(2));
    blobMocks.ackedHashes.add(hash);
    const event = preparationFailedEvent({
      eventId: "event-1",
      code: "MISSING_ATTACHMENT_BYTES",
      missingHashes: [hash],
    });

    const arm = mountArm({
      events: [event],
      queue: pausedQueue(),
      canAct: true,
    });
    await waitFor(() => {
      expect(resumeQueue).toHaveBeenCalledTimes(1);
    });

    // The snapshot lands again with the same durable row - a new array
    // identity, so the effect re-runs - and the arm must recognise it.
    arm.rerender({
      events: [{ ...event }],
      queue: pausedQueue(),
      canAct: true,
    });
    await waitFor(() => {
      expect(blobMocks.putBlobCalls).toEqual([hash]);
    });
    expect(resumeQueue).toHaveBeenCalledTimes(1);
  });

  /**
   * THE DRAIN LOOP, and why a per-EVENT ledger is not a bound.
   *
   * Each queued drain appends its own `send.failed` row with a fresh
   * `eventId`. So repair → resume → drain → NEW event → repair is unbounded,
   * and every iteration passes an `eventId`-keyed guard honestly. The cap has
   * to be per ITEM.
   */
  it("a second failure for the same item under a new event id does not repair again", async () => {
    const hash = await putImage(pngBytes(7));
    blobMocks.ackedHashes.add(hash);

    const arm = mountArm({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
      ],
      queue: pausedQueue(),
      canAct: true,
    });
    await waitFor(() => {
      expect(resumeQueue).toHaveBeenCalledTimes(1);
    });

    // The drain ran, failed again, and wrote a SECOND durable row.
    arm.rerender({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
        preparationFailedEvent({
          eventId: "event-2",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
      ],
      queue: pausedQueue(),
      canAct: true,
    });

    await settle();
    // One upload pass and one resume across BOTH events - the loop is bounded -
    // and the queue is left paused with the row editable. The upload assertion
    // is first deliberately: it is the one that names the loop, so an uncapped
    // arm reddens on the second `drafts.putBlob` rather than on a toast that
    // never arrives.
    expect(blobMocks.putBlobCalls).toEqual([hash]);
    expect(resumeQueue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
  });

  /**
   * THE CAP SPENDS A RESUME, NOT AN ATTEMPT.
   *
   * Only a resume hands the drain another turn, so only a resume can produce
   * the next `send.failed`. A pass that ended "no local bytes" ends the chain
   * by itself - so spending the item's one attempt on it would cost the user
   * the repair they are owed once the bytes ARE local (a re-paste into the
   * edited row), which is the case this pins.
   */
  it("a no-bytes outcome does not spend the item's attempt: a later event with bytes still repairs", async () => {
    // Never written to the image store, so the first pass can find nothing.
    const lostHash = "cd".repeat(32);

    const arm = mountArm({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [lostHash],
        }),
      ],
      queue: pausedQueue(),
      canAct: true,
    });
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    });
    expect(resumeQueue).not.toHaveBeenCalled();
    // Nothing was even attempted on the wire - no local bytes means no put.
    expect(blobMocks.putBlobCalls).toEqual([]);

    // The user makes the bytes local again and the item fails once more.
    const hash = await putImage(pngBytes(9));
    blobMocks.ackedHashes.add(hash);
    arm.rerender({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [lostHash],
        }),
        preparationFailedEvent({
          eventId: "event-2",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
      ],
      queue: pausedQueue(),
      canAct: true,
    });

    await settle();
    // Upload first, as in the loop case above: it is the assertion that names
    // the defect. An arm that spent the attempt on the no-bytes pass never
    // reaches the wire for the second event, so it reddens here rather than on
    // a `waitFor` that simply runs out.
    expect(blobMocks.putBlobCalls).toEqual([hash]);
    expect(resumeQueue).toHaveBeenCalledTimes(1);
    // Still just the one toast, from the first pass.
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
  });

  it("the per-item cap is per item: a different queueItemId still repairs", async () => {
    const hash = await putImage(pngBytes(8));
    blobMocks.ackedHashes.add(hash);
    const otherItemId = "queue-item-2";

    const arm = mountArm({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
      ],
      queue: {
        status: "paused",
        items: [{ queueItemId: QUEUE_ITEM_ID }, { queueItemId: otherItemId }],
      },
      canAct: true,
    });
    await waitFor(() => {
      expect(resumeQueue).toHaveBeenCalledTimes(1);
    });

    // A DIFFERENT queued item fails. The first item's spent attempt says
    // nothing about this one.
    arm.rerender({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
        {
          ...preparationFailedEvent({
            eventId: "event-2",
            code: "MISSING_ATTACHMENT_BYTES",
            missingHashes: [hash],
          }),
          queueItemId: otherItemId,
          metadata: {
            code: "MISSING_ATTACHMENT_BYTES",
            queueItemId: otherItemId,
            messageId: "queued-message-2",
            missingHashes: [hash],
          },
        },
      ],
      queue: {
        status: "paused",
        items: [{ queueItemId: QUEUE_ITEM_ID }, { queueItemId: otherItemId }],
      },
      canAct: true,
    });

    await waitFor(() => {
      expect(resumeQueue).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  /**
   * THE FULFILMENT-TIME RACE.
   *
   * `resumeQueue` is QUEUE-WIDE (`handleResumeQueue` moves the whole queue off
   * `"paused"`), and an upload takes real time. The pre-flight `stillQueued` and
   * `status === "paused"` checks are facts about the moment the pass STARTED,
   * so on their own they let a continuation resume a queue that is no longer
   * the one they checked. Each case below moves the world under an in-flight
   * put and asserts nothing is resumed on its behalf.
   *
   * The per-item ledger does not touch this: it bounds how many passes an item
   * gets, not what a pass does when it lands.
   */
  async function startDeferredRepair(hash: string): Promise<{
    readonly rerender: (next: ArmProps) => void;
    readonly unmount: () => void;
  }> {
    blobMocks.defer = true;
    const arm = mountArm({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
      ],
      queue: pausedQueue(),
      canAct: true,
    });
    await waitFor(() => {
      expect(blobMocks.putBlobCalls).toEqual([hash]);
    });
    return arm;
  }

  it("does not resume when the failed item was cancelled while its upload was in flight", async () => {
    const hash = await putImage(pngBytes(10));
    blobMocks.ackedHashes.add(hash);
    const arm = await startDeferredRepair(hash);

    // The user cancels the failed row. Another item is still queued behind it
    // and the queue is still paused - which is exactly what makes a queue-wide
    // resume here wrong rather than merely redundant: it would start a turn for
    // a prompt the user never asked to run now.
    arm.rerender({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
      ],
      queue: { status: "paused", items: [{ queueItemId: "queue-item-2" }] },
      canAct: true,
    });
    releasePendingPuts();
    await settle();

    expect(resumeQueue).not.toHaveBeenCalled();
  });

  it("does not resume when the queue was resumed by hand while the upload was in flight", async () => {
    const hash = await putImage(pngBytes(11));
    blobMocks.ackedHashes.add(hash);
    const arm = await startDeferredRepair(hash);

    // The user hit Resume themselves. The queue is running; a second resume is
    // not a no-op on a live queue.
    arm.rerender({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
      ],
      queue: { status: "running", items: [{ queueItemId: QUEUE_ITEM_ID }] },
      canAct: true,
    });
    releasePendingPuts();
    await settle();

    expect(resumeQueue).not.toHaveBeenCalled();
  });

  it("does not resume after the tile unmounts mid-upload", async () => {
    const hash = await putImage(pngBytes(12));
    blobMocks.ackedHashes.add(hash);
    const arm = await startDeferredRepair(hash);

    // The queue state this continuation captured is STILL valid - paused, item
    // present - so only the disposal flag can stop it. That is what makes this
    // case a test of the flag and not of the queue re-read.
    arm.unmount();
    releasePendingPuts();
    await settle();

    expect(resumeQueue).not.toHaveBeenCalled();
  });

  it("does not resume when the queue was resumed and re-paused during the upload", async () => {
    const hash = await putImage(pngBytes(13));
    blobMocks.ackedHashes.add(hash);
    const arm = await startDeferredRepair(hash);
    const events = [
      preparationFailedEvent({
        eventId: "event-1",
        code: "MISSING_ATTACHMENT_BYTES",
        missingHashes: [hash],
      }),
    ];

    // Resume by hand, then pause again. The queue ends back on `"paused"` with
    // the SAME item - byte-identical to the state the pass started in - so
    // status and presence cannot see that anything happened. Resuming now would
    // override a pause the user made AFTER this repair began.
    arm.rerender({
      events,
      queue: { status: "running", items: [{ queueItemId: QUEUE_ITEM_ID }] },
      canAct: true,
    });
    arm.rerender({ events, queue: pausedQueue(), canAct: true });
    releasePendingPuts();
    await settle();

    expect(resumeQueue).not.toHaveBeenCalled();
  });

  it("a resume that did not dispatch does not spend the item's attempt", async () => {
    const hash = await putImage(pngBytes(14));
    blobMocks.ackedHashes.add(hash);
    // `resumeQueue` answers `null` when it could not send - disconnected, or no
    // session. Nothing resumed, so nothing can loop.
    resumeQueue.mockReturnValueOnce(null);

    const arm = mountArm({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
      ],
      queue: pausedQueue(),
      canAct: true,
    });
    await waitFor(() => {
      expect(resumeQueue).toHaveBeenCalledTimes(1);
    });

    // A later failure for the same item must still be repairable.
    arm.rerender({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
        preparationFailedEvent({
          eventId: "event-2",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
      ],
      queue: pausedQueue(),
      canAct: true,
    });
    await settle();

    expect(blobMocks.putBlobCalls).toEqual([hash, hash]);
    expect(resumeQueue).toHaveBeenCalledTimes(2);
  });

  it("a read-only viewer neither repairs nor consumes the event, so the owner still can", async () => {
    const hash = await putImage(pngBytes(15));
    blobMocks.ackedHashes.add(hash);
    const events = [
      preparationFailedEvent({
        eventId: "event-1",
        code: "MISSING_ATTACHMENT_BYTES",
        missingHashes: [hash],
      }),
    ];

    // A read-only collaborator opens the owner's paused chat.
    const readOnly = mountArm({
      events,
      queue: pausedQueue(),
      canAct: false,
    });
    await settle();
    expect(blobMocks.putBlobCalls).toEqual([]);
    expect(resumeQueue).not.toHaveBeenCalled();
    // And no toast: this is not their prompt and not their failure.
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    readOnly.unmount();

    // THE LEDGER MUST BE UNTOUCHED. If the read-only mount had claimed this
    // event, the owner's later snapshot would find it already answered and
    // never repair - the failure mode that makes "just skip the work" the
    // wrong shape of gate.
    mountArm({ events, queue: pausedQueue(), canAct: true });
    await waitFor(() => {
      expect(resumeQueue).toHaveBeenCalledTimes(1);
    });
    expect(blobMocks.putBlobCalls).toEqual([hash]);
  });

  /**
   * W-9 residual: ELIGIBILITY ARRIVING LATE ON THE SAME MOUNT.
   *
   * The ordinary case is not a read-only viewer at all - it is the owner's own
   * tile, where profile, access role and connection settle a beat after the
   * first paint while the failure is already sitting in the snapshot. In the
   * real tile `resumeQueue` is memoized over the store handle and a reconnect
   * can hand back a byte-identical `events` and `queue`, so if `canAct` is not
   * in the effect's dependency list nothing re-runs the scan and the repair
   * never starts.
   *
   * EVERY OTHER INPUT IS HELD BY REFERENCE here - the same `events` array, the
   * same `queue` object - so `canAct` is the only thing that changed. The
   * read-only case above unmounts and remounts, which re-runs the effect for a
   * reason that has nothing to do with the deps and would pass either way.
   */
  it("starts the repair when eligibility arrives on the SAME mount, inputs unchanged", async () => {
    const hash = await putImage(pngBytes(18));
    blobMocks.ackedHashes.add(hash);
    // Built once and reused by reference on the rerender.
    const events: ReadonlyArray<ChatEvent> = [
      preparationFailedEvent({
        eventId: "event-1",
        code: "MISSING_ATTACHMENT_BYTES",
        missingHashes: [hash],
      }),
    ];
    const queue = pausedQueue();

    const arm = mountArm({ events, queue, canAct: false });
    await settle();
    expect(blobMocks.putBlobCalls).toEqual([]);

    // The tile becomes actionable. Nothing else about the snapshot moved.
    arm.rerender({ events, queue, canAct: true });

    await settle();
    // Upload first: an effect that never re-ran reaches no wire call at all, so
    // this is the assertion that names the defect. Waiting on the resume would
    // redden as a timeout instead, which says only "nothing arrived".
    expect(blobMocks.putBlobCalls).toEqual([hash]);
    expect(resumeQueue).toHaveBeenCalledTimes(1);
  });

  it("does not resume when the viewer stops being able to act mid-upload", async () => {
    const hash = await putImage(pngBytes(16));
    blobMocks.ackedHashes.add(hash);
    const arm = await startDeferredRepair(hash);

    // Permission or connection lost while the bytes were going up. The queue is
    // otherwise unchanged, so only the eligibility re-check can stop this.
    arm.rerender({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "MISSING_ATTACHMENT_BYTES",
          missingHashes: [hash],
        }),
      ],
      queue: pausedQueue(),
      canAct: false,
    });
    releasePendingPuts();
    await settle();

    expect(resumeQueue).not.toHaveBeenCalled();
  });

  it("fires from a snapshot that already contains the event at mount", async () => {
    const hash = await putImage(pngBytes(3));
    blobMocks.ackedHashes.add(hash);

    // No live delivery at all: the arm mounts onto a transcript that already
    // holds the failure, which is what every reconnect looks like.
    mountArm({
      events: [
        {
          ...preparationFailedEvent({
            eventId: "event-replayed",
            code: "MISSING_ATTACHMENT_BYTES",
            missingHashes: [hash],
          }),
          timestamp: 0,
        },
      ],
      queue: pausedQueue(),
      canAct: true,
    });

    await waitFor(() => {
      expect(resumeQueue).toHaveBeenCalledTimes(1);
    });
    expect(blobMocks.putBlobCalls).toEqual([hash]);
  });

  it("ignores a preparation failure whose item has left the queue, and a running queue", async () => {
    const hash = await putImage(pngBytes(4));
    blobMocks.ackedHashes.add(hash);
    const event = preparationFailedEvent({
      eventId: "event-1",
      code: "MISSING_ATTACHMENT_BYTES",
      missingHashes: [hash],
    });

    // Cancelled: the row the failure names is gone, so there is nothing to
    // resume into.
    mountArm({
      events: [event],
      queue: { status: "paused", items: [] },
      canAct: true,
    });
    // Already running: resuming is not a no-op on a live queue.
    mountArm({
      events: [event],
      queue: { status: "running", items: [{ queueItemId: QUEUE_ITEM_ID }] },
      canAct: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(blobMocks.putBlobCalls).toEqual([]);
    expect(resumeQueue).not.toHaveBeenCalled();
  });

  it("ignores a send.failed carrying another preparation code", async () => {
    const hash = await putImage(pngBytes(5));
    blobMocks.ackedHashes.add(hash);

    mountArm({
      events: [
        preparationFailedEvent({
          eventId: "event-1",
          code: "UNSUPPORTED_IMAGES",
          missingHashes: [],
        }),
      ],
      queue: pausedQueue(),
      canAct: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(blobMocks.putBlobCalls).toEqual([]);
    expect(resumeQueue).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });
});
