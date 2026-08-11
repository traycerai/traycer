import type { AssembledChat } from "@traycer/protocol/persistence/chat-sync/assembly";
import type { CapturedResidualLevelId } from "@traycer/protocol/persistence/chat-sync/captured-levels";
import type { ChatHeadCore } from "@traycer/protocol/persistence/chat-sync/core";
import type {
  PreservedChatEvent,
  PreservedChatMessage,
} from "@traycer/protocol/persistence/chat-sync/entries";
import type { JsonObject } from "@traycer/protocol/persistence/chat-sync/json";

/**
 * Clone-not-migrate: an assembled cloud chat becomes the seed for a NEW chat
 * owned by the reader's own host.
 *
 * A chat never moves between hosts. The source keeps its identity, its history
 * and its publication lineage; the reader gets a new chat, with a new id, whose
 * transcript is a byte-faithful copy of what it read. Two hosts publishing one
 * chat id is the duplicate-writer condition the whole CAS mechanism exists to
 * refuse, so migration is not a feature that was skipped - it is the thing this
 * shape prevents.
 *
 * ## Losslessness is structural
 *
 * Messages and events are carried as the PRESERVED pairs assembly produced, not
 * rebuilt from their interpreted view. A preserved entry encodes back to its own
 * `raw`, so a content-block type, message role or event type this build has
 * never heard of crosses into the clone byte for byte - and so does an unmodeled
 * FIELD a newer minor added to a modeled object, which rides the residual bags
 * below. Walking the parsed view and rebuilding each body would work perfectly
 * today and start dropping data the first time a writer ships a variant this
 * build predates, which is precisely what the passthrough exists to stop.
 *
 * ## What this module is, and what it is not
 *
 * It derives a SEED - the payload a clone import writes - and nothing else. The
 * writing is the host's: a clone lands as one atomic append into the target's
 * chat store, because a clone that failed halfway would leave a chat that looks
 * complete and is not. Keeping the derivation here means the rule for what a
 * clone carries is stated once, in the client that read the chat, rather than
 * re-derived by whichever surface happens to initiate one.
 */

// ---- Residual lifting ---------------------------------------------------- //

/**
 * Every residual bag a clone carries, keyed by the protocol's captured-level id.
 *
 * ## The completeness guard, finally consumed
 *
 * `CAPTURED_RESIDUAL_LEVELS` exists so a capture site added by a minor cannot be
 * a site no consumer knows about - and until now it had no consumer, so the
 * guard proved only that the protocol's own list was internally consistent. The
 * exhaustive `Record<CapturedResidualLevelId, ...>` below is what makes it bite
 * across the boundary: a new level id breaks THIS build, at compile time, and
 * the person adding it has to say whether a clone carries it.
 *
 * That is the fix for the v1 defect this replaces, where the list of levels was
 * hand-kept in the importer and falling behind was silent data loss.
 */
export type ChatCloneResidualDisposition =
  /** Lifted into the clone. */
  | { readonly kind: "carried"; readonly bag: JsonObject }
  /** Deliberately not carried, with the reason a human needs. */
  | {
      readonly kind: "dropped";
      readonly reason: string;
      readonly bag: JsonObject;
    }
  /** Never reached this client - see the `shard` entry. */
  | { readonly kind: "unavailable"; readonly reason: string };

export type ChatCloneResiduals = Readonly<
  Record<CapturedResidualLevelId, ChatCloneResidualDisposition>
>;

export function chatCloneResidualsOf(chat: AssembledChat): ChatCloneResiduals {
  return {
    head: { kind: "carried", bag: chat.residual },
    core: { kind: "carried", bag: chat.core.residual },
    "core.lifecycle": { kind: "carried", bag: chat.core.lifecycle.residual },
    "core.settings": {
      kind: "carried",
      bag: chat.core.settings === null ? {} : chat.core.settings.residual,
    },
    // The one deliberate drop, and the reason the level id is a CONTRACT rather
    // than a label: `hostPrivate` is the ORIGIN host's session-chain and wake
    // state. Carrying it would point a brand-new chat at provider sessions on a
    // machine this host does not own and cannot resume. A clone starts with no
    // session chain - that is what "new chat" means.
    hostPrivate: {
      kind: "dropped",
      reason:
        "hostPrivate is the origin host's session state and does not follow a chat onto another machine",
      bag: chat.hostPrivate.residual,
    },
    // Not a decision this module gets to make: `assembleChat` folds the shards
    // into one chat and keeps only the HEAD's residual, so a shard-level bag
    // never reaches a caller. That is defensible - a clone re-shards from its
    // own projection, so source cohort boundaries do not survive anyway and
    // there is nothing coherent to attach a per-shard bag to - but it means an
    // unmodeled top-level key a newer minor adds to the SHARD record is lost on
    // re-publication. Recorded here rather than left implicit, because the
    // difference between "we chose not to" and "we could not" is the whole
    // content of this table.
    shard: {
      kind: "unavailable",
      reason:
        "assembly folds shards into one chat and retains only the head's residual",
    },
  };
}

/**
 * The bags a clone import writes, flattened for a caller that just needs the
 * data. Empty bags are omitted so an ordinary clone writes no residual op at
 * all rather than a no-op one.
 */
export function carriedCloneResiduals(
  residuals: ChatCloneResiduals,
): Readonly<Partial<Record<CapturedResidualLevelId, JsonObject>>> {
  const carried: Partial<Record<CapturedResidualLevelId, JsonObject>> = {};
  for (const [id, disposition] of entriesOf(residuals)) {
    if (disposition.kind !== "carried") continue;
    if (Object.keys(disposition.bag).length === 0) continue;
    carried[id] = disposition.bag;
  }
  return carried;
}

/**
 * What the clone will NOT carry, as something a surface can show.
 *
 * Reported rather than dropped silently: a user cloning a chat published by a
 * newer build deserves to know a field went missing, and a support report needs
 * the key name. Never the value - an unmodeled bag can hold anything.
 */
export function unpreservedCloneKeys(
  residuals: ChatCloneResiduals,
): readonly string[] {
  const keys: string[] = [];
  for (const [id, disposition] of entriesOf(residuals)) {
    if (disposition.kind !== "dropped") continue;
    for (const key of Object.keys(disposition.bag)) keys.push(`${id}.${key}`);
  }
  return keys.sort();
}

function entriesOf(
  residuals: ChatCloneResiduals,
): readonly (readonly [
  CapturedResidualLevelId,
  ChatCloneResidualDisposition,
])[] {
  return Object.entries(residuals) as (readonly [
    CapturedResidualLevelId,
    ChatCloneResidualDisposition,
  ])[];
}

// ---- The seed ------------------------------------------------------------ //

/** Where the clone comes from, kept so a surface can say so. */
export type ChatCloneProvenance = {
  readonly sourceChatId: string;
  readonly sourceOwnerUserId: string;
  /** Host that owned the chat at capture. Provenance, never a routing target. */
  readonly sourceOriginHostId: string;
  /** The head this copy was assembled from, as an identity for the copy. */
  readonly sourceHeadSha256: string;
  readonly sourceThroughRecordSeq: number;
};

export type ChatCloneSeed = {
  /**
   * The core the clone publishes with. Identity fields are the TARGET's - see
   * the field notes on {@link buildChatCloneSeed}.
   */
  readonly core: ChatHeadCore;
  readonly messages: readonly PreservedChatMessage[];
  readonly events: readonly PreservedChatEvent[];
  readonly residuals: ChatCloneResiduals;
  /** Convenience view of `residuals`; see {@link unpreservedCloneKeys}. */
  readonly unpreservedKeys: readonly string[];
  readonly provenance: ChatCloneProvenance;
};

export type ChatCloneResult =
  | { readonly status: "ok"; readonly seed: ChatCloneSeed }
  /**
   * A deleted chat has no clone. The head exists so a deletion is publishable
   * as STATE rather than as a vanished row, which is exactly what makes this
   * refusable instead of silently producing a live copy of something its owner
   * deleted.
   */
  | { readonly status: "refused"; readonly reason: "source-deleted" };

export type BuildChatCloneSeedRequest = {
  readonly chat: AssembledChat;
  /** The head digest this copy was assembled from. */
  readonly sourceHeadSha256: string;
  /** Minted by the target. Clone-not-migrate: never the source's chat id. */
  readonly newChatId: string;
  /** The cloning user. */
  readonly ownerUserId: string;
  /** The target host. The clone's origin is HERE, not where it was read from. */
  readonly originHostId: string;
  /**
   * The clone's place in the TARGET's chat tree, decided by the caller.
   *
   * Never inherited: the source's `parentChatId` names a chat in the source
   * host's registry and generally does not exist here, so inheriting it would
   * either dangle or - worse - collide with an unrelated local chat.
   */
  readonly parentChatId: string | null;
  /** Wall-clock ms. A clone is new local work, so it is created now. */
  readonly createdAt: number;
};

export function buildChatCloneSeed(
  request: BuildChatCloneSeedRequest,
): ChatCloneResult {
  const { chat } = request;
  if (chat.core.lifecycle.state === "deleted") {
    return { status: "refused", reason: "source-deleted" };
  }

  const residuals = chatCloneResidualsOf(chat);

  return {
    status: "ok",
    seed: {
      core: {
        chatId: request.newChatId,
        parentChatId: request.parentChatId,
        ownerUserId: request.ownerUserId,
        originHostId: request.originHostId,
        // Carried: the title is the user's own words about the conversation,
        // and a clone that renamed itself would be a worse copy.
        title: chat.core.title,
        isTitleEditedByUser: chat.core.isTitleEditedByUser,
        createdAt: request.createdAt,
        updatedAt: request.createdAt,
        // Carried VERBATIM rather than reset, including its residual bag.
        // Resetting to `active` while lifting the source's unmodeled lifecycle
        // fields would attach state describing an archived chat to one declared
        // live - two halves of the same level disagreeing. Deletion is the one
        // case that cannot be carried, and it is refused above rather than
        // normalized, so what remains is coherent.
        lifecycle: chat.core.lifecycle,
        settings: chat.core.settings,
        residual: chat.core.residual,
      },
      messages: chat.messages,
      events: chat.events,
      residuals,
      unpreservedKeys: unpreservedCloneKeys(residuals),
      provenance: {
        sourceChatId: chat.core.chatId,
        sourceOwnerUserId: chat.core.ownerUserId,
        sourceOriginHostId: chat.core.originHostId,
        sourceHeadSha256: request.sourceHeadSha256,
        sourceThroughRecordSeq: chat.throughRecordSeq,
      },
    },
  };
}
