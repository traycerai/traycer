import type { EpicHeader } from "../types";
import {
  retainedValueSize,
  type RetainedValueSize,
} from "@/stores/replica-memory/retained-value-size";

export interface EpicTitleSend {
  readonly requestId: string;
  readonly title: string;
  readonly updatedAt: number;
}

type EpicTitleAnchor =
  | { readonly kind: "baseline" | "unattributed"; readonly row: EpicHeader }
  | {
      readonly kind: "echo";
      readonly row: EpicHeader;
      readonly requestId: string;
    };

/** Bound the disambiguation history independently of how long the chain stays live. */
const MAX_COMPACTED_TITLE_STAMPS = 64;

/** Echo evidence for one live FIFO title chain on one replica. */
export class EpicTitleEchoes {
  private anchor: EpicTitleAnchor | null = null;
  private unreadSends: EpicTitleSend[] = [];
  // null means the history overflowed. Candidate titles stay compatible,
  // but without complete history no observation can prove their attribution.
  private compactedStamps: Map<string, Set<number>> | null = new Map();
  private compactedStampCount = 0;
  private sending: EpicTitleSend | null = null;
  private provisionalEcho: EpicHeader | null = null;

  constructor(private readonly onSizeChanged: () => void) {}

  begin(requestId: string, title: string, updatedAt: number): EpicTitleSend {
    const send = { requestId, title, updatedAt };
    this.sending = send;
    this.provisionalEcho = null;
    this.onSizeChanged();
    return send;
  }

  /** Returns true when retracting an echo requires a fresh projection. */
  finish(send: EpicTitleSend, mayHaveDispatched: boolean): boolean {
    if (this.sending !== send) return false;
    const echo = this.provisionalEcho;
    this.sending = null;
    this.provisionalEcho = null;
    if (mayHaveDispatched) this.retainSend(send, echo);
    this.onSizeChanged();
    return echo !== null && !mayHaveDispatched;
  }

  private retainSend(send: EpicTitleSend, echo: EpicHeader | null): void {
    if (echo !== null) {
      this.anchor = { kind: "echo", row: echo, requestId: send.requestId };
      this.compactSends(this.unreadSends.length);
      this.rememberCompactedStamp(send);
      return;
    }
    if (!this.echoes(send.requestId) && !this.awaitsEcho(send.requestId)) {
      this.unreadSends.push(send);
    }
  }

  private compactSends(count: number): void {
    for (const send of this.unreadSends.splice(0, count)) {
      this.rememberCompactedStamp(send);
    }
  }

  private rememberCompactedStamp(send: EpicTitleSend): void {
    const { compactedStamps } = this;
    if (compactedStamps === null) return;
    const stamps = compactedStamps.get(send.title) ?? new Set<number>();
    if (stamps.has(send.updatedAt)) return;
    if (this.compactedStampCount === MAX_COMPACTED_TITLE_STAMPS) {
      this.compactedStamps = null;
      return;
    }
    stamps.add(send.updatedAt);
    compactedStamps.set(send.title, stamps);
    this.compactedStampCount += 1;
  }

  observes(row: EpicHeader, baseline: string): boolean {
    if (this.anchor === null && row.title === baseline) {
      this.anchor = { kind: "baseline", row };
      this.onSizeChanged();
      return true;
    }
    if (this.provisionalEcho !== null) {
      if (row.title !== this.provisionalEcho.title) return false;
      this.provisionalEcho = row;
      return true;
    }
    if (this.anchor?.row.title === row.title) {
      // Metadata can advance without a title write. The same visible title
      // cannot supply new evidence for a different command.
      if (row.updatedAt !== this.anchor.row.updatedAt) {
        this.anchor = { ...this.anchor, row };
      }
      return true;
    }

    const matched = this.matchSend(row);
    if (matched === undefined) return false;
    if (matched === null) {
      // Keep the raw observation for duplicate detection without attributing
      // it to either a compacted send or an eligible send.
      this.anchor = { kind: "unattributed", row };
    } else if (matched === this.sending) {
      // Keep the preceding evidence in case the response proves no dispatch.
      this.provisionalEcho = row;
    } else {
      this.anchor = { kind: "echo", row, requestId: matched.requestId };
      this.compactSends(this.unreadSends.indexOf(matched) + 1);
    }
    this.onSizeChanged();
    return true;
  }

  /** Null preserves compatibility without attribution. Undefined means independent movement. */
  private matchSend(row: EpicHeader): EpicTitleSend | null | undefined {
    const matching = this.unreadSends.filter(
      (send) => send.title === row.title,
    );
    if (
      this.sending?.title === row.title &&
      !matching.some((send) => send.requestId === this.sending?.requestId)
    ) {
      matching.push(this.sending);
    }
    const oldest = matching.at(0);
    if (oldest === undefined) return undefined;
    const { compactedStamps } = this;
    if (compactedStamps === null) return null;
    const obsolete = compactedStamps.get(row.title);
    if (obsolete?.has(row.updatedAt)) return null;
    // Metadata can rewrite the timestamp of a title that has only one
    // possible local origin. Preserve title-only attribution for that case.
    if (matching.length === 1 && obsolete === undefined) return oldest;

    // Timestamps distinguish sends bearing the same title. The order of
    // room observations decides which of those sends are still eligible.
    const correlated = matching.filter(
      (send) => send.updatedAt === row.updatedAt,
    );
    if (correlated.length === 1) return correlated[0];
    // An older unread send can explain the row without settling a later
    // attempt. A compacted send is never an eligible explanation.
    return obsolete === undefined ? oldest : null;
  }

  echoes(requestId: string): boolean {
    return (
      this.provisionalEcho === null &&
      this.anchor?.kind === "echo" &&
      this.anchor.requestId === requestId
    );
  }

  atBaseline(): boolean {
    return this.anchor?.kind === "baseline";
  }

  awaitsEcho(requestId: string): boolean {
    return this.unreadSends.some((send) => send.requestId === requestId);
  }

  clear(): void {
    this.anchor = null;
    this.unreadSends = [];
    this.compactedStamps = new Map();
    this.compactedStampCount = 0;
    this.sending = null;
    this.provisionalEcho = null;
    this.onSizeChanged();
  }

  retainedSize(): RetainedValueSize {
    return retainedValueSize({
      anchor: this.anchor,
      unreadSends: this.unreadSends,
      compactedStamps: this.compactedStamps,
      sending: this.sending,
      provisionalEcho: this.provisionalEcho,
    });
  }
}
