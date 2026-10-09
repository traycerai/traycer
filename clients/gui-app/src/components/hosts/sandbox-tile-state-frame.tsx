import type { ReactNode } from "react";
import { useIsMutating } from "@tanstack/react-query";
import type { SandboxLifecycleVerb } from "@traycer/protocol/host/sandbox-control";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  sandboxFrozenLine,
  sandboxTileOverlay,
  type SandboxTileOverlay,
} from "@/components/hosts/sandbox-card-model";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import { useHostBinding } from "@/lib/host";
import { sandboxMutationKeys } from "@/lib/query-keys";

/**
 * Wraps a tile's body. On a sandbox host that is frozen, asleep or waking,
 * the last screen stays in place, greyed and inert, under the state's copy:
 * the frozen line (with its destroy date when the server sends `frozenAt`),
 * "Suspended, resumes on your next action" with Resume, "Stopped" with Start,
 * or "Resuming" / "Starting" while it comes back.
 *
 * The greyed body is `inert` while an overlay shows: out of the tab order,
 * deaf to keystrokes (a terminal's textarea would otherwise take them and
 * swallow Tab before it reached Resume) and hidden from assistive tech, which
 * would read the tile as live. The `contents` wrapper is there on every
 * render of every tile, sandbox or not and overlay or not, so neither the
 * directory's first answer nor toggling `inert` ever remounts the body.
 *
 * Reads the tile's own host (`useTabHostId`). A personal host's tile is never
 * greyed. With no host runtime above the tile at all the children come back
 * unwrapped: there is no directory to read.
 */
export function SandboxTileStateFrame(props: {
  readonly children: ReactNode;
}): ReactNode {
  // A tile rendered with no host runtime above it (a shell mounted bare, a
  // tile under test) has no directory to read and no sandbox to frame.
  if (useHostBinding() === null) return props.children;
  return (
    <SandboxTileStateFrameInRuntime>
      {props.children}
    </SandboxTileStateFrameInRuntime>
  );
}

function SandboxTileStateFrameInRuntime(props: {
  readonly children: ReactNode;
}): ReactNode {
  const hostId = useTabHostId();
  const entry = useHostDirectoryEntry(hostId);
  const facts =
    entry !== null && isRemoteHostDirectoryEntry(entry) ? entry.sandbox : null;
  // The same two wrappers for every tile, from the first render: a restored
  // tile mounts before the directory answers, and wrapping its body only once
  // the entry says "sandbox" would move the body under new parents and
  // remount it (a browser guest reloads, a terminal session is torn down),
  // awake sandbox or not. Only the overlay and `inert` vary.
  const overlay =
    facts === null ? null : sandboxTileOverlay(facts.state, facts.frozen);
  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col"
      data-sandbox-tile-state={overlay === null ? "live" : overlay.kind}
    >
      <div className="contents" inert={overlay !== null}>
        {props.children}
      </div>
      {overlay === null ? null : (
        <SandboxTileOverlayLayer hostId={hostId} overlay={overlay} />
      )}
    </div>
  );
}

function SandboxTileOverlayLayer(props: {
  readonly hostId: string;
  readonly overlay: SandboxTileOverlay;
}): ReactNode {
  const list = useSandboxList();
  const summary =
    list.data?.sandboxes.find((s) => s.hostId === props.hostId) ?? null;
  // The tab-open wake (`useSandboxWakeForOpenedTile`) is already bringing it
  // up: say so, rather than offering a second Resume while the directory
  // still reads the state it had before the wake.
  const waking =
    useIsMutating({ mutationKey: sandboxMutationKeys.wake(props.hostId) }) > 0;
  const overlay: SandboxTileOverlay =
    waking && props.overlay.kind === "asleep"
      ? {
          kind: "moving",
          message: props.overlay.verb === "start" ? "Starting" : "Resuming",
        }
      : props.overlay;
  return (
    <div
      data-testid="sandbox-tile-overlay"
      data-kind={overlay.kind}
      className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 p-4 backdrop-grayscale"
    >
      <div
        role="status"
        className="flex max-w-sm flex-col items-center gap-2 text-center text-ui-sm"
      >
        {overlay.kind === "frozen" ? (
          <p className="font-medium text-warning-foreground">
            {sandboxFrozenLine(summary?.frozenAt ?? null)}
          </p>
        ) : null}
        {overlay.kind === "moving" ? (
          <p className="flex items-center gap-2 font-medium text-foreground">
            <AgentSpinningDots
              className={undefined}
              testId="sandbox-tile-overlay-spinner"
              variant={undefined}
            />
            {overlay.message}
          </p>
        ) : null}
        {overlay.kind === "asleep" ? (
          <>
            <p className="font-medium text-foreground">{overlay.message}</p>
            {summary !== null ? (
              <SandboxTileWakeButton
                sandboxId={summary.id}
                verb={overlay.verb}
                label={overlay.label}
              />
            ) : (
              <SandboxTileRowMissing />
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What the asleep overlay offers when the sandbox list has no row for it, so
 * there is no sandbox id to wake: why, when this build cannot reach the
 * control plane at all; a retry, when the first list read FAILED (which would
 * otherwise leave the overlay with no button and nothing to try); nothing
 * while the list is still being read.
 */
function SandboxTileRowMissing(): ReactNode {
  const list = useSandboxList();
  const unavailable = useSandboxControlUnavailableReason();
  if (unavailable !== null) {
    return (
      <p
        className="text-muted-foreground"
        data-testid="sandbox-tile-overlay-unavailable"
      >
        {unavailable}
      </p>
    );
  }
  if (list.data !== undefined || !list.isError) return null;
  return (
    <>
      <p className="text-muted-foreground">Couldn&apos;t load this sandbox.</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={list.isFetching}
        data-testid="sandbox-tile-overlay-retry-list"
        onClick={() => void list.refetch()}
      >
        {list.isFetching ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Try again
      </Button>
    </>
  );
}

function SandboxTileWakeButton(props: {
  readonly sandboxId: string;
  readonly verb: SandboxLifecycleVerb;
  readonly label: string;
}): ReactNode {
  const verb = useSandboxVerb(props.sandboxId);
  return (
    <Button
      type="button"
      size="sm"
      disabled={verb.isPending}
      data-testid="sandbox-tile-overlay-wake"
      onClick={() => verb.mutate(props.verb)}
    >
      {verb.isPending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      {props.label}
    </Button>
  );
}
