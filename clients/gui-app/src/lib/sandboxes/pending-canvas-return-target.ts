import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import {
  readCanonicalChatCanvasSidecar,
  type DraftAuthorityCanvasScope,
} from "@/lib/drafts/draft-authority-sidecar";
import type {
  DraftAuthorityActor,
  DraftAuthorityExpectation,
  DraftAuthorityVersion,
} from "@/lib/drafts/draft-authority-types";
import {
  pendingCanvasReturnAdmissionIsCurrent,
  type MountedCanvasReturnAdmission,
} from "@/lib/sandboxes/pending-canvas-return-admission";

interface PendingCanvasReturnTargetInput {
  readonly actor: DraftAuthorityActor;
  readonly hostId: string;
  readonly expected: DraftAuthorityExpectation;
  readonly occurrence: DraftAuthorityVersion["occurrence"];
  readonly admission: MountedCanvasReturnAdmission | null;
  readonly annotations: ReadonlyArray<BrowserAnnotationRecord>;
}

type PendingCanvasReturnTarget =
  | { readonly kind: "held" }
  | {
      readonly kind: "scoped";
      readonly canvasSidecar: {
        readonly scope: DraftAuthorityCanvasScope;
        readonly expectedVersion: string | null;
        readonly annotations: ReadonlyArray<BrowserAnnotationRecord>;
      };
    };

/** Resolve the admitted native sidecar to compare in the return transaction. */
export async function readPendingCanvasReturnTarget({
  actor,
  hostId,
  expected,
  occurrence,
  admission,
  annotations,
}: PendingCanvasReturnTargetInput): Promise<PendingCanvasReturnTarget> {
  const slot = expected.kind === "absent" ? expected.slot : expected.draft.slot;
  if (
    slot.kind !== "chat" ||
    admission === null ||
    admission.chatId !== slot.id ||
    admission.hostId !== hostId ||
    admission.actor.accountId !== actor.accountId ||
    admission.actor.sessionGeneration !== actor.sessionGeneration ||
    !pendingCanvasReturnAdmissionIsCurrent(admission) ||
    annotations.length === 0 ||
    annotations.some((record) => record.source.kind !== "canvas")
  ) {
    return { kind: "held" };
  }

  const { scope } = admission;
  if (expected.kind === "absent") {
    return {
      kind: "scoped",
      canvasSidecar: { scope, expectedVersion: null, annotations },
    };
  }
  if (expected.draft.occurrence !== occurrence) return { kind: "held" };

  const read = await readCanonicalChatCanvasSidecar(
    expected.draft,
    scope,
    actor,
  );
  if (
    read.kind !== "current" ||
    !pendingCanvasReturnAdmissionIsCurrent(admission)
  ) {
    return { kind: "held" };
  }

  const { sidecar } = read;
  if (
    sidecar !== null &&
    (sidecar.annotations.length > 0 ||
      sidecar.rootDigests.length > 0 ||
      (sidecar.accountId !== null && sidecar.accountId !== actor.accountId))
  ) {
    return { kind: "held" };
  }

  return {
    kind: "scoped",
    canvasSidecar: { scope, expectedVersion: sidecar?.version ?? null, annotations },
  };
}
