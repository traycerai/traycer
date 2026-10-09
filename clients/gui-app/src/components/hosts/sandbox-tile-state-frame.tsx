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
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
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
 * render of a sandbox tile, overlay or not, so toggling `inert` never
 * remounts the body.
 *
 * Reads the tile's own host (`useTabHostId`). A personal host's tile gets its
 * children back unwrapped, so nothing changes for it. A sandbox tile is
 * wrapped from the moment the directory says it is one (the kind is fixed for
 * a host's life, so this happens once, at the first directory answer).
 */
export function SandboxTileStateFrame(props: {
  readonly children: ReactNode;
}): ReactNode {
  const hostId = useTabHostId();
  const entry = useHostDirectoryEntry(hostId);
  const facts =
    entry !== null && isRemoteHostDirectoryEntry(entry) ? entry.sandbox : null;
  if (facts === null) return props.children;
  const overlay = sandboxTileOverlay(facts.state, facts.frozen);
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
  // Resume needs the sandbox's row. A first list read that FAILED would
  // otherwise leave the overlay with no button and nothing to try.
  const listUnread = list.data === undefined && list.isError;
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
            ) : null}
            {summary === null && listUnread ? (
              <>
                <p className="text-muted-foreground">
                  Couldn&apos;t load this sandbox.
                </p>
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
            ) : null}
          </>
        ) : null}
      </div>
    </div>
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
