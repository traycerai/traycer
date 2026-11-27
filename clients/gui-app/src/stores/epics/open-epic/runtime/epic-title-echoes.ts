import type { EpicHeader } from "../types";
import {
  retainedValueSize,
  type RetainedValueSize,
} from "@/stores/replica-memory/retained-value-size";

export interface EpicTitleSend {
  readonly requestId: string;
  readonly title: string;
}

interface EpicTitleAnchor {
  readonly row: EpicHeader;
  readonly requestId: string | null;
}

function sameRow(a: EpicHeader, b: EpicHeader): boolean {
  return a.title === b.title && a.updatedAt === b.updatedAt;
}

/** Echo evidence for one live FIFO title chain on one replica. */
export class EpicTitleEchoes {
  private anchor: EpicTitleAnchor | null = null;
  private unreadSends: EpicTitleSend[] = [];
  private sending: EpicTitleSend | null = null;
  private provisionalEcho: EpicHeader | null = null;

  constructor(private readonly onSizeChanged: () => void) {}

  begin(requestId: string, title: string): EpicTitleSend {
    const send = { requestId, title };
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
    if (this.anchor !== null && sameRow(this.anchor.row, row)) return true;

    const index = this.unreadSends.findIndex(
      (send) => send.title === row.title,
    );
    if (index >= 0) {
      this.anchor = { row, requestId: this.unreadSends[index].requestId };
      this.unreadSends.splice(0, index + 1);
    } else if (this.sending?.title === row.title) {
      // A response can prove this attempt never left the client. Keep the
      // preceding anchor and history until that possibility is resolved.
      this.provisionalEcho = row;
    } else if (this.anchor?.row.title === row.title) {
      this.anchor = { ...this.anchor, row };
    } else {
      return false;
    }
    this.onSizeChanged();
    return true;
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
