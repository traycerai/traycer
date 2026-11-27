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
  | { readonly kind: "baseline" | "unattributed"; readonly title: string }
  | {
      readonly kind: "echo";
      readonly title: string;
      readonly requestId: string;
    };

interface TitleCandidate {
  readonly index: number;
  readonly send: EpicTitleSend;
}

interface TitleMatch {
  readonly compactCount: number;
  readonly requestId: string | null;
}

/** Bound the disambiguation history independently of how long the chain stays live. */
const MAX_COMPACTED_TITLE_STAMPS = 64;

/** The accepted boundary under one possible dispatch history. */
class TitleHistory {
  anchor: EpicTitleAnchor | null = null;
  compatible = false;
  private unreadSends: EpicTitleSend[] = [];
  // Overflow still permits ordered advancement, but cannot identify a request.
  private compactedStamps: Map<string, Set<number>> | null = new Map();
  private compactedStampCount = 0;

  withSend(send: EpicTitleSend): TitleHistory {
    const history = new TitleHistory();
    history.anchor = this.anchor;
    history.compatible = this.compatible;
    history.unreadSends = [...this.unreadSends];
    history.compactedStampCount = this.compactedStampCount;
    history.compactedStamps =
      this.compactedStamps === null
        ? null
        : new Map(
            [...this.compactedStamps].map(([title, stamps]) => [
              title,
              new Set(stamps),
            ]),
          );
    history.retainSend(send);
    return history;
  }

  retainSend(send: EpicTitleSend): void {
    if (!this.echoes(send.requestId) && !this.awaitsEcho(send.requestId)) {
      this.unreadSends.push(send);
    }
  }

  observes(
    row: EpicHeader,
    baseline: string,
    excludedSend: EpicTitleSend | null,
  ): void {
    if (this.anchor === null && row.title === baseline) {
      this.anchor = { kind: "baseline", title: row.title };
    }
    if (this.anchor?.title === row.title) {
      this.compatible = true;
      return;
    }

    const match = this.matchSend(row, excludedSend);
    this.compatible = match !== null;
    if (match === null) return;
    this.anchor =
      match.requestId === null
        ? { kind: "unattributed", title: row.title }
        : { kind: "echo", title: row.title, requestId: match.requestId };
    for (const send of this.unreadSends.splice(0, match.compactCount)) {
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

  private matchSend(
    row: EpicHeader,
    excludedSend: EpicTitleSend | null,
  ): TitleMatch | null {
    const candidates: TitleCandidate[] = [];
    for (const [index, send] of this.unreadSends.entries()) {
      if (send.title === row.title) candidates.push({ index, send });
    }
    const oldest = candidates.at(0);
    if (oldest === undefined) return null;

    // Every explanation advances past this prefix, even if none proves
    // which request supplied the title.
    const unattributed = { compactCount: oldest.index, requestId: null };
    if (this.compactedStamps === null) return unattributed;
    const obsolete = this.compactedStamps.get(row.title);
    if (obsolete?.has(row.updatedAt)) return unattributed;

    // A sole origin needs no timestamp match. Metadata can rewrite the stamp
    // without moving the title. With repeats, use only unique correlation.
    const repeatedInOtherHistory =
      excludedSend?.title === row.title &&
      excludedSend.requestId !== oldest.send.requestId;
    const correlated =
      candidates.length === 1 &&
      obsolete === undefined &&
      !repeatedInOtherHistory
        ? candidates
        : candidates.filter(({ send }) => send.updatedAt === row.updatedAt);
    const match = correlated.at(0);
    return correlated.length === 1 && match !== undefined
      ? { compactCount: match.index + 1, requestId: match.send.requestId }
      : unattributed;
  }

  echoes(requestId: string): boolean {
    return this.anchor?.kind === "echo" && this.anchor.requestId === requestId;
  }

  awaitsEcho(requestId: string): boolean {
    return this.unreadSends.some((send) => send.requestId === requestId);
  }
}

interface ActiveTitleSend {
  readonly send: EpicTitleSend;
  withDispatch: TitleHistory | null;
}

/** Echo evidence for one live FIFO title chain on one replica. */
export class EpicTitleEchoes {
  private history = new TitleHistory();
  private sending: ActiveTitleSend | null = null;
  private observedTitle: string | null = null;

  constructor(private readonly onSizeChanged: () => void) {}

  begin(requestId: string, title: string, updatedAt: number): EpicTitleSend {
    const send = { requestId, title, updatedAt };
    this.sending = { send, withDispatch: null };
    this.onSizeChanged();
    return send;
  }

  /** Returns true when the unary changes the current row's compatibility. */
  finish(send: EpicTitleSend, mayHaveDispatched: boolean): boolean {
    const { sending } = this;
    if (sending?.send !== send) return false;

    const wasCompatible = this.compatibleHistory() !== null;
    this.sending = null;
    if (mayHaveDispatched) {
      if (sending.withDispatch === null) {
        this.history.retainSend(send);
      } else {
        this.history = sending.withDispatch;
      }
    }
    this.onSizeChanged();
    return wasCompatible !== this.history.compatible;
  }

  observes(row: EpicHeader, baseline: string): boolean {
    // A projection or timestamp-only patch of the same raw title supplies
    // no new correlation, including after selecting a dispatch history.
    if (row.title === this.observedTitle) {
      return this.compatibleHistory() !== null;
    }
    this.observedTitle = row.title;
    if (this.sending !== null) {
      // Advance both interpretations in observation order. A row supported
      // only by the active send must not consume evidence in the other one.
      this.sending.withDispatch ??= this.history.withSend(this.sending.send);
      this.sending.withDispatch.observes(row, baseline, null);
    }
    this.history.observes(row, baseline, this.sending?.send ?? null);
    this.onSizeChanged();
    return this.compatibleHistory() !== null;
  }

  private compatibleHistory(): TitleHistory | null {
    if (this.history.compatible) return this.history;
    const dispatched = this.sending?.withDispatch;
    return dispatched?.compatible === true ? dispatched : null;
  }

  echoes(requestId: string): boolean {
    const dispatched = this.sending?.withDispatch ?? null;
    return (
      this.history.compatible &&
      this.history.echoes(requestId) &&
      (dispatched === null ||
        (dispatched.compatible && dispatched.echoes(requestId)))
    );
  }

  atBaseline(): boolean {
    return this.compatibleHistory()?.anchor?.kind === "baseline";
  }

  awaitsEcho(requestId: string): boolean {
    return this.compatibleHistory()?.awaitsEcho(requestId) === true;
  }

  clear(): void {
    this.history = new TitleHistory();
    this.sending = null;
    this.observedTitle = null;
    this.onSizeChanged();
  }

  retainedSize(): RetainedValueSize {
    return retainedValueSize({
      history: this.history,
      sending: this.sending,
      observedTitle: this.observedTitle,
    });
  }
}
