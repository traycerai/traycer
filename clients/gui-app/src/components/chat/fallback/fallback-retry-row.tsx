import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { PendingFallback } from "@traycer/protocol/host/agent/gui/subscribe";
import { LivePulse } from "@/components/ui/live-pulse";
import type { HostRpcRegistry } from "@/lib/host";
import {
  fallbackTupleIdentity,
  useFallbackProfileLabels,
} from "./fallback-identity";

/**
 * The transient "retrying" status row, at the turn tail.
 *
 * Driven entirely by the pending-fallback DTO (`state: "retrying"`), and
 * deliberately NOT a transcript block. `ProviderNoticeSegment` has no lifecycle
 * of its own, the runtime accumulator upserts same-id TEXT blocks in place but
 * APPENDS errors as new blocks, and a retry that succeeds has no durable exit at
 * all - so a block here would leave a permanent "Retrying…" orphan in the
 * transcript of every chat a transient retry rescued. A component that unmounts
 * when the state moves is the whole design (engine spec, §Wait rung, N5).
 *
 * It borrows the streaming notice's LOOK - the accent rule, the pulse, the muted
 * weight - so it reads as part of the turn rather than as a new kind of thing.
 * The transcript's own record of the retry series is the error card each failed
 * attempt already published, plus the "after N retries" line on a later switch's
 * attribution: a successful retry correctly leaves nothing behind.
 *
 * Returns `null` for every other traversal state, so the caller mounts it
 * unconditionally and this one predicate decides.
 */
export function FallbackRetryRow({
  pending,
  client,
}: {
  readonly pending: PendingFallback | undefined;
  readonly client: HostClient<HostRpcRegistry> | null;
}) {
  // Hooks run before the state gate, as they must - the providers read is
  // enabled only while a retry is actually on screen, so a chat with no
  // traversal issues no query.
  const retrying = pending !== undefined && pending.state === "retrying";
  const labelFor = useFallbackProfileLabels(client, retrying);
  if (pending === undefined || pending.state !== "retrying") return null;

  // The tuple being retried is the one that FAILED: a transient retry is the
  // same tuple again by definition (D57 - a retry never commits settings and
  // never restamps), so `targetTuple` is null here and reading it would render
  // an empty chip.
  const identity = fallbackTupleIdentity(pending.failedTuple, labelFor);
  return (
    <div className="pointer-events-none px-4">
      <div className="pointer-events-auto mx-auto w-full max-w-3xl bg-canvas pt-2">
        <div
          role="status"
          data-testid="fallback-retry-row"
          className="mx-3 flex flex-wrap items-center gap-2 border-l-2 border-primary/60 py-1 pl-3 text-ui-xs text-muted-foreground"
        >
          <LivePulse
            size="xs"
            tone="active"
            ariaLabel="Retrying"
            className={undefined}
          />
          <span className="min-w-0">
            Retrying on {identity.providerLabel} · {identity.profileLabel}…
          </span>
          <span className="text-muted-foreground/70">
            attempt {pending.attempt} of {pending.maxAttempts}
          </span>
        </div>
      </div>
    </div>
  );
}
