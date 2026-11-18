import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { BotReadCursorAdvanceRequest } from "@traycer/protocol/host/bot/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  useBotReadCursorAdvanceMutation,
  type BotReadCursorAdvanceVariables,
} from "@/hooks/bots/use-bot-read-cursor";

type BatchState = { readonly pending: boolean; readonly failed: boolean };
type AdvanceRead = (target: BotReadCursorAdvanceVariables) => Promise<unknown>;
const IDLE: BatchState = { pending: false, failed: false };

/** Failed positions belong to the same requester lifetime as their first click. */
class RepresentedReadBatch {
  private mounted = false;
  private retirement = new AbortController();
  private remaining: readonly BotReadCursorAdvanceRequest[] = [];
  private state: BatchState = IDLE;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly client: HostClient<HostRpcRegistry> | null) {}

  readonly snapshot = (): BatchState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  mount(): () => void {
    this.mounted = true;
    const unsubscribe = this.client?.onChange((event) => {
      if (event.reason === "auth-changed") this.retire();
    });
    return () => {
      this.mounted = false;
      unsubscribe?.();
      this.retire();
    };
  }

  private publish(state: BatchState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private retire(): void {
    this.retirement.abort();
    this.retirement = new AbortController();
    this.remaining = [];
    this.publish(IDLE);
  }

  private isCurrent(signal: AbortSignal): boolean {
    return this.mounted && signal === this.retirement.signal && !signal.aborted;
  }

  async run(
    targets: readonly BotReadCursorAdvanceRequest[],
    advance: AdvanceRead,
  ): Promise<void> {
    if (!this.mounted || this.state.pending) return;
    const captured = this.remaining.length > 0 ? this.remaining : targets;
    if (captured.length === 0) return;
    const { signal } = this.retirement;
    this.publish({ pending: true, failed: false });
    const failed: BotReadCursorAdvanceRequest[] = [];
    for (const target of captured) {
      if (!this.isCurrent(signal)) return;
      try {
        await advance({ ...target, signal });
      } catch {
        if (!this.isCurrent(signal)) return;
        failed.push(target);
      }
      if (!this.isCurrent(signal)) return;
    }
    this.remaining = failed;
    this.publish({ pending: false, failed: failed.length > 0 });
  }
}

/** A retry finishes the captured batch; newer arrivals belong to the next action. */
export function useBotMarkRepresentedRead(
  targets: readonly BotReadCursorAdvanceRequest[],
): {
  readonly markRead: () => void;
  readonly pending: boolean;
  readonly failed: boolean;
} {
  const client = useTabHostClient();
  const mutation = useBotReadCursorAdvanceMutation(client);
  const batch = useMemo(() => new RepresentedReadBatch(client), [client]);
  useEffect(() => batch.mount(), [batch]);
  const state = useSyncExternalStore(batch.subscribe, batch.snapshot);
  return {
    markRead: () => void batch.run(targets, mutation.mutateAsync),
    pending: state.pending,
    failed: state.failed,
  };
}
