/** Reporter identity comes from the IPC sender, never the payload; attach-seq is allocated in main. */
import type {
  ActivateResult,
  HostLeaseSnapshot,
  SelectionAttachRequest,
  SelectionAttachResult,
  SelectionChange,
  SelectionEvidenceReport,
  SelectionReattachRequired,
  SelectionRevisioned,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";

/** `selectionAttachSeq` advances the supersession fence; no preload-local counter. */
export interface SelectionAuthoritySyncMap {
  selectionAttachSeq: {
    result: number;
  };
}

/** `incarnationId` is a leading argument on the two scoped calls. */
export interface SelectionAuthorityInvokeMap {
  attach: {
    args: [request: SelectionAttachRequest];
    result: SelectionAttachResult;
  };
  reportEvidence: {
    args: [incarnationId: string, report: SelectionEvidenceReport];
    result: void;
  };
  activate: {
    args: [incarnationId: string, hostId: string];
    result: ActivateResult;
  };
  /** Renderer-driven fleet reread; main does not poll the registry. */
  refreshFleet: {
    args: [];
    result: void;
  };
}

/** Each emission carries a unique authority revision; one high-water mark orders all three. */
export interface SelectionAuthorityEventMap {
  selectionChanged: SelectionRevisioned<SelectionChange>;
  leasesChanged: SelectionRevisioned<readonly HostLeaseSnapshot[]>;
  /** Post-identity-transition re-attach trigger. */
  reattachRequired: SelectionReattachRequired;
}
