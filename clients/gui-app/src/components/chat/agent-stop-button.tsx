import { useMemo } from "react";
import { Square } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { isUnknownHost } from "@/lib/host/constants";
import { agentMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

/**
 * Resolves the directory entry for `hostId`, referentially stable across
 * renders (`useHostClientFor` requires a stable target). `null` for a local /
 * unknown host (which routes through the global client instead) or a host
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
  readonly title: string | undefined;
  readonly onClick: (() => void) | undefined;
  readonly testId: string | undefined;
}) {
  return (
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
      title={props.iconOnly ? (props.title ?? props.label) : props.title}
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
      label={props.label}
      disabled={stop.isPending}
      pending={stop.isPending}
      iconOnly={props.iconOnly}
      title={undefined}
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
 * Stops an agent on its OWN host. Agents on the active host use the global
 * client (unchanged behaviour); agents on another reachable host use a
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
  const globalClient = useHostClient();
  const activeHostId = useReactiveActiveHostId();
  const local = isUnknownHost(props.hostId) || props.hostId === activeHostId;
  const reachability = useHostReachability(props.hostId);
  const entry = useStableHostEntry(local ? null : props.hostId);
  const transientClient = useHostClientFor(entry);
  const client = local ? globalClient : transientClient;
  const reachable = local || reachability.status === "reachable";

  if (!reachable || client === null) {
    return (
      <StopButtonShell
        label={props.label}
        disabled
        pending={false}
        iconOnly={props.iconOnly}
        title={
          reachability.status === "unreachable"
            ? `Runs on ${reachability.hostLabel}`
            : undefined
        }
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
