import { useMemo } from "react";
import { Square } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { isUnknownHost } from "@/lib/host/constants";
import { agentMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
/**
 * Resolves the directory entry for `hostId`, referentially stable across
 * renders (`useHostClientFor` requires a stable target). `null` for a local /
 * unknown host (which routes through the surrounding tile's client instead) or a host
 * absent from the directory.
 */
function useStableHostEntry(hostId: string | null): HostDirectoryEntry | null {
  const list = useHostDirectoryList();
  return useMemo(() => {
    if (hostId === null) return null;
    return list.data?.find((entry) => entry.hostId === hostId) ?? null;
  }, [hostId, list.data]);
}

function StopButtonShell(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly iconOnly: boolean;
  /** Hover label; `tooltip` rather than `title` so a call site cannot be read
   *  as the native attribute. */
  readonly tooltip: string | undefined;
  readonly onClick: (() => void) | undefined;
  readonly testId: string | undefined;
}) {
  return (
    <TooltipWrapper
      label={props.iconOnly ? (props.tooltip ?? props.label) : props.tooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          // NB: no `text-{color}` here. `cn`/tailwind-merge treats the custom
          // `text-ui-xs` font-size token (from `size="xs"`) as a text-color class,
          // so adding a real color class would win the conflict and silently drop
          // the font size - leaving the button at the inherited (larger) size. The
          // ghost variant already supplies the resting/hover colors, matching the
          // sibling "Undo all" button.
          className="shrink-0"
          disabled={props.disabled}
          onClick={props.onClick}
          aria-label={props.iconOnly ? props.label : undefined}
          data-testid={props.testId}
        >
          {props.pending ? (
            <AgentSpinningDots
              className="size-3"
              testId={undefined}
              variant={undefined}
            />
          ) : (
            <Square aria-hidden className="size-3" />
          )}
          {props.iconOnly ? null : props.label}
        </Button>
      </span>
    </TooltipWrapper>
  );
}

/** Renders the live button once we hold a client for a reachable host. */
function ReachableStopButton(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly epicId: string;
  readonly agentId: string;
  readonly label: string;
  readonly iconOnly: boolean;
  readonly testId: string | undefined;
}) {
  const stop = useHostMutation<HostRpcRegistry, "agent.stop">({
    client: props.client,
    method: "agent.stop",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: agentMutationKeys.stop(),
      onError: (error) => toastFromHostError(error, "Couldn't stop agent."),
    },
  });
  return (
    <StopButtonShell
      tooltip={undefined}
      label={props.label}
      disabled={stop.isPending}
      pending={stop.isPending}
      iconOnly={props.iconOnly}
      testId={props.testId}
      onClick={() =>
        stop.mutate({
          epicId: props.epicId,
          agentId: props.agentId,
          cascade: true,
        })
      }
    />
  );
}

/**
 * Stops an agent on its OWN host. Agents on the surrounding tile's host use
 * the tile client; agents on another reachable host use a
 * transient client dialed to it; agents on an unreachable host render a
 * disabled button ("Runs on <device>") - visible but not actionable. The stop's
 * effect surfaces via the cross-host awareness working set, so no query
 * invalidation is needed.
 */
export function AgentStopButton(props: {
  readonly epicId: string;
  readonly agentId: string;
  readonly hostId: string;
  readonly label: string;
  readonly iconOnly: boolean;
  readonly testId: string | undefined;
}) {
  const tabHostId = useTabHostId();
  const tabHostClient = useTabHostClient();
  const local = isUnknownHost(props.hostId) || props.hostId === tabHostId;
  const reachability = useHostReachability(props.hostId);
  const entry = useStableHostEntry(local ? null : props.hostId);
  const transientClient = useHostClientFor(entry);
  const client = local ? tabHostClient : transientClient;
  const reachable = local || reachability.status === "reachable";

  if (!reachable || client === null) {
    return (
      <StopButtonShell
        tooltip={
          reachability.status === "unreachable"
            ? `Runs on ${reachability.hostLabel}`
            : undefined
        }
        label={props.label}
        disabled
        pending={false}
        iconOnly={props.iconOnly}
        onClick={undefined}
        testId={props.testId}
      />
    );
  }
  return (
    <ReachableStopButton
      client={client}
      epicId={props.epicId}
      agentId={props.agentId}
      label={props.label}
      iconOnly={props.iconOnly}
      testId={props.testId}
    />
  );
}
