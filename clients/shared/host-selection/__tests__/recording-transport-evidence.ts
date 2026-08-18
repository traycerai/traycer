import type {
  SelectionIncompatibility,
  SelectionTransportKind,
} from "../selection-authority-contract";
import type { TransportEvidenceReporter } from "../transport-evidence";

export type RecordedTransportEvidence =
  | {
      readonly kind: "sessionEstablished";
      readonly hostId: string;
      readonly sessionId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly kind: "sessionLost";
      readonly hostId: string;
      readonly sessionId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly kind: "dialSuccess";
      readonly hostId: string;
      readonly attemptId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly kind: "dialRefusal";
      readonly hostId: string;
      readonly attemptId: string;
      readonly transportKind: SelectionTransportKind;
      readonly refusalDetail: "plan-restricted" | null;
    }
  | {
      readonly kind: "dialTimeout";
      readonly hostId: string;
      readonly attemptId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly kind: "dialIndeterminate";
      readonly hostId: string;
      readonly attemptId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly kind: "compat";
      readonly hostId: string;
    }
  | {
      readonly kind: "restartIntent";
      readonly hostId: string;
      readonly tombstoneId: string;
      readonly expiresAt: number | null;
    };

/** Recording {@link TransportEvidenceReporter} for producer-suite tests. */
export class RecordingTransportEvidence implements TransportEvidenceReporter {
  readonly events: RecordedTransportEvidence[] = [];

  sessionEstablished(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.events.push({
      kind: "sessionEstablished",
      hostId,
      sessionId,
      transportKind,
    });
  }

  sessionLost(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.events.push({
      kind: "sessionLost",
      hostId,
      sessionId,
      transportKind,
    });
  }

  reportDialSuccess(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.events.push({
      kind: "dialSuccess",
      hostId,
      attemptId,
      transportKind,
    });
  }

  reportDialRefusal(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
    refusalDetail: "plan-restricted" | null,
  ): void {
    this.events.push({
      kind: "dialRefusal",
      hostId,
      attemptId,
      transportKind,
      refusalDetail,
    });
  }

  reportDialTimeout(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.events.push({
      kind: "dialTimeout",
      hostId,
      attemptId,
      transportKind,
    });
  }

  reportDialIndeterminate(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.events.push({
      kind: "dialIndeterminate",
      hostId,
      attemptId,
      transportKind,
    });
  }

  reportCompatVerdict(input: {
    readonly hostId: string;
    readonly probedOnSessionId: string | null;
    readonly hostVersion: string | null;
    readonly incompatibility: SelectionIncompatibility | null;
  }): void {
    this.events.push({ kind: "compat", hostId: input.hostId });
  }

  ofKind<K extends RecordedTransportEvidence["kind"]>(
    kind: K,
  ): Extract<RecordedTransportEvidence, { kind: K }>[] {
    return this.events.filter(
      (event): event is Extract<RecordedTransportEvidence, { kind: K }> =>
        event.kind === kind,
    );
  }

  reportRestartIntent(
    hostId: string,
    tombstoneId: string,
    expiresAt: number | null,
  ): void {
    this.events.push({
      kind: "restartIntent",
      hostId,
      tombstoneId,
      expiresAt,
    });
  }
}
