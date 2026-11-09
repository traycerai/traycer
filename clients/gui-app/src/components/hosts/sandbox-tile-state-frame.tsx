import type { ReactNode } from "react";
import {
  hostSandboxStateWord,
  type HostSandboxState,
} from "@traycer/protocol/host/host-status";
import { cn } from "@/lib/utils";
import { useIsMutatingOf } from "@/hooks/use-mutation-state-of";
import { SandboxOperationFailure } from "@/components/hosts/sandbox-operation-failure";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { SandboxLifecycleVerb } from "@traycer/protocol/host/sandbox-control";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  sandboxFrozenLine,
  sandboxTeamFrozenLine,
  sandboxTileOverlay,
  type SandboxTileOverlay,
} from "@/components/hosts/sandbox-card-model";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import { useSandboxOperation } from "@/hooks/sandboxes/use-sandbox-operation";
import { useHostBinding } from "@/lib/host";
import { sandboxMutationKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { sandboxFrozenClock } from "@/lib/sandboxes/sandbox-row-lines";
import { TeamHostDisclosure } from "@/components/hosts/team-host-disclosure";

/**
 * Wraps a tile's body and carries its team-host disclosure. On a sandbox host
 * that is frozen, asleep or waking, a non-chat tile's body stays mounted,
 * hidden and inert, while the overlay owns its status and actions:
 * the state beside Out of credits (with its removal date when known),
 * "Suspended, resumes on your next action" with Resume, "Stopped" with Start,
 * or "Resuming" / "Starting" while it comes back.
 *
 * The hidden body is `inert` while an overlay shows: out of the tab order,
 * deaf to keystrokes (a terminal's textarea would otherwise take them and
 * swallow Tab before it reached Resume) and hidden from assistive tech, which
 * would read the tile as live. The `contents` wrapper is there on every
 * render of every tile, sandbox or not and overlay or not, so neither the
 * directory's first answer nor toggling `inert` ever remounts the body.
 *
 * Reads the tile's own host (`useTabHostId`). Live chats own their lifecycle
 * surfaces and stay interactive; their team disclosure still mounts here.
 * A computer host's tile is never hidden. With no host runtime above the tile
 * at all the children come back unwrapped: there is no directory to read.
 */
export function SandboxTileStateFrame(props: {
  /** The chat a chat tile shows; null for every other tile. */
  readonly chat: { readonly epicId: string; readonly chatId: string } | null;
  readonly children: ReactNode;
}): ReactNode {
  // A tile rendered with no host runtime above it (a shell mounted bare, a
  // tile under test) has no directory to read and no sandbox to frame.
  if (useHostBinding() === null) return props.children;
  return (
    <SandboxTileStateFrameInRuntime chat={props.chat}>
      {props.children}
    </SandboxTileStateFrameInRuntime>
  );
}

function SandboxTileStateFrameInRuntime(props: {
  readonly chat: { readonly epicId: string; readonly chatId: string } | null;
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
  const waking =
    useIsMutatingOf({ mutationKey: sandboxMutationKeys.wake(hostId) }) > 0;
  const stateOverlay =
    props.chat !== null || facts === null
      ? null
      : sandboxTileOverlay(facts.state, facts.frozen);
  const overlay = wakingOverlay(stateOverlay, waking);
  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col"
      data-sandbox-tile-state={overlay === null ? "live" : overlay.kind}
    >
      <div
        className={cn("contents", overlay !== null && "invisible")}
        inert={overlay !== null}
        aria-hidden={overlay !== null ? true : undefined}
      >
        {props.children}
      </div>
      {facts === null ||
      facts.ownerTeamId === null ||
      facts.ownerTeamName === null ? null : (
        <TeamHostDisclosure
          hostId={hostId}
          teamId={facts.ownerTeamId}
          teamName={facts.ownerTeamName}
        />
      )}
      {overlay === null ? null : (
        <SandboxTileOverlayLayer
          hostId={hostId}
          overlay={overlay}
          state={facts?.state ?? null}
          teamOwned={facts !== null && facts.ownerTeamName !== null}
        />
      )}
    </div>
  );
}

/** A tab-open wake takes precedence over the directory's resting state. */
function wakingOverlay(
  overlay: SandboxTileOverlay | null,
  waking: boolean,
): SandboxTileOverlay | null {
  if (!waking || overlay?.kind !== "asleep") return overlay;
  return {
    kind: "moving",
    message: overlay.verb === "start" ? "Starting" : "Resuming",
  };
}

function SandboxTileOverlayLayer(props: {
  readonly hostId: string;
  readonly overlay: SandboxTileOverlay;
  readonly state: HostSandboxState | null;
  /** A team's frozen sandbox says whose bundle is out, not "your credits". */
  readonly teamOwned: boolean;
}): ReactNode {
  const list = useSandboxList();
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const summary =
    list.data?.sandboxes.find((s) => s.hostId === props.hostId) ?? null;
  const { overlay } = props;
  const frozenCause = tileFrozenCause(props.teamOwned, summary, viewerUserId);
  const removal =
    summary === null ? null : sandboxFrozenClock(summary.frozenAt);
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
          <>
            <p className="font-medium text-warning-foreground">
              {props.state === null
                ? ""
                : `${hostSandboxStateWord(props.state)} · `}
              {frozenCause}
            </p>
            {removal === null ? null : (
              <p className="text-muted-foreground">{removal}</p>
            )}
          </>
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
                summary={summary}
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

/** Personal rows use the frozen banner; a team row names whose bundle is out. */
function tileFrozenCause(
  teamOwned: boolean,
  summary: SandboxSummary | null,
  viewerUserId: string | null,
): string {
  if (!teamOwned) return sandboxFrozenLine(null);
  return sandboxTeamFrozenLine(summary, viewerUserId);
}

function SandboxTileWakeButton(props: {
  readonly summary: SandboxSummary;
  readonly verb: SandboxLifecycleVerb;
  readonly label: string;
}): ReactNode {
  const verb = useSandboxVerb(props.summary.id);
  const operation = useSandboxOperation(props.summary.id);
  const pending = operation?.kind === "pending";
  return (
    <>
      <Button
        type="button"
        size="sm"
        disabled={pending}
        data-testid="sandbox-tile-overlay-wake"
        onClick={() => verb.mutate(props.verb)}
      >
        {pending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        {props.label}
      </Button>
      <SandboxOperationFailure
        sandboxId={props.summary.id}
        hostId={props.summary.hostId}
        name={props.summary.displayName}
        operation={
          operation?.kind === "failed" && operation.verb !== "destroy"
            ? operation
            : null
        }
        busy={pending}
        onRetry={(pressed) => {
          if (pressed !== "destroy") verb.mutate(pressed);
        }}
      />
    </>
  );
}
