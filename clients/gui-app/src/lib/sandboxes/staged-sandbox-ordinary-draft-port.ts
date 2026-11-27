import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/schemas";
import type { DraftWrite } from "@traycer/protocol/host/drafts";

type ComposerWrite = Extract<
  DraftWrite,
  { kind: "landing" | "new-chat" | "chat-composer" }
>;

interface DraftBase {
  readonly headSha256: string | null;
  readonly ownerEpoch: number;
  readonly revision: number;
}

export interface OrdinaryDraftSnapshot {
  readonly scopeId: string;
  readonly write: Pick<
    ComposerWrite,
    "draftId" | "kind" | "target" | "workspace" | "lastTouchedAt"
  > & {
    readonly portable: ComposerWrite["portable"] & {
      readonly annotations: BrowserAnnotationRecord[];
    };
  };
  readonly occurrence: string;
  readonly localRevision: number;
  readonly base: DraftBase | null;
}

interface PlacedOrdinaryDraft {
  readonly status: "placed";
  readonly draftId: string;
  readonly base: DraftBase;
  readonly operationId: string;
}

interface StagedSandboxOrdinaryDraftPort {
  readonly captureOrdinaryDraftSnapshot: (
    draftId: string,
  ) => OrdinaryDraftSnapshot | null;
  readonly placeOrdinaryDraft: (
    snapshot: OrdinaryDraftSnapshot,
    operationId: string,
  ) => Promise<PlacedOrdinaryDraft | { readonly status: "unsettled" }>;
  readonly settleOrdinaryDraftIfCurrent: (
    snapshot: OrdinaryDraftSnapshot,
    receipt: PlacedOrdinaryDraft,
  ) => boolean;
}

/** The ordinary draft port is installed with the joined draft sync. */
export function stagedSandboxOrdinaryDraftPort(): StagedSandboxOrdinaryDraftPort | null {
  return null;
}
