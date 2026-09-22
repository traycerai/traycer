import { useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type {
  HeldPortForwardLease,
  OwnedPortForward,
} from "@traycer/protocol/host/port-forward";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { SettingsGroup } from "@/components/settings/settings-group";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { HostOverviewNotice } from "@/components/settings/panels/host-overview-status-card";
import { formatByteSize } from "@/lib/format-byte-size";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { usePortForwardListFor } from "@/hooks/port-forward/use-port-forward-list-for-query";
import {
  usePortForwardCutLeaseFor,
  usePortForwardStopFor,
} from "@/hooks/port-forward/use-port-forward-mutations";

function connectionsLabel(open: number): string {
  return open === 1 ? "1 open connection" : `${open} open connections`;
}

/**
 * A host's two port-forward tables, shown as they are: the forwards its agents
 * OWN, and the ports other machines HOLD on it.
 *
 * It exists for the second table. A forward's owner sees it in the agent's
 * chat; the machine on the other end - the one whose port is being listened on
 * or reached - has no chat for it and no other place to find out. This is that
 * place, and Cut is that machine's one control.
 *
 * It renders nothing at all on a host that does not serve
 * `portForward.listForHost` (the method is optional, so an older host
 * negotiates it away), while the host is not usable, and while there is
 * nothing in either table - an empty card on every host's page would be a
 * feature announcing itself to people who never asked for it.
 *
 * It does not poll; see {@link usePortForwardListFor}. The counters are as of
 * the last read, which is why Refresh is on the card.
 */
export function HostPortForwardsCard(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
  /**
   * The scope's hosts, which is where the other end of a forward gets its
   * name. Taken from the panel rather than read here: a Settings panel depends
   * on its scope, not on the data sources the scope composes.
   */
  readonly hosts: readonly HostScopeOption[];
  readonly usable: boolean;
}): ReactNode {
  const supported = useHostSupportsMethod(
    props.hostId,
    "portForward.listForHost",
  );
  const enabled = props.usable && supported;
  const list = usePortForwardListFor(props.client, enabled);
  const stop = usePortForwardStopFor(props.client);
  const cut = usePortForwardCutLeaseFor(props.client);
  const [cutting, setCutting] = useState<HeldPortForwardLease | null>(null);
  const machine = (hostId: string): string => {
    if (hostId === props.hostId) return props.hostName;
    return (
      props.hosts.find((host) => host.hostId === hostId)?.name ??
      "another machine"
    );
  };

  const stoppingForwardId = stop.isPending ? stop.variables.forwardId : null;

  if (!enabled) return null;
  const owned = list.data?.owned ?? [];
  const held = list.data?.held ?? [];
  if (list.data !== undefined && owned.length === 0 && held.length === 0) {
    return null;
  }
  // A first read that failed has nothing to show and nothing to hide behind:
  // say so rather than rendering an empty card or no card.
  if (list.data === undefined && !list.isError) return null;

  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.portForwards}
      showTitle
      tone="default"
      dataTestId="host-port-forwards"
      fill={false}
    >
      {list.data === undefined ? (
        <HostOverviewNotice testId="host-port-forwards-unreadable">
          {`Couldn't read ${props.hostName}'s port forwards.`}
        </HostOverviewNotice>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border/50 p-0">
          {owned.map((forward) => (
            <OwnedForwardRow
              key={forward.forwardId}
              forward={forward}
              machine={machine}
              pending={stoppingForwardId === forward.forwardId}
              disabled={stop.isPending}
              onStop={() => {
                stop.mutate({ forwardId: forward.forwardId });
              }}
            />
          ))}
          {held.map((lease) => (
            <HeldLeaseRow
              key={lease.leaseId}
              lease={lease}
              machine={machine}
              disabled={cut.isPending}
              onCut={() => {
                setCutting(lease);
              }}
            />
          ))}
        </ul>
      )}
      <RefreshFooter
        fetching={list.isFetching}
        onRefresh={() => {
          void list.refetch();
        }}
      />
      <CutLeaseDialog
        lease={cutting}
        machine={machine}
        hostName={props.hostName}
        pending={cut.isPending}
        onClose={() => {
          setCutting(null);
        }}
        onConfirm={(lease) => {
          cut.mutate(
            { leaseId: lease.leaseId },
            {
              onSettled: () => {
                setCutting(null);
              },
            },
          );
        }}
      />
    </SettingsGroup>
  );
}

function RefreshFooter(props: {
  readonly fetching: boolean;
  readonly onRefresh: () => void;
}): ReactNode {
  return (
    <div className="flex items-center justify-end border-t border-border/50 px-3 py-1.5">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={props.fetching}
        data-testid="host-port-forwards-refresh"
        onClick={props.onRefresh}
      >
        {props.fetching ? (
          <AgentSpinningDots
            className={undefined}
            testId="host-port-forwards-refresh-spinner"
            variant={undefined}
          />
        ) : (
          <RefreshCw aria-hidden className="size-3" />
        )}
        Refresh
      </Button>
    </div>
  );
}

/**
 * Cut is confirmed because it lands on someone else: the forward belongs to an
 * agent on another machine, and this ends it there with nothing to bring it
 * back. The dialog says whose it is and what happens to it.
 */
function CutLeaseDialog(props: {
  readonly lease: HeldPortForwardLease | null;
  readonly machine: (hostId: string) => string;
  readonly hostName: string;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (lease: HeldPortForwardLease) => void;
}): ReactNode {
  const { lease } = props;
  const owner = lease === null ? "" : props.machine(lease.ownerHostId);
  return (
    <ConfirmDestructiveDialog
      blockedReason={null}
      open={lease !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={lease === null ? "Cut this port?" : `Cut port ${lease.port}?`}
      description={
        lease === null
          ? ""
          : `${owner} is using port ${lease.port} on ${props.hostName} for "${lease.description}". Cutting closes it here and its open connections; the forward on ${owner} is interrupted and its agent is told. It does not come back on its own.`
      }
      cascadeSummary={null}
      actionLabel="Cut"
      isPending={props.pending}
      onConfirm={() => {
        if (lease !== null) props.onConfirm(lease);
      }}
    />
  );
}

type OwnedForwardPresentation = {
  readonly stateLabel: string;
  readonly stateVariant: "success" | "warning" | "info" | "muted";
  /** The port badge. A listener that is not bound yet is not offered as one. */
  readonly portLabel: string;
  readonly detail: string;
  readonly action: "Stop" | "Clear";
};

/**
 * All four owned states, each spelled out. The listing carries the full
 * record, unlike the chat row, so a forward still binding or already stopped
 * can appear here, and neither is "forwarding": a binding forward has asked
 * for a port and holds nothing yet, so its requested port is shown as a
 * request, not as somewhere to point a browser; a stopped one is a record
 * waiting for its release to be answered, with nothing to stop.
 */
function presentOwnedForward(
  forward: OwnedPortForward,
  machine: (hostId: string) => string,
): OwnedForwardPresentation {
  const route = `${machine(forward.listen.hostId)}:${forward.listen.boundPort ?? forward.listen.requestedPort} → ${machine(forward.target.hostId)}:${forward.target.port}`;
  switch (forward.state) {
    case "active":
      return {
        stateLabel: "Forwarding",
        stateVariant: "success",
        portLabel: `:${forward.listen.boundPort ?? forward.listen.requestedPort}`,
        detail: `${route} · ${connectionsLabel(forward.counters.openConnections)} · ${formatByteSize(forward.counters.bytesIn)} in · ${formatByteSize(forward.counters.bytesOut)} out`,
        action: "Stop",
      };
    case "interrupted":
      return {
        stateLabel: "Interrupted",
        stateVariant: "warning",
        portLabel: `:${forward.listen.boundPort ?? forward.listen.requestedPort}`,
        detail: `${route} · ${forward.stateReason ?? "interrupted"}`,
        action: "Clear",
      };
    case "binding":
      return {
        stateLabel: "Binding",
        stateVariant: "info",
        portLabel: `requested :${forward.listen.requestedPort}`,
        detail: `Asking ${machine(forward.listen.hostId)} for port ${forward.listen.requestedPort} to reach ${machine(forward.target.hostId)}:${forward.target.port}. Nothing is listening yet.`,
        action: "Stop",
      };
    case "stopped":
      return {
        stateLabel: "Stopped",
        stateVariant: "muted",
        portLabel: `:${forward.listen.boundPort ?? forward.listen.requestedPort}`,
        detail: `${route} · ${forward.stateReason ?? "stopped"}`,
        action: "Clear",
      };
  }
  const unreachableState: never = forward.state;
  return unreachableState;
}

function OwnedForwardRow(props: {
  readonly forward: OwnedPortForward;
  readonly machine: (hostId: string) => string;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onStop: () => void;
}): ReactNode {
  const { forward } = props;
  const shown = presentOwnedForward(forward, props.machine);
  return (
    <li
      className="flex min-w-0 items-center gap-3 px-3 py-2"
      data-testid={`host-port-forward-owned-${forward.forwardId}`}
      data-state={forward.state}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-ui-sm text-foreground">
            {forward.description}
          </span>
          <Badge variant="muted" size="xs">
            {shown.portLabel}
          </Badge>
          <Badge variant={shown.stateVariant} size="xs">
            {shown.stateLabel}
          </Badge>
        </div>
        <span className="min-w-0 break-words text-ui-xs text-muted-foreground">
          {shown.detail}
        </span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="shrink-0"
        disabled={props.disabled}
        data-testid={`host-port-forward-stop-${forward.forwardId}`}
        onClick={props.onStop}
      >
        {props.pending ? (
          <AgentSpinningDots
            className={undefined}
            testId={`host-port-forward-stop-spinner-${forward.forwardId}`}
            variant={undefined}
          />
        ) : null}
        {shown.action}
      </Button>
    </li>
  );
}

function HeldLeaseRow(props: {
  readonly lease: HeldPortForwardLease;
  readonly machine: (hostId: string) => string;
  readonly disabled: boolean;
  readonly onCut: () => void;
}): ReactNode {
  const { lease, machine } = props;
  return (
    <li
      className="flex min-w-0 items-center gap-3 px-3 py-2"
      data-testid={`host-port-forward-held-${lease.leaseId}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-ui-sm text-foreground">
            {lease.description}
          </span>
          <Badge variant="muted" size="xs">
            :{lease.port}
          </Badge>
          <Badge variant="info" size="xs">
            {lease.role === "listen" ? "Listening for" : "Reached by"}{" "}
            {machine(lease.ownerHostId)}
          </Badge>
        </div>
        <span className="min-w-0 break-words text-ui-xs text-muted-foreground">
          {lease.role === "listen"
            ? `This port is open here and carries traffic to ${machine(lease.ownerHostId)}.`
            : `${machine(lease.ownerHostId)} reaches this port through a forward.`}
          {" · "}
          {connectionsLabel(lease.openConnections)}
        </span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="shrink-0"
        disabled={props.disabled}
        data-testid={`host-port-forward-cut-${lease.leaseId}`}
        onClick={props.onCut}
      >
        Cut
      </Button>
    </li>
  );
}
