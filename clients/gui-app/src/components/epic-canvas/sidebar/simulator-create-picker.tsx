import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Smartphone } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  SimulatorHostInstance,
  SimulatorListResponse,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import { SimulatorAgentBadge } from "@/components/simulator-tile/simulator-agent-badge";
import { pickableHostOptions } from "@/components/settings/host-scope/host-option-model";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useServingLocalHostId } from "@/hooks/browser/use-browser-open-host";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import {
  useSurfaceHostPin,
  useTabSurfaceKey,
} from "@/hooks/host/use-surface-host-pin";
import {
  useSimulatorConfigSetMutation,
  useSimulatorInstancesQuery,
  useSimulatorListQuery,
  useSimulatorStatusQuery,
} from "@/hooks/simulator/use-simulator-mutations";
import {
  useSimulatorInstanceOpen,
  type SimulatorOpenTarget,
} from "@/hooks/simulator/use-simulator-instance-open";
import type { HostRpcRegistry } from "@/lib/host";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { simulatorVerbsAreV11 } from "@/lib/simulator-view/simulator-host-version";
import { simulatorVersionLabel } from "@/lib/simulator-view/simulator-labels";
import { suggestedSimulatorHostId } from "@/lib/simulator-view/suggested-simulator-host";
import type { SimulatorTileRef } from "@/stores/epics/canvas/types";
import { isBrowserDeviceOffline } from "./browser-device-availability";
import { useSimulatorPanelAvailability } from "./use-simulator-panel-availability";

/**
 * One instance the picker's Running section lists: from `simulator.instances`
 * on a `@1.1` host, or a booted device from `simulator.list` on a `@1.0`
 * host, which has no instances and no clones.
 */
interface PickerRunningRow {
  readonly instanceKey: string;
  readonly target: SimulatorOpenTarget;
  readonly drivenByAgent: boolean;
  readonly cloneOfName: string | null;
}

function runningRowFromInstance(
  instance: SimulatorHostInstance,
): PickerRunningRow {
  return {
    instanceKey: instance.instanceKey,
    target: {
      simulatorId: instance.simulatorId,
      platform: instance.platform,
      name: instance.name,
      version: instance.version,
    },
    drivenByAgent: instance.drivenByAgent,
    cloneOfName: instance.cloneOfName,
  };
}

function runningRowFromSummary(summary: SimulatorSummary): PickerRunningRow {
  return {
    instanceKey: summary.simulatorId,
    target: {
      simulatorId: summary.simulatorId,
      platform: summary.platform,
      name: summary.name,
      version: summary.version,
    },
    drivenByAgent: false,
    cloneOfName: null,
  };
}

function matchesQuery(target: SimulatorOpenTarget, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return `${target.name} ${simulatorVersionLabel(target)}`
    .toLowerCase()
    .includes(needle);
}

/**
 * The Mobile simulators panel's +: one popover, opened on the suggested
 * machine (this one when it can run simulators, else the task's), with a
 * search field and a machine switch in its top row. Running lists the
 * machine's instances with Watch and Boot another; Not running lists its cold
 * devices with Boot.
 */
export function SimulatorCreatePicker(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly onOpened: (() => void) | null;
  readonly testId: string;
}) {
  const placement = useColumnOverlayPlacement("row");
  const [open, setOpen] = useState(false);
  const { onOpened } = props;
  const onPicked = useCallback(() => {
    setOpen(false);
    onOpened?.();
  }, [onOpened]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="muted"
          size="icon-sm"
          aria-label="Add simulator"
          data-testid={props.testId}
        >
          <Plus className="size-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        layout="bare"
        side={placement?.side}
        align={placement?.align ?? "end"}
        className="w-[min(90vw,26rem)]"
        data-testid="simulator-create-picker"
      >
        {open ? (
          <SimulatorCreatePickerBody
            epicId={props.epicId}
            tabId={props.tabId}
            onPicked={onPicked}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** The machine the picker opens on; never the Browsers pin. */
function useSuggestedSimulatorHostId(tabId: string): string | null {
  const servingLocalHostId = useServingLocalHostId();
  const { localHostRunsSimulators } = useSimulatorPanelAvailability();
  const taskHost = useSurfaceHostPin(useTabSurfaceKey("browsers", tabId));
  return suggestedSimulatorHostId({
    servingLocalHostId,
    localHostRunsSimulators,
    taskHostId: taskHost.followingHostId,
  });
}

/**
 * Keeps the picker's devices with the host's pack. `simulator.list` carries
 * both the pack state the footer reads and the devices the tools enumerate,
 * but it neither polls nor moves on its own, so a Turn on - which installs
 * the tools before anything can be listed - would otherwise leave the picker
 * on its off state until it was closed and reopened. `simulator.status` is
 * what the rest of the app watches through that install (its row polls while
 * the pack is installing), so the list is asked again whenever that pack
 * state moves.
 */
function useSimulatorListFollowsPack(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): void {
  const status = useSimulatorStatusQuery(client, hostId);
  const packKind = status.data?.packState.kind ?? null;
  const queryClient = useQueryClient();
  const seen = useRef<{ hostId: string; packKind: string } | null>(null);
  useEffect(() => {
    if (hostId === null || packKind === null) return;
    const previous = seen.current;
    seen.current = { hostId, packKind };
    // The first read of a host says nothing: the list was fetched with it.
    if (
      previous === null ||
      previous.hostId !== hostId ||
      previous.packKind === packKind
    )
      return;
    void queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(hostId, "simulator.list"),
    });
  }, [hostId, packKind, queryClient]);
}

export function SimulatorCreatePickerBody(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly onPicked: () => void;
}) {
  const { epicId, tabId, onPicked } = props;
  const options = useHostOptions();
  const suggestedHostId = useSuggestedSimulatorHostId(tabId);
  const [chosenHostId, setChosenHostId] = useState<string | null>(null);
  const hostId = chosenHostId ?? suggestedHostId;
  const [query, setQuery] = useState("");
  const hosts = useMemo(
    () =>
      pickableHostOptions(options.hosts, hostId).filter(
        (host) => host.health.state !== "removed",
      ),
    [hostId, options.hosts],
  );
  const host = hosts.find((item) => item.hostId === hostId) ?? null;
  const hostName = host?.name ?? "this machine";
  const client = useHostClientForHostId(hostId);
  const v11 = simulatorVerbsAreV11(
    useHostNegotiatedMethodVersion(client, "simulator.open"),
  );
  const listSupport = useHostMethodSupport(hostId, "simulator.list");
  const list = useSimulatorListQuery(client, hostId, epicId);
  useSimulatorListFollowsPack(client, hostId);
  const instances = useSimulatorInstancesQuery(client, hostId, true);
  const { open } = useSimulatorInstanceOpen(epicId);
  const { openTile } = useEpicTileNavigation();
  const place = useCallback(
    (ref: SimulatorTileRef) => {
      openTile(tileIntent(ref, { tabId }, "explicit", "direct_ui"));
    },
    [openTile, tabId],
  );
  const pick = useCallback(
    (target: SimulatorOpenTarget, instance: PickInstance) => {
      if (hostId === null) return;
      open({
        hostId,
        target,
        instance: typeof instance === "string" ? instance : instance.key,
        place,
      });
      onPicked();
    },
    [hostId, onPicked, open, place],
  );

  const state = list.data ?? null;
  const offline = isBrowserDeviceOffline(host ?? undefined);
  const note = pickerNote({
    hostId,
    hostName,
    offline,
    listSupport,
    unreachable: list.isError,
    noPlatform:
      state !== null &&
      state.platforms.every((platform) => !platform.available),
  });

  return (
    <div className="flex max-h-[min(70vh,32rem)] min-h-0 flex-col">
      <PickerTopRow
        query={query}
        onQueryChange={setQuery}
        hostId={hostId}
        hosts={hosts}
        onHostChange={setChosenHostId}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        <PickerContent
          note={note}
          state={state}
          instances={v11 === true ? (instances.data?.instances ?? []) : null}
          query={query}
          onPick={pick}
        />
      </div>
      {state === null ? null : (
        <BootAnotherNote v11={v11} hostName={hostName} />
      )}
      {state?.packState.kind === "off" && hostId !== null ? (
        <SimulatorsOffFooter hostId={hostId} hostName={hostName} />
      ) : null}
    </div>
  );
}

/**
 * Why Boot another is unavailable. It is refused whenever the version is not
 * known to be `@1.1`, so both of those states say so: an old machine cannot
 * boot a copy at all, and one still being asked may yet be able to.
 */
function BootAnotherNote(props: {
  readonly v11: boolean | null;
  readonly hostName: string;
}) {
  if (props.v11 === true) return null;
  return (
    <p className="border-t border-border px-3 py-2 text-ui-xs text-muted-foreground">
      {props.v11 === false
        ? `${props.hostName} needs an update before it can boot another copy.`
        : `Asking ${props.hostName} about mobile simulators.`}
    </p>
  );
}

function PickerTopRow(props: {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly hostId: string | null;
  readonly hosts: readonly HostScopeOption[];
  readonly onHostChange: (hostId: string) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-border p-2">
      <Input
        size="sm"
        className="min-w-0 flex-1"
        placeholder="Search devices"
        aria-label="Search devices"
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
        data-testid="simulator-create-picker-search"
      />
      <Select
        value={props.hostId ?? undefined}
        onValueChange={props.onHostChange}
      >
        <SelectTrigger
          size="sm"
          className="min-w-0 max-w-1/2"
          aria-label="Machine"
          data-testid="simulator-create-picker-machine"
        >
          <SelectValue placeholder="Machine" />
        </SelectTrigger>
        <SelectContent>
          {props.hosts.map((item) => (
            <SelectItem
              key={item.hostId}
              value={item.hostId}
              disabled={isBrowserDeviceOffline(item)}
            >
              {item.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The sentence that replaces the two sections, or null to draw them.
 *
 * `listSupport` is the manifest's three states, and only the middle one is a
 * fact about the machine's age: `null` is "not addressed yet", which the read
 * itself resolves, so it draws the loading state and never the update line.
 * A machine that cannot be reached says so instead of spinning.
 */
function pickerNote(args: {
  readonly hostId: string | null;
  readonly hostName: string;
  readonly offline: boolean;
  readonly listSupport: boolean | null;
  readonly unreachable: boolean;
  readonly noPlatform: boolean;
}): string | null {
  if (args.hostId === null) return "No machine to run simulators on.";
  if (args.offline) return `${args.hostName} is offline.`;
  if (args.listSupport === false)
    return `${args.hostName} needs an update before it can run simulators.`;
  if (args.unreachable) return `Couldn't reach ${args.hostName}.`;
  if (args.noPlatform) return `${args.hostName} can't run simulators.`;
  return null;
}

type PickInstance = "auto" | "new" | { readonly key: string };

/**
 * The two sections. `instances` is the `@1.1` host's `simulator.instances`;
 * null on a `@1.0` host, whose booted devices stand in for its instances.
 */
function PickerContent(props: {
  readonly note: string | null;
  readonly state: SimulatorListResponse | null;
  readonly instances: readonly SimulatorHostInstance[] | null;
  readonly query: string;
  readonly onPick: (
    target: SimulatorOpenTarget,
    instance: PickInstance,
  ) => void;
}) {
  const { note, state, instances, query, onPick } = props;
  if (note !== null)
    return <p className="px-2 py-3 text-ui-xs text-muted-foreground">{note}</p>;
  if (state === null)
    return (
      <div
        role="status"
        className="flex items-center gap-2 px-2 py-3 text-ui-xs text-muted-foreground"
      >
        <AgentSpinningDots
          className="shrink-0"
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
        Loading devices…
      </div>
    );
  const running: readonly PickerRunningRow[] =
    instances === null
      ? state.simulators
          .filter((simulator) => simulator.booted)
          .map(runningRowFromSummary)
      : instances.map(runningRowFromInstance);
  const runningMatches = running.filter((row) =>
    matchesQuery(row.target, query),
  );
  const coldMatches = state.simulators.filter(
    (simulator) =>
      !simulator.booted &&
      !simulator.physical &&
      matchesQuery(simulator, query),
  );
  return (
    <>
      <PickerSection title="Running">
        {runningMatches.length === 0 ? (
          <PickerEmpty text="Nothing running." />
        ) : (
          runningMatches.map((row) => (
            <PickerRunningItem
              key={row.instanceKey}
              row={row}
              bootAnotherRefused={instances === null}
              onWatch={() => onPick(row.target, { key: row.instanceKey })}
              onBootAnother={() => onPick(row.target, "new")}
            />
          ))
        )}
      </PickerSection>
      <PickerSection title="Not running">
        {coldMatches.length === 0 ? (
          <PickerEmpty text="No other devices." />
        ) : (
          coldMatches.map((simulator) => (
            <PickerRow
              key={simulator.simulatorId}
              name={simulator.name}
              detail={simulatorVersionLabel(simulator)}
              badge={null}
              testId={`simulator-picker-cold-${simulator.simulatorId}`}
            >
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => onPick(simulator, "auto")}
              >
                Boot
              </Button>
            </PickerRow>
          ))
        )}
      </PickerSection>
    </>
  );
}

function PickerSection(props: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={props.title} className="pb-1">
      <h3 className="px-2 pt-2 pb-1 text-overline text-muted-foreground">
        {props.title}
      </h3>
      <ul className="space-y-0.5">{props.children}</ul>
    </section>
  );
}

function PickerEmpty(props: { readonly text: string }) {
  return (
    <li className="px-2 py-1 text-ui-xs text-muted-foreground">{props.text}</li>
  );
}

function PickerRow(props: {
  readonly name: string;
  readonly detail: string;
  readonly badge: ReactNode;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <li
      className="flex min-h-8 min-w-0 items-center gap-2 rounded-md px-2 py-1 text-ui-sm hover:bg-foreground/5"
      data-testid={props.testId}
    >
      <Smartphone className="size-4 shrink-0" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{props.name}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground">
          <span className="truncate">{props.detail}</span>
          {props.badge}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">{props.children}</span>
    </li>
  );
}

function PickerRunningItem(props: {
  readonly row: PickerRunningRow;
  /** A `@1.0` host ignores `instance` and would share the device. */
  readonly bootAnotherRefused: boolean;
  readonly onWatch: () => void;
  readonly onBootAnother: () => void;
}) {
  const { row } = props;
  const detail =
    row.cloneOfName === null
      ? simulatorVersionLabel(row.target)
      : `Copy of ${row.cloneOfName} · ${simulatorVersionLabel(row.target)}`;
  return (
    <PickerRow
      name={row.target.name}
      detail={detail}
      badge={row.drivenByAgent ? <SimulatorAgentBadge /> : null}
      testId={`simulator-picker-running-${row.instanceKey}`}
    >
      <Button type="button" variant="outline" size="xs" onClick={props.onWatch}>
        {row.drivenByAgent ? "Watch" : "Open"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={props.bootAnotherRefused}
        onClick={props.onBootAnother}
      >
        Boot another
      </Button>
    </PickerRow>
  );
}

function SimulatorsOffFooter(props: {
  readonly hostId: string;
  readonly hostName: string;
}) {
  const client = useHostClientForHostId(props.hostId);
  const { mutation, supported } = useSimulatorConfigSetMutation(
    client,
    props.hostId,
  );
  const { mutate, isPending } = mutation;
  return (
    <div className="flex min-w-0 items-center gap-2 border-t border-border px-3 py-2 text-ui-xs text-muted-foreground">
      <span className="min-w-0 flex-1">
        Simulators on {props.hostName} are off.
      </span>
      {supported ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={isPending}
          data-testid="simulator-create-picker-turn-on"
          onClick={() => mutate({ enabled: true })}
        >
          {isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : null}
          Turn on
        </Button>
      ) : null}
    </div>
  );
}
