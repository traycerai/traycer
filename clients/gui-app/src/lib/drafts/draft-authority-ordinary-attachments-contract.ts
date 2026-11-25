import type { JsonContent } from "@traycer/protocol/common/registry";
import type { DraftDocument } from "@traycer/protocol/host";
import type {
  ChatSubscribeClientFrame,
  ChatSubscribeServerFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { CreateChatResponseV12 } from "@traycer/protocol/host/epic/unary-schemas";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import type {
  DraftAuthorityEffectIntent,
  DraftAuthorityIssueReceipt,
  DraftAuthorityOutbox,
  DraftAuthorityRetiredOutbox,
  DraftAuthorityReturnDisposition,
  DraftAuthorityReturnReceipt,
  PublishDraftAuthorityOutboxInput,
  SettleDraftAuthorityEffectInput,
  TransferDraftAuthorityOutboxInput,
} from "./draft-authority-pending";
import type { PendingSandboxSend } from "@/stores/sandboxes/pending-sandbox-send-store";
import type { WriteDraftAuthorityInput } from "./draft-authority";
import type {
  DraftAuthorityActor,
  DraftAuthorityEditReceipt,
  DraftAuthorityExpectation,
  DraftAuthorityLandingFlush,
  DraftAuthorityManifest,
  DraftAuthorityMutationResult,
  DraftAuthorityReadResult,
  DraftAuthorityRecord,
  DraftAuthorityVerifiedBlob,
  DraftAuthorityVersion,
} from "./draft-authority-types";

export type DraftAuthorityOrdinaryLiveRecord = Extract<
  DraftAuthorityRecord,
  { kind: "live" }
> & {
  readonly ordinaryAttachmentCustody: true;
};

export interface DraftAuthorityOrdinaryAttachmentProof {
  readonly ordinaryVerified?: readonly DraftAuthorityVerifiedBlob[];
}

export type WriteDraftAuthorityWithOrdinaryAssetsInput =
  WriteDraftAuthorityInput & DraftAuthorityOrdinaryAttachmentProof;

export type PublishDraftAuthorityOutboxWithOrdinaryAssetsInput =
  PublishDraftAuthorityOutboxInput & DraftAuthorityOrdinaryAttachmentProof;

export interface ReadDraftAuthorityOrdinaryAssetsInput {
  readonly actor: DraftAuthorityActor | null;
  readonly draft: DraftAuthorityVersion;
}

export type DraftAuthorityOrdinaryAssetsRead =
  | {
      readonly kind: "current";
      readonly manifest: DraftAuthorityManifest;
      readonly blobs: ReadonlyMap<string, Blob>;
    }
  | {
      /**
       * Only not-owned authorizes a legacy read. It positively identifies an
       * exact live version with no isolated root, rather than a failed read.
       */
      readonly kind: "not-owned" | "stale" | "denied" | "unavailable";
    };

export interface DraftAuthorityOrdinaryWirePlan {
  /** Ordered disjoint subsets whose union is the immutable submission manifest. */
  readonly inlineDigests: readonly string[];
  readonly byHashDigests: readonly string[];
}

export type DraftAuthorityOrdinaryAwareDispatch =
  TransferDraftAuthorityOutboxInput["dispatch"] & {
    readonly ordinaryWirePlan?: DraftAuthorityOrdinaryWirePlan;
  };

export type TransferDraftAuthorityOutboxWithOrdinaryAssetsInput = Omit<
  TransferDraftAuthorityOutboxInput,
  "dispatch"
> & {
  readonly dispatch: DraftAuthorityOrdinaryAwareDispatch;
};

export type DraftAuthorityLegacyOutboxState =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "uncertain" | "accepted";
      readonly effect: DraftAuthorityEffectIntent;
    }
  | {
      readonly kind: "returning";
      readonly disposition: DraftAuthorityReturnDisposition;
    }
  | { readonly kind: "held"; readonly reason: "stop" | "return" | "uncertain" };

export interface AdmitLegacyDraftAuthorityOrdinaryOutboxInput
  extends DraftAuthorityOrdinaryAttachmentProof {
  readonly actor: DraftAuthorityActor;
  readonly actionId: string;
  readonly send: PendingSandboxSend;
  readonly manifest: DraftAuthorityManifest;
  readonly legacyState: DraftAuthorityLegacyOutboxState;
}

export interface DraftAuthorityOrdinaryDeliveryIdentity {
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly actionId: string;
  readonly messageId: string;
}

export interface DraftAuthorityPendingCreateSeedReference {
  readonly sendId: string;
  readonly createIssueGeneration: number;
  readonly createExecutorId: string;
}

export interface DraftAuthorityOrdinaryFirstTurnClaim {
  readonly accountId: string;
  readonly sessionGeneration: string;
  readonly reference: DraftAuthorityPendingCreateSeedReference;
  readonly identity: DraftAuthorityOrdinaryDeliveryIdentity;
  readonly outboxGeneration: number;
  readonly executorId: string;
}

export type DraftAuthorityOrdinaryFirstTurnState =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "issuing" | "uncertain" | "refused" | "delivered";
      readonly claim: DraftAuthorityOrdinaryFirstTurnClaim;
    };

export interface DraftAuthorityOrdinaryDeferredDelivery {
  readonly reference: DraftAuthorityPendingCreateSeedReference;
  readonly identity: DraftAuthorityOrdinaryDeliveryIdentity;
  readonly state: DraftAuthorityOrdinaryFirstTurnState;
}

export type DraftAuthorityOrdinaryOutboxView = Omit<DraftAuthorityOutbox, "dispatch"> & {
  readonly dispatch: DraftAuthorityOrdinaryAwareDispatch | null;
  readonly ordinaryAttachmentCustody?: true;
  readonly ordinaryDeferredDelivery?: DraftAuthorityOrdinaryDeferredDelivery;
};

export interface ReadDraftAuthorityOrdinaryAwareOutboxInput {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
}

export type DraftAuthorityOrdinaryAwareOutboxRead =
  | { readonly kind: "current"; readonly outbox: DraftAuthorityOrdinaryOutboxView }
  | { readonly kind: "retired"; readonly marker: DraftAuthorityRetiredOutbox }
  | { readonly kind: "missing" | "denied" | "unavailable" };

export type DraftAuthorityOrdinaryAwareOutboxList =
  | {
      readonly kind: "current";
      readonly outboxes: readonly DraftAuthorityOrdinaryOutboxView[];
    }
  | { readonly kind: "denied" | "unavailable" };

export interface DraftAuthorityOrdinaryDispatchSettlement {
  readonly kind: "create-deferred";
  readonly identity: DraftAuthorityOrdinaryDeliveryIdentity;
}

export type SettleDraftAuthorityEffectWithOrdinaryAssetsInput =
  SettleDraftAuthorityEffectInput & {
    readonly ordinaryDelivery?: DraftAuthorityOrdinaryDispatchSettlement;
  };

interface OrdinaryOutboxVersionInput {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly expectedGeneration: number;
}

export type ReadDraftAuthorityOrdinaryOutboxAssetsInput =
  OrdinaryOutboxVersionInput & (
    | { readonly phase: "setup" }
    | { readonly phase: "dispatch"; readonly claim: DraftAuthorityIssueReceipt }
    | {
        readonly phase: "accepted-continuation";
        readonly claim: DraftAuthorityOrdinaryFirstTurnClaim;
      }
  );

export interface ReadDraftAuthorityOrdinaryReturnPlanInput
  extends OrdinaryOutboxVersionInput {
  readonly returnId: string;
}

export type DraftAuthorityOrdinaryReturnPlan =
  | {
      /** Reuse this exact pending owner's blobs in the destination write. */
      readonly kind: "isolated-owned";
      readonly manifest: DraftAuthorityManifest;
      readonly receipt: DraftAuthorityReturnReceipt | null;
    }
  | {
      /** Only this branch can prepare missing bytes from the original host. */
      readonly kind: "needs-verified";
      readonly originalHostId: string | null;
      readonly manifest: DraftAuthorityManifest;
      readonly receipt: DraftAuthorityReturnReceipt | null;
    }
  | { readonly kind: "not-required" | "stale" | "denied" | "unavailable" };

export interface ClaimDraftAuthorityOrdinaryFirstTurnInput
  extends OrdinaryOutboxVersionInput {
  readonly reference: DraftAuthorityPendingCreateSeedReference;
  readonly identity: DraftAuthorityOrdinaryDeliveryIdentity;
}

export type DraftAuthorityOrdinaryFirstTurnClaimResult =
  | {
      /** This invocation alone may ask for an actual verb grant. */
      readonly kind: "committed";
      readonly receipt: DraftAuthorityOrdinaryFirstTurnClaim;
    }
  | {
      /** Observation only, including an exact same-account restart. */
      readonly kind: "replayed";
      readonly state: DraftAuthorityOrdinaryFirstTurnState;
    }
  | { readonly kind: "conflict" | "denied" | "unavailable" | "unverified" };

export interface ReadDraftAuthorityOrdinaryFirstTurnGrantInput {
  readonly actor: DraftAuthorityActor;
  readonly claim: DraftAuthorityOrdinaryFirstTurnClaim;
}

export type DraftAuthorityOrdinaryFirstTurnOutcome = {
  readonly kind: "refused" | "uncertain";
  readonly identity: DraftAuthorityOrdinaryDeliveryIdentity;
};

export interface SettleDraftAuthorityOrdinaryFirstTurnInput {
  readonly actor: DraftAuthorityActor;
  readonly claim: DraftAuthorityOrdinaryFirstTurnClaim;
  readonly outcome: DraftAuthorityOrdinaryFirstTurnOutcome;
}

export interface RecordDraftAuthorityOrdinaryReturnInput
  extends OrdinaryOutboxVersionInput {
  readonly disposition: DraftAuthorityReturnDisposition;
  readonly isAdmissionCurrent?: () => boolean;
  /** Required to give back an accepted Create's definitively refused first turn. */
  readonly ordinaryFirstTurnRefusal?: DraftAuthorityOrdinaryFirstTurnClaim;
}

export interface PublishDraftAuthorityOrdinaryReturnInput
  extends ReadDraftAuthorityOrdinaryReturnPlanInput,
    DraftAuthorityOrdinaryAttachmentProof {}

export type PublishDraftAuthorityOrdinaryReturnResult =
  | DraftAuthorityMutationResult<DraftAuthorityReturnReceipt, DraftAuthorityOutbox>
  | { readonly kind: "held" | "missing-bytes" | "budget" };

export interface DraftAuthorityOrdinaryDraftOwner {
  readonly kind: "draft";
  readonly draft: DraftAuthorityVersion;
  readonly manifest: DraftAuthorityManifest;
}

export interface DraftAuthorityOrdinaryOutboxOwner {
  readonly kind: "outbox";
  readonly sendId: string;
  readonly actionId: string;
  readonly generation: number;
  readonly manifest: DraftAuthorityManifest;
}

type DraftAuthorityOrdinaryActionPurpose =
  | "direct-seed"
  | "live-chat-send"
  | "parked-send"
  | "queue-edit-snapshot"
  | "queue-edit"
  | "undo";

export interface DraftAuthorityOrdinaryActionOwner<
  Purpose extends DraftAuthorityOrdinaryActionPurpose = DraftAuthorityOrdinaryActionPurpose,
> {
  readonly kind: "action";
  readonly purpose: Purpose;
  readonly operationId: string;
  readonly revision: string;
  readonly manifest: DraftAuthorityManifest;
}

export type DraftAuthorityOrdinaryOwner =
  | DraftAuthorityOrdinaryDraftOwner
  | DraftAuthorityOrdinaryOutboxOwner
  | DraftAuthorityOrdinaryActionOwner;

/** The receipt must prove this source's transfer to the named owning revision. */
export interface DraftAuthorityCommittedOrdinarySuccessor {
  readonly owner: DraftAuthorityOrdinaryOwner;
  readonly receiptId: string;
}

export interface DraftAuthorityOrdinaryHostCustodyReceipt {
  readonly receiptId: string;
  readonly identity: DraftAuthorityOrdinaryDeliveryIdentity;
  readonly manifest: DraftAuthorityManifest;
  readonly evidence:
    | { readonly kind: "host-transcript" | "host-initial-turn" }
    | {
        /** A newly allocated message, never an existing item's edit. */
        readonly kind: "host-fresh-queued-message";
        readonly queueItemId: string;
      };
}

type DraftAuthorityOrdinarySuccessorWitness = {
  readonly kind: "committed-successor";
  readonly successor: DraftAuthorityCommittedOrdinarySuccessor;
};

type DraftAuthorityOrdinaryHostWitness = {
  readonly kind: "qualified-host-custody";
  readonly host: DraftAuthorityOrdinaryHostCustodyReceipt;
};

type DraftAuthorityOrdinaryDiscardWitness = {
  readonly kind: "discard-or-no-effect";
  readonly disposition: {
    readonly kind: "intentional-discard";
    readonly intentOperationId: string;
    /** Exactly the digests the admitted operation deliberately removes. */
    readonly digests: readonly string[];
  };
};

type DraftAuthorityOrdinaryNoEffectWitness = {
  readonly kind: "discard-or-no-effect";
  readonly disposition: {
    readonly kind: "proved-no-effect";
    readonly proofReceiptId: string;
    /** This distinct original owner must still own the complete manifest. */
    readonly preservedOriginal: DraftAuthorityCommittedOrdinarySuccessor;
  };
};

export type DraftAuthorityOrdinaryReleaseWitness =
  | DraftAuthorityOrdinarySuccessorWitness
  | DraftAuthorityOrdinaryHostWitness
  | DraftAuthorityOrdinaryDiscardWitness
  | DraftAuthorityOrdinaryNoEffectWitness;

export type DraftAuthorityOrdinaryReleaseWitnessCases<Result> = {
  readonly [Kind in DraftAuthorityOrdinaryReleaseWitness["kind"]]: (
    witness: Extract<DraftAuthorityOrdinaryReleaseWitness, { readonly kind: Kind }>,
  ) => Result;
};

export type ReleaseDraftAuthorityOrdinaryRefsInput =
  | {
      readonly kind: "draft-mutation";
      readonly source: DraftAuthorityOrdinaryDraftOwner;
      /** This operation is the only source of actor and operation ID for this arm. */
      readonly write: Omit<WriteDraftAuthorityWithOrdinaryAssetsInput, "expected"> & {
        readonly expected: Extract<DraftAuthorityExpectation, { readonly kind: "current" }>;
      };
      readonly witness:
        | DraftAuthorityOrdinarySuccessorWitness
        | DraftAuthorityOrdinaryHostWitness
        | DraftAuthorityOrdinaryDiscardWitness;
    }
  | {
      readonly kind: "outbox-return";
      readonly operationId: string;
      readonly actor: DraftAuthorityActor;
      readonly source: DraftAuthorityOrdinaryOutboxOwner;
      readonly returnReceipt: DraftAuthorityReturnReceipt;
      readonly witness: DraftAuthorityOrdinarySuccessorWitness;
    }
  | {
      readonly kind: "outbox-delivery";
      readonly operationId: string;
      readonly actor: DraftAuthorityActor;
      readonly source: DraftAuthorityOrdinaryOutboxOwner;
      readonly execution:
        | { readonly kind: "dispatch"; readonly claim: DraftAuthorityIssueReceipt }
        | {
            readonly kind: "accepted-continuation";
            readonly claim: DraftAuthorityOrdinaryFirstTurnClaim;
          };
      readonly witness: DraftAuthorityOrdinaryHostWitness;
    }
  | {
      readonly kind: "action-retirement";
      readonly operationId: string;
      readonly actor: DraftAuthorityActor;
      readonly source: DraftAuthorityOrdinaryActionOwner;
      readonly witness:
        | DraftAuthorityOrdinarySuccessorWitness
        | DraftAuthorityOrdinaryHostWitness
        | DraftAuthorityOrdinaryNoEffectWitness;
    }
  | {
      readonly kind: "local-action-retirement";
      readonly operationId: string;
      readonly actor: DraftAuthorityActor | null;
      readonly source: DraftAuthorityOrdinaryActionOwner<"undo" | "queue-edit-snapshot">;
      readonly witness: DraftAuthorityOrdinarySuccessorWitness | DraftAuthorityOrdinaryDiscardWitness;
    };

type DraftAuthorityOrdinaryReleaseTransition =
  | { readonly kind: "draft-mutation"; readonly receipt: DraftAuthorityEditReceipt }
  | { readonly kind: "outbox-return"; readonly marker: DraftAuthorityRetiredOutbox }
  | {
      readonly kind: "outbox-delivery";
      readonly outbox: DraftAuthorityOrdinaryOutboxView;
    }
  | {
      readonly kind: "action-retirement";
      readonly owner: DraftAuthorityOrdinaryActionOwner;
    };

export interface DraftAuthorityOrdinaryReleaseReceipt {
  readonly operationId: string;
  readonly accountId: string | null;
  readonly source: DraftAuthorityOrdinaryOwner;
  readonly witness: DraftAuthorityOrdinaryReleaseWitness;
  readonly releasedDigests: readonly string[];
  readonly transition: DraftAuthorityOrdinaryReleaseTransition;
}

export type ReleaseDraftAuthorityOrdinaryRefsResult = DraftAuthorityMutationResult<
  DraftAuthorityOrdinaryReleaseReceipt
>;

export interface ImportDraftAuthorityOrdinarySlotInput
  extends DraftAuthorityOrdinaryAttachmentProof {
  readonly source: DraftAuthorityRecord;
  readonly isSourceCurrent: () => boolean;
}

export interface ImportDraftAuthorityRetainedLandingInput
  extends DraftAuthorityOrdinaryAttachmentProof {
  readonly record: DraftAuthorityRecord;
  readonly isCurrent: () => boolean;
}

export interface ReadLegacyNativeLandingVerifiedBlobsInput {
  readonly digests: readonly string[];
  readonly isCurrent: () => boolean;
}

export type ReadLegacyNativeLandingVerifiedBlobsResult =
  | {
      readonly kind: "verified";
      readonly verified: readonly DraftAuthorityVerifiedBlob[];
    }
  | { readonly kind: "conflict" | "unavailable" };

export interface RetainDraftAuthorityLandingHistoryInput {
  readonly draft: DraftAuthorityVersion;
  readonly isCurrent: () => boolean;
}

export type DraftAuthorityOrdinaryAwareLandingRetain =
  | {
      readonly kind: "retained";
      readonly manifest: DraftAuthorityManifest;
      readonly assetCustody: "cache" | "ordinary-isolated";
    }
  | { readonly kind: "conflict" | "unavailable" };

export interface AdmitDraftAuthorityLandingHistoryInput
  extends DraftAuthorityOrdinaryAttachmentProof {
  readonly actor: DraftAuthorityActor | null;
  readonly draftId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly manifest: DraftAuthorityManifest;
  readonly isCurrent: () => boolean;
}

export interface AdmitCanonicalLandingHistoryDraftInput
  extends DraftAuthorityOrdinaryAttachmentProof {
  readonly actor: DraftAuthorityActor | null;
  readonly hostId: string;
  readonly draftId: string;
  readonly document: Extract<DraftDocument, { kind: "landing" }>;
  readonly content: JsonContent;
  readonly verifiedHashes: readonly string[];
  readonly isCurrent: () => boolean;
}

type RetainedLandingRecord = Extract<DraftAuthorityRecord, { kind: "live" }>;

export type DraftAuthorityOrdinaryAwareLandingRetentionRow =
  | {
      readonly assetCustody: "cache";
      readonly record: RetainedLandingRecord;
      readonly rootedDigests: readonly string[];
    }
  | {
      readonly assetCustody: "ordinary-isolated";
      readonly record: DraftAuthorityOrdinaryLiveRecord;
      /** Isolated bytes are outside the legacy cache and its budget/GC roots. */
      readonly rootedDigests: readonly [];
    };

export type DraftAuthorityOrdinaryAwareLandingRetentions =
  | {
      readonly kind: "current";
      readonly rows: readonly DraftAuthorityOrdinaryAwareLandingRetentionRow[];
    }
  | { readonly kind: "unavailable" };

interface DraftAuthorityBoundChat {
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
}

interface DraftAuthorityOrdinaryQueueTarget extends DraftAuthorityBoundChat {
  readonly queueItemId: string;
  readonly messageId: string;
}

type DraftAuthorityOrdinaryQueueFrame = Extract<
  ChatSubscribeClientFrame,
  { readonly kind: "queueEdit" | "queueSettingsUpdate" | "queueSteerNow" }
>;
type DraftAuthorityOrdinarySendFrame = Extract<
  ChatSubscribeClientFrame,
  { readonly kind: "send" }
>;

interface CaptureDraftAuthorityOrdinaryActionBase {
  readonly operationId: string;
  readonly isCurrent: () => boolean;
}

export type CaptureDraftAuthorityOrdinaryActionInput = CaptureDraftAuthorityOrdinaryActionBase & (
  | {
      readonly purpose: "undo";
      readonly actor: DraftAuthorityActor | null;
      readonly source: DraftAuthorityOrdinaryDraftOwner;
    }
  | {
      readonly purpose: "queue-edit-snapshot";
      readonly actor: DraftAuthorityActor;
      readonly source: DraftAuthorityOrdinaryDraftOwner;
      readonly target: DraftAuthorityOrdinaryQueueTarget;
    }
  | {
      readonly purpose: "queue-edit";
      readonly actor: DraftAuthorityActor;
      readonly source: DraftAuthorityOrdinaryDraftOwner;
      readonly target: DraftAuthorityOrdinaryQueueTarget;
      readonly edit: Extract<DraftAuthorityOrdinaryQueueFrame, { readonly kind: "queueEdit" }>;
      readonly followUp: Extract<
        DraftAuthorityOrdinaryQueueFrame,
        { readonly kind: "queueSettingsUpdate" | "queueSteerNow" }
      >;
      readonly submissionManifest: DraftAuthorityManifest;
    }
  | {
      readonly purpose: "parked-send";
      readonly actor: DraftAuthorityActor;
      readonly source: DraftAuthorityOrdinaryDraftOwner;
      readonly target: DraftAuthorityBoundChat;
      readonly content: JsonContent;
      readonly submissionManifest: DraftAuthorityManifest;
    }
  | {
      readonly purpose: "live-chat-send";
      readonly actor: DraftAuthorityActor;
      readonly source:
        | DraftAuthorityOrdinaryDraftOwner
        | DraftAuthorityOrdinaryActionOwner<"parked-send">;
      readonly target: DraftAuthorityBoundChat;
      readonly frame: DraftAuthorityOrdinarySendFrame;
      readonly submissionManifest: DraftAuthorityManifest;
      readonly wirePlan: DraftAuthorityOrdinaryWirePlan;
    }
);

interface DraftAuthorityOrdinaryActionSnapshot<
  Purpose extends DraftAuthorityOrdinaryActionPurpose,
> {
  readonly owner: DraftAuthorityOrdinaryActionOwner<Purpose>;
  readonly original: DraftAuthorityOrdinaryDraftOwner;
  readonly record: DraftAuthorityOrdinaryLiveRecord;
}

export type ReadDraftAuthorityOrdinaryActionInput =
  | {
      readonly actor: DraftAuthorityActor | null;
      readonly owner: DraftAuthorityOrdinaryActionOwner<"undo">;
    }
  | {
      readonly actor: DraftAuthorityActor;
      readonly owner: DraftAuthorityOrdinaryActionOwner<
        "queue-edit-snapshot" | "queue-edit" | "parked-send" | "live-chat-send"
      >;
    };

export type ReadDraftAuthorityOrdinaryActionResult = {
  readonly kind: "current";
  readonly record: DraftAuthorityOrdinaryLiveRecord;
  readonly manifest: DraftAuthorityManifest;
  readonly blobs: ReadonlyMap<string, Blob>;
} | { readonly kind: "missing" | "stale" | "denied" | "unavailable" };

type DraftAuthorityOrdinaryActionEffect =
  | {
      readonly kind: "send";
      readonly owner: DraftAuthorityOrdinaryActionOwner<"live-chat-send">;
      readonly frame: DraftAuthorityOrdinarySendFrame;
    }
  | {
      readonly kind: "queue-edit";
      readonly owner: DraftAuthorityOrdinaryActionOwner<"queue-edit">;
      readonly frame: Extract<DraftAuthorityOrdinaryQueueFrame, { readonly kind: "queueEdit" }>;
    }
  | {
      readonly kind: "queue-follow-up";
      readonly owner: DraftAuthorityOrdinaryActionOwner<"queue-edit">;
      readonly frame: Extract<
        DraftAuthorityOrdinaryQueueFrame,
        { readonly kind: "queueSettingsUpdate" | "queueSteerNow" }
      >;
    };

export interface ClaimDraftAuthorityOrdinaryActionEffectInput {
  readonly actor: DraftAuthorityActor;
  readonly effect: DraftAuthorityOrdinaryActionEffect;
  readonly isCurrent: () => boolean;
}

export interface DraftAuthorityOrdinaryActionEffectClaim {
  readonly executorId: string;
  readonly actor: DraftAuthorityActor;
  readonly effect: DraftAuthorityOrdinaryActionEffect;
}

/**
 * Fresh in-memory permit. The runtime validates object identity at the actuator
 * and consumes it once. A serialized claim or a reconstructed object is invalid.
 */
export interface DraftAuthorityOrdinaryActionIssuePermit {
  readonly executorId: string;
}

export type ClaimDraftAuthorityOrdinaryActionEffectResult =
  | {
      readonly kind: "committed";
      readonly claim: DraftAuthorityOrdinaryActionEffectClaim;
      readonly permit: DraftAuthorityOrdinaryActionIssuePermit;
    }
  | { readonly kind: "replayed"; readonly claim: DraftAuthorityOrdinaryActionEffectClaim }
  | { readonly kind: "conflict" | "denied" | "unavailable" | "unverified" };

export interface ConsumeDraftAuthorityOrdinaryActionEffectGrantInput {
  readonly actor: DraftAuthorityActor;
  readonly claim: DraftAuthorityOrdinaryActionEffectClaim;
  readonly permit: DraftAuthorityOrdinaryActionIssuePermit;
  readonly isCurrent: () => boolean;
}

type DraftAuthorityOrdinaryHostObservation =
  | {
      readonly kind: "host-message";
      readonly frame: Extract<ChatSubscribeServerFrame, { readonly kind: "messageAccepted" }>;
    }
  | {
      readonly kind: "host-transcript";
      readonly messageId: string;
      readonly content: JsonContent;
    }
  | {
      readonly kind: "host-fresh-queued-message";
      readonly frame: Extract<ChatSubscribeServerFrame, { readonly kind: "queueChanged" }>;
      readonly queueItemId: string;
    }
  | { readonly kind: "host-initial-turn"; readonly response: CreateChatResponseV12 };

export type RecordDraftAuthorityOrdinaryHostCustodyInput = {
  readonly actor: DraftAuthorityActor;
  readonly identity: DraftAuthorityOrdinaryDeliveryIdentity;
  readonly manifest: DraftAuthorityManifest;
  readonly isObservationCurrent: () => boolean;
} & (
  | {
      readonly kind: "chat-action";
      readonly source: DraftAuthorityOrdinaryActionOwner<"live-chat-send">;
      readonly claim: DraftAuthorityOrdinaryActionEffectClaim;
      readonly observation: DraftAuthorityOrdinaryHostObservation;
    }
  | {
      readonly kind: "queue-edit";
      readonly source: DraftAuthorityOrdinaryActionOwner<"queue-edit">;
      readonly claim: DraftAuthorityOrdinaryActionEffectClaim;
      readonly observation: Extract<
        DraftAuthorityOrdinaryHostObservation,
        { readonly kind: "host-message" | "host-transcript" }
      >;
    }
  | {
      readonly kind: "outbox-dispatch";
      readonly source: DraftAuthorityOrdinaryOutboxOwner;
      readonly claim: DraftAuthorityIssueReceipt;
      readonly observation: DraftAuthorityOrdinaryHostObservation;
    }
  | {
      readonly kind: "outbox-first-turn";
      readonly source: DraftAuthorityOrdinaryOutboxOwner;
      readonly claim: DraftAuthorityOrdinaryFirstTurnClaim;
      readonly observation: DraftAuthorityOrdinaryHostObservation;
    }
);

type DraftAuthorityOrdinaryActionReconciliation =
  | {
      readonly kind: "definite-no-frame";
      /** Only the closed original local transport may report this outcome. */
      readonly permit: DraftAuthorityOrdinaryActionIssuePermit;
    }
  | {
      readonly kind: "definitive-refusal";
      readonly frame: Extract<ChatSubscribeServerFrame, { readonly kind: "actionAck" }>;
    }
  | {
      readonly kind: "host-accounted";
      readonly custody: DraftAuthorityOrdinaryHostCustodyReceipt;
    };

type DraftAuthorityOrdinaryNeverClaimedFollowUp = Extract<
  DraftAuthorityOrdinaryActionEffect,
  { readonly kind: "queue-follow-up" }
>;

export type RecordDraftAuthorityOrdinaryActionOutcomeInput = {
  readonly actor: DraftAuthorityActor;
  readonly isObservationCurrent: () => boolean;
} & (
  | {
      readonly kind: "claimed";
      readonly claim: DraftAuthorityOrdinaryActionEffectClaim;
      readonly outcome: DraftAuthorityOrdinaryActionReconciliation;
    }
  | {
      readonly kind: "close-unclaimed-follow-up";
      readonly edit: DraftAuthorityOrdinaryActionEffectClaim;
      readonly effect: DraftAuthorityOrdinaryNeverClaimedFollowUp;
    }
);

export type DraftAuthorityOrdinaryActionOutcomeReceipt = {
  readonly receiptId: string;
} & (
  | {
      readonly kind: DraftAuthorityOrdinaryActionReconciliation["kind"];
      readonly claim: DraftAuthorityOrdinaryActionEffectClaim;
    }
  | {
      readonly kind: "never-claimed";
      readonly edit: DraftAuthorityOrdinaryActionEffectClaim;
      readonly effect: DraftAuthorityOrdinaryNeverClaimedFollowUp;
    }
);

type DraftAuthorityOrdinaryReturnAction = "live-chat-send" | "queue-edit";

export interface DraftAuthorityOrdinaryAuthorizedActionReturn {
  readonly receiptId: string;
  readonly owner: DraftAuthorityOrdinaryActionOwner<DraftAuthorityOrdinaryReturnAction>;
  readonly expected: DraftAuthorityExpectation;
}

export type AuthorizeDraftAuthorityOrdinaryActionReturnInput = {
  readonly actor: DraftAuthorityActor;
  readonly operationId: string;
  readonly expected: DraftAuthorityExpectation;
  readonly isCurrent: () => boolean;
} & (
  | {
      readonly kind: "send";
      readonly owner: DraftAuthorityOrdinaryActionOwner<"live-chat-send">;
      readonly sendOutcome: DraftAuthorityOrdinaryActionOutcomeReceipt;
    }
  | {
      readonly kind: "queue-edit";
      readonly owner: DraftAuthorityOrdinaryActionOwner<"queue-edit">;
      readonly editOutcome: DraftAuthorityOrdinaryActionOutcomeReceipt;
      readonly followUpOutcome: DraftAuthorityOrdinaryActionOutcomeReceipt;
    }
);

export type PublishDraftAuthorityOrdinaryActionRestoreInput = {
  readonly operationId: string;
  readonly expected: DraftAuthorityExpectation;
  readonly isCurrent: () => boolean;
} & (
  | {
      readonly kind: "undo";
      readonly actor: DraftAuthorityActor | null;
      readonly owner: DraftAuthorityOrdinaryActionOwner<"undo">;
    }
  | {
      readonly kind: "queue-edit-snapshot";
      readonly actor: DraftAuthorityActor;
      readonly owner: DraftAuthorityOrdinaryActionOwner<"queue-edit-snapshot">;
    }
  | {
      readonly kind: "park-before-drain";
      readonly actor: DraftAuthorityActor;
      readonly owner: DraftAuthorityOrdinaryActionOwner<"parked-send">;
    }
  | {
      readonly kind: "authorized-issued-return";
      readonly actor: DraftAuthorityActor;
      readonly authorization: DraftAuthorityOrdinaryAuthorizedActionReturn;
    }
);

export interface RecordDraftAuthorityAcceptedOrdinaryForkInput {
  readonly actor: DraftAuthorityActor;
  readonly operationId: string;
  readonly source: DraftAuthorityOrdinaryDraftOwner;
  readonly sourceChat: DraftAuthorityBoundChat;
  readonly createdChat: DraftAuthorityBoundChat;
  /** The actual original Create result, never a cached DTO or row ID. */
  readonly response: CreateChatResponseV12;
  readonly isCurrent: () => boolean;
}

export interface DraftAuthorityAcceptedOrdinaryForkReceipt {
  readonly receiptId: string;
  readonly operationId: string;
  readonly source: DraftAuthorityOrdinaryDraftOwner;
  readonly sourceChat: DraftAuthorityBoundChat;
  readonly createdChat: DraftAuthorityBoundChat;
}

export interface PublishDraftAuthorityOrdinaryForkInput {
  readonly source: DraftAuthorityOrdinaryDraftOwner;
  readonly write: WriteDraftAuthorityWithOrdinaryAssetsInput;
  readonly scope:
    | {
        readonly kind: "chat-fork";
        readonly admission: DraftAuthorityAcceptedOrdinaryForkReceipt;
      }
    | {
        readonly kind: "landing-clone";
        readonly sourceHostId: string;
        readonly destinationHostId: string;
      };
  readonly isCurrent: () => boolean;
}

export interface DraftAuthorityOrdinaryDestinationReceipt {
  readonly receiptId: string;
  readonly draft: DraftAuthorityVersion;
  readonly manifest: DraftAuthorityManifest;
}

export interface DraftAuthorityOrdinaryLeafApi {
  readonly captureDraftAuthorityOrdinaryAction: <
    Purpose extends CaptureDraftAuthorityOrdinaryActionInput["purpose"],
  >(
    input: CaptureDraftAuthorityOrdinaryActionInput & { readonly purpose: Purpose },
  ) => Promise<
    | DraftAuthorityMutationResult<DraftAuthorityOrdinaryActionSnapshot<Purpose>>
    | { readonly kind: "not-owned" }
  >;
  readonly readDraftAuthorityOrdinaryAction: (
    input: ReadDraftAuthorityOrdinaryActionInput,
  ) => Promise<ReadDraftAuthorityOrdinaryActionResult>;
  readonly claimDraftAuthorityOrdinaryActionEffect: (
    input: ClaimDraftAuthorityOrdinaryActionEffectInput,
  ) => Promise<ClaimDraftAuthorityOrdinaryActionEffectResult>;
  readonly consumeDraftAuthorityOrdinaryActionEffectGrant: (
    input: ConsumeDraftAuthorityOrdinaryActionEffectGrantInput,
  ) => Promise<boolean>;
  readonly recordDraftAuthorityOrdinaryHostCustody: (
    input: RecordDraftAuthorityOrdinaryHostCustodyInput,
  ) => Promise<DraftAuthorityMutationResult<DraftAuthorityOrdinaryHostCustodyReceipt>>;
  readonly recordDraftAuthorityOrdinaryActionOutcome: (
    input: RecordDraftAuthorityOrdinaryActionOutcomeInput,
  ) => Promise<DraftAuthorityMutationResult<DraftAuthorityOrdinaryActionOutcomeReceipt>>;
  readonly authorizeDraftAuthorityOrdinaryActionReturn: (
    input: AuthorizeDraftAuthorityOrdinaryActionReturnInput,
  ) => Promise<DraftAuthorityMutationResult<DraftAuthorityOrdinaryAuthorizedActionReturn>>;
  readonly publishDraftAuthorityOrdinaryActionRestore: (
    input: PublishDraftAuthorityOrdinaryActionRestoreInput,
  ) => Promise<DraftAuthorityMutationResult<DraftAuthorityOrdinaryDestinationReceipt>>;
  readonly recordDraftAuthorityAcceptedOrdinaryFork: (
    input: RecordDraftAuthorityAcceptedOrdinaryForkInput,
  ) => Promise<DraftAuthorityMutationResult<DraftAuthorityAcceptedOrdinaryForkReceipt>>;
  readonly publishDraftAuthorityOrdinaryFork: (
    input: PublishDraftAuthorityOrdinaryForkInput,
  ) => Promise<DraftAuthorityMutationResult<DraftAuthorityOrdinaryDestinationReceipt>>;
}

export interface ReadDraftAuthorityProtectedBrowserChatReferenceInput
  extends DraftAuthorityBoundChat {
  readonly actor: DraftAuthorityActor;
}

interface DraftAuthorityBrowserCancelIdentity
  extends ReadDraftAuthorityProtectedBrowserChatReferenceInput {
  readonly sendId: string;
  readonly returnId: string;
}

export interface ReadDraftAuthorityBrowserCancelInput extends DraftAuthorityBrowserCancelIdentity {
  readonly expectedGeneration: number;
}

export interface AcknowledgeDraftAuthorityProtectedBrowserCancelInput
  extends ReadDraftAuthorityBrowserCancelInput {
  readonly expectedChat: DraftAuthorityExpectation;
  readonly isInstallationCurrent: () => boolean;
}

export interface DraftAuthorityProtectedBrowserChatContents {
  readonly content: JsonContent;
  readonly browserAnnotations: readonly BrowserAnnotationRecord[];
  readonly manifest: DraftAuthorityManifest;
  readonly bytes: ReadonlyMap<string, Blob>;
}

export interface DraftAuthorityProtectedBrowserCancelReceipt {
  readonly marker: DraftAuthorityRetiredOutbox;
  readonly draft: DraftAuthorityVersion;
  readonly manifest: DraftAuthorityManifest;
}

export type ReadDraftAuthorityBrowserCancelOutcome =
  | { readonly kind: "browser-chat"; readonly receipt: DraftAuthorityProtectedBrowserCancelReceipt }
  | { readonly kind: "whole-drafts"; readonly receipt: DraftAuthorityReturnReceipt }
  | { readonly kind: "returning"; readonly generation: number }
  | { readonly kind: "missing" | "stale" | "denied" | "unavailable" };

export type ReadDraftAuthorityProtectedBrowserChatReferenceResult =
  | { readonly kind: "current"; readonly draft: DraftAuthorityVersion }
  | { readonly kind: "missing" | "denied" | "unavailable" };

export interface ReadDraftAuthorityProtectedBrowserChatInput
  extends ReadDraftAuthorityProtectedBrowserChatReferenceInput {
  readonly draft: DraftAuthorityVersion;
}

type DraftAuthorityProtectedBrowserContentsRead =
  | ({ readonly kind: "current" } & DraftAuthorityProtectedBrowserChatContents)
  | { readonly kind: "missing" | "stale" | "denied" | "missing-bytes" | "unavailable" };

export interface DraftAuthorityProtectedBrowserCancelApi {
  readonly readDraftAuthorityBrowserReturn: (
    input: ReadDraftAuthorityBrowserCancelInput,
  ) => Promise<DraftAuthorityProtectedBrowserContentsRead>;
  readonly acknowledgeDraftAuthorityBrowserReturn: (
    input: AcknowledgeDraftAuthorityProtectedBrowserCancelInput,
  ) => Promise<DraftAuthorityMutationResult<DraftAuthorityProtectedBrowserCancelReceipt>>;
  readonly readDraftAuthorityBrowserCancelOutcome: (
    input: DraftAuthorityBrowserCancelIdentity,
  ) => Promise<ReadDraftAuthorityBrowserCancelOutcome>;
  readonly readDraftAuthorityProtectedBrowserChatReference: (
    input: ReadDraftAuthorityProtectedBrowserChatReferenceInput,
  ) => Promise<ReadDraftAuthorityProtectedBrowserChatReferenceResult>;
  readonly readDraftAuthorityProtectedBrowserChat: (
    input: ReadDraftAuthorityProtectedBrowserChatInput,
  ) => Promise<DraftAuthorityProtectedBrowserContentsRead>;
}

/** Callable shape for the authority implementation. This module exports no runtime functions. */
export interface DraftAuthorityOrdinaryAttachmentApi {
  /** Cannot remove an ordinary owner or any of its existing digests. */
  readonly writeDraftAuthority: (
    input: WriteDraftAuthorityWithOrdinaryAssetsInput,
  ) => Promise<DraftAuthorityMutationResult<DraftAuthorityEditReceipt, DraftAuthorityRecord>>;
  readonly publishDraftAuthorityOutbox: (
    input: PublishDraftAuthorityOutboxWithOrdinaryAssetsInput,
  ) => Promise<DraftAuthorityMutationResult<DraftAuthorityOrdinaryOutboxView, DraftAuthorityOutbox>>;
  readonly transferDraftAuthorityOutbox: (
    input: TransferDraftAuthorityOutboxWithOrdinaryAssetsInput,
  ) => Promise<DraftAuthorityMutationResult<DraftAuthorityOrdinaryOutboxView, DraftAuthorityOutbox>>;
  readonly admitLegacyDraftAuthorityOutbox: (
    input: AdmitLegacyDraftAuthorityOrdinaryOutboxInput,
  ) => Promise<DraftAuthorityMutationResult<DraftAuthorityOrdinaryOutboxView, DraftAuthorityOutbox>>;
  readonly settleDraftAuthorityEffect: (
    input: SettleDraftAuthorityEffectWithOrdinaryAssetsInput,
  ) => Promise<DraftAuthorityMutationResult<DraftAuthorityIssueReceipt, DraftAuthorityOutbox>>;
  readonly readDraftAuthorityOutbox: (
    input: ReadDraftAuthorityOrdinaryAwareOutboxInput,
  ) => Promise<DraftAuthorityOrdinaryAwareOutboxRead>;
  readonly listDraftAuthorityOutboxes: (
    actor: DraftAuthorityActor,
  ) => Promise<DraftAuthorityOrdinaryAwareOutboxList>;
  readonly readDraftAuthorityOrdinaryAssets: (
    input: ReadDraftAuthorityOrdinaryAssetsInput,
  ) => Promise<DraftAuthorityOrdinaryAssetsRead>;
  readonly readDraftAuthorityOrdinaryOutboxAssets: (
    input: ReadDraftAuthorityOrdinaryOutboxAssetsInput,
  ) => Promise<DraftAuthorityOrdinaryAssetsRead>;
  readonly readDraftAuthorityOrdinaryReturnPlan: (
    input: ReadDraftAuthorityOrdinaryReturnPlanInput,
  ) => Promise<DraftAuthorityOrdinaryReturnPlan>;
  readonly claimDraftAuthorityOrdinaryFirstTurn: (
    input: ClaimDraftAuthorityOrdinaryFirstTurnInput,
  ) => Promise<DraftAuthorityOrdinaryFirstTurnClaimResult>;
  readonly readDraftAuthorityOrdinaryFirstTurnGrant: (
    input: ReadDraftAuthorityOrdinaryFirstTurnGrantInput,
  ) => Promise<boolean>;
  readonly settleDraftAuthorityOrdinaryFirstTurn: (
    input: SettleDraftAuthorityOrdinaryFirstTurnInput,
  ) => Promise<DraftAuthorityMutationResult<DraftAuthorityOrdinaryOutboxView, DraftAuthorityOutbox>>;
  readonly recordDraftAuthorityReturn: (
    input: RecordDraftAuthorityOrdinaryReturnInput,
  ) => Promise<DraftAuthorityMutationResult<DraftAuthorityOrdinaryOutboxView, DraftAuthorityOutbox>>;
  readonly publishDraftAuthorityReturn: (
    input: PublishDraftAuthorityOrdinaryReturnInput,
  ) => Promise<PublishDraftAuthorityOrdinaryReturnResult>;
  /** The only callable that lowers an ordinary isolated ref. */
  readonly releaseDraftAuthorityOrdinaryRefs: (
    input: ReleaseDraftAuthorityOrdinaryRefsInput,
  ) => Promise<ReleaseDraftAuthorityOrdinaryRefsResult>;
  readonly importDraftAuthorityOrdinarySlot: (
    input: ImportDraftAuthorityOrdinarySlotInput,
  ) => Promise<DraftAuthorityReadResult>;
  readonly importDraftAuthorityRetainedLanding: (
    input: ImportDraftAuthorityRetainedLandingInput,
  ) => Promise<DraftAuthorityLandingFlush>;
  readonly readLegacyNativeLandingVerifiedBlobs: (
    input: ReadLegacyNativeLandingVerifiedBlobsInput,
  ) => Promise<ReadLegacyNativeLandingVerifiedBlobsResult>;
  readonly retainDraftAuthorityLandingHistory: (
    input: RetainDraftAuthorityLandingHistoryInput,
  ) => Promise<DraftAuthorityOrdinaryAwareLandingRetain>;
  readonly admitDraftAuthorityLandingHistory: (
    input: AdmitDraftAuthorityLandingHistoryInput,
  ) => Promise<DraftAuthorityLandingFlush>;
  readonly readDraftAuthorityLandingRetentions: () => Promise<DraftAuthorityOrdinaryAwareLandingRetentions>;
}

/** A2 publishes same-window closed custody before acknowledging the exact native import. */
export interface CanonicalLandingOrdinaryAttachmentApi {
  readonly admitCanonicalLandingHistoryDraft: (
    input: AdmitCanonicalLandingHistoryDraftInput,
  ) => Promise<DraftAuthorityLandingFlush>;
}
