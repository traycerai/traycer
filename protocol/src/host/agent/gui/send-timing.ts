/**
 * Local diagnostics shared by the two ends of chat.subscribe. No timing data
 * goes on the wire or into the chat journal. Durations use one process's
 * monotonic clock; wall times are correlation hints, never cross-host latency.
 */
export type SendTimingPhase =
  | "send_called"
  | "optimistic_pending_published"
  | "optimistic_queue_published"
  | "optimistic_not_published"
  | "dispatched"
  | "received"
  | "serialized"
  | "validated"
  | "worktree_start"
  | "worktree_end"
  | "prompt_start"
  | "attachments_ready"
  | "content_converted"
  | "command_catalog_start"
  | "command_catalog_end"
  | "prompt_identity_ready"
  | "prompt_end"
  | "queued_prepare_start"
  | "queued_prompt_ready"
  | "queued"
  | "activation_start"
  | "binding_handoff_start"
  | "binding_handoff_end"
  | "workspace_ready"
  | "session_prepare_start"
  | "session_prepare_end"
  | "persist_start"
  | "persist_end"
  | "acceptance_broadcast"
  | "acceptance_origin_absent"
  | "acceptance_pump_closed"
  | "queue_pump_closed"
  | "acceptance_held"
  | "acceptance_enqueued"
  | "acceptance_send_called"
  | "queue_held"
  | "queue_enqueued"
  | "queue_send_called"
  | "runtime_start"
  | "provider_input_queued"
  | "provider_input_pulled"
  | "provider_activity"
  | "provider_input_consumed"
  | "turn_started"
  | "handler_returned"
  | "handler_failed"
  | "ack_accepted"
  | "ack_rejected"
  | "acceptance_received"
  | "acceptance_applied"
  | "queue_received"
  | "transcript_received"
  | "pending_replaced_by_acceptance"
  | "pending_removed"
  | "pending_replaced_by_transcript"
  | "pending_replaced_by_queue"
  | "transport_closed";

export interface SendTimingEntry {
  readonly side: "gui" | "host";
  readonly epicId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly clientActionId: string;
  readonly phase: SendTimingPhase | "retransmitted";
  readonly previousPhase: SendTimingPhase | "retransmitted" | null;
  readonly attempt: number;
  readonly occurrence: number;
  readonly attemptElapsedMs: number;
  readonly elapsedMs: number;
  readonly sincePreviousMs: number;
  readonly monotonicMs: number;
  readonly wallTimeMs: number;
}

export interface SendTimingBatch {
  readonly entries: readonly SendTimingEntry[];
  readonly droppedEntries: number;
}

interface SendTimingState {
  clientActionId: string;
  // Kept in memory only. A connection id may contain account identity.
  observerKey: string | null;
  readonly started: number;
  attemptStarted: number;
  attempt: number;
  previous: number;
  previousPhase: SendTimingEntry["phase"] | null;
  readonly occurrences: Map<SendTimingEntry["phase"], number>;
  pendingReconciled: boolean;
}

// Frame ids are untrusted strings. Only UUID-shaped correlation ids belong in
// an INFO log: never render an arbitrary client field, prompt or account id.
function correlationId(value: string): string {
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(value)
    ? value
    : "<non-uuid>";
}

const MAX_TRACES = 128;
const MAX_AGE_MS = 60 * 60 * 1_000;

/**
 * Opt-in, bounded diagnostics. Marks only capture timestamps in memory. A
 * one-second batch flush keeps synchronous file logging off the send stack
 * while preserving the last observed phase of a send parked on an await.
 * A blocked event loop delays the flush, not the captured timestamps.
 */
export class SendTimings {
  private readonly traces = new Map<string, SendTimingState>();
  private entries: SendTimingEntry[] = [];
  private droppedEntries = 0;
  private flushTimer: { cancel: () => void } | null = null;

  constructor(
    private readonly context: {
      readonly side: SendTimingEntry["side"];
      readonly epicId: string;
      readonly chatId: string;
    },
    private readonly emit: (batch: SendTimingBatch) => void,
    readonly enabled: boolean,
  ) {}

  begin(
    messageId: string,
    clientActionId: string,
    observerKey: string | null,
  ): void {
    if (!this.enabled || messageId.length > 128 || clientActionId.length > 128)
      return;
    const now = performance.now();
    for (const [id, trace] of this.traces) {
      if (now - trace.started > MAX_AGE_MS) this.traces.delete(id);
    }
    const existing = this.traces.get(messageId);
    if (existing !== undefined) {
      existing.clientActionId = clientActionId;
      existing.observerKey = observerKey;
      existing.attempt += 1;
      existing.attemptStarted = now;
      existing.occurrences.clear();
      existing.pendingReconciled = false;
      this.write(messageId, existing, "retransmitted", now);
    } else {
      if (this.traces.size >= MAX_TRACES) {
        const oldest = this.traces.keys().next();
        if (!oldest.done) this.traces.delete(oldest.value);
      }
      this.traces.set(messageId, {
        clientActionId,
        observerKey,
        started: now,
        attemptStarted: now,
        attempt: 1,
        previous: now,
        previousPhase: null,
        occurrences: new Map(),
        pendingReconciled: false,
      });
    }
    this.mark(
      messageId,
      this.context.side === "gui" ? "send_called" : "received",
    );
  }

  /** Keep first receipt/liveness; preparation phases can recur on queued sends. */
  mark(messageId: string | null, phase: SendTimingPhase): void {
    if (messageId === null) return;
    const trace = this.traces.get(messageId);
    if (trace === undefined) return;
    if (
      (phase === "provider_activity" || phase === "transcript_received") &&
      trace.occurrences.has(phase)
    )
      return;
    const now = performance.now();
    if (now - trace.started > MAX_AGE_MS) {
      this.traces.delete(messageId);
      return;
    }
    this.write(messageId, trace, phase, now);
  }

  observerIsPresent(
    messageId: string,
    hasObserver: (key: string) => boolean,
  ): boolean {
    const key = this.traces.get(messageId)?.observerKey;
    return key !== undefined && key !== null && hasObserver(key);
  }

  /** Measure delivery to the sending connection, never a faster bystander. */
  markForObserver(
    messageId: string,
    observerKey: string,
    phase: SendTimingPhase,
  ): void {
    if (this.traces.get(messageId)?.observerKey === observerKey)
      this.mark(messageId, phase);
  }

  hasPhase(messageId: string, phase: SendTimingPhase): boolean {
    return this.traces.get(messageId)?.occurrences.has(phase) === true;
  }

  pendingIsUnreconciled(messageId: string): boolean {
    const trace = this.traces.get(messageId);
    return trace !== undefined && !trace.pendingReconciled;
  }

  reconcilePending(
    messageId: string,
    phase:
      | "pending_replaced_by_acceptance"
      | "pending_replaced_by_transcript"
      | "pending_replaced_by_queue"
      | "pending_removed",
  ): void {
    const trace = this.traces.get(messageId);
    if (trace === undefined || trace.pendingReconciled) return;
    trace.pendingReconciled = true;
    this.mark(messageId, phase);
  }

  flush(): void {
    if (this.flushTimer !== null) this.flushTimer.cancel();
    this.flushTimer = null;
    if (this.entries.length === 0) return;
    const batch: SendTimingBatch = {
      entries: this.entries,
      droppedEntries: this.droppedEntries,
    };
    this.entries = [];
    this.droppedEntries = 0;
    try {
      this.emit(batch);
    } catch {
      // Observability owns no acknowledgement or delivery state.
    }
  }

  clear(): void {
    this.flush();
    this.traces.clear();
  }

  private write(
    messageId: string,
    trace: SendTimingState,
    phase: SendTimingEntry["phase"],
    now: number,
  ): void {
    const occurrence = (trace.occurrences.get(phase) ?? 0) + 1;
    trace.occurrences.set(phase, occurrence);
    const entry: SendTimingEntry = {
      side: this.context.side,
      epicId: correlationId(this.context.epicId),
      chatId: correlationId(this.context.chatId),
      messageId: correlationId(messageId),
      clientActionId: correlationId(trace.clientActionId),
      phase,
      previousPhase: trace.previousPhase,
      attempt: trace.attempt,
      occurrence,
      attemptElapsedMs: Math.round((now - trace.attemptStarted) * 10) / 10,
      elapsedMs: Math.round((now - trace.started) * 10) / 10,
      sincePreviousMs: Math.round((now - trace.previous) * 10) / 10,
      monotonicMs: Math.round(now * 10) / 10,
      wallTimeMs: Date.now(),
    };
    trace.previous = now;
    trace.previousPhase = phase;
    if (this.entries.length < 4096) this.entries.push(entry);
    else this.droppedEntries += 1;
    if (this.flushTimer === null) {
      const timer = setTimeout(() => this.flush(), 1000);
      this.flushTimer = { cancel: () => clearTimeout(timer) };
    }
  }
}
