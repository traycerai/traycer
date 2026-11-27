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

interface EpicTitleAnchor {
  readonly row: EpicHeader;
  readonly requestId: string | null;
}

/** Echo evidence for one live FIFO title chain on one replica. */
export class EpicTitleEchoes {
  private anchor: EpicTitleAnchor | null = null;
  private unreadSends: EpicTitleSend[] = [];
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
      this.anchor = { row: echo, requestId: send.requestId };
      this.unreadSends = [];
      return;
    }
    if (
      this.anchor?.requestId !== send.requestId &&
      !this.awaitsEcho(send.requestId)
    ) {
      this.unreadSends.push(send);
    }
  }

  observes(row: EpicHeader, baseline: string): boolean {
    if (this.anchor === null && row.title === baseline) {
      this.anchor = { row, requestId: null };
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
    if (matched === this.sending) {
      // Keep the preceding evidence in case the response proves no dispatch.
      this.provisionalEcho = row;
    } else {
      this.anchor = { row, requestId: matched.requestId };
      this.unreadSends.splice(0, this.unreadSends.indexOf(matched) + 1);
    }
    this.onSizeChanged();
    return true;
  }

  private matchSend(row: EpicHeader): EpicTitleSend | undefined {
    const matching = this.unreadSends.filter(
      (send) => send.title === row.title,
    );
    if (
      this.sending?.title === row.title &&
      !matching.some((send) => send.requestId === this.sending?.requestId)
    ) {
      matching.push(this.sending);
    }
    if (matching.length < 2) return matching.at(0);

    // The timestamp correlates eligible local writes. It does not order room
    // rows. Without a unique match, the older send can explain the observation
    // without settling the later attempt.
    const correlated = matching.filter(
      (send) => send.updatedAt === row.updatedAt,
    );
    return correlated.length === 1 ? correlated.at(0) : matching.at(0);
  }

  echoes(requestId: string): boolean {
    return (
      this.provisionalEcho === null && this.anchor?.requestId === requestId
    );
  }

  atBaseline(): boolean {
    return this.anchor?.requestId === null;
  }

  awaitsEcho(requestId: string): boolean {
    return this.unreadSends.some((send) => send.requestId === requestId);
  }

  clear(): void {
    this.anchor = null;
    this.unreadSends = [];
    this.sending = null;
    this.provisionalEcho = null;
    this.onSizeChanged();
  }

  retainedSize(): RetainedValueSize {
    return retainedValueSize({
      anchor: this.anchor,
      unreadSends: this.unreadSends,
      sending: this.sending,
      provisionalEcho: this.provisionalEcho,
    });
  }
}
