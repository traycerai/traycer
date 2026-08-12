import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";
import { RestartHostConfirmDialog } from "@/components/host/restart-host-confirm-dialog";
import { DoctorSheet } from "@/components/settings/panels/host-settings-doctor-sheet";
import { HostNameEditForm } from "@/components/settings/panels/host-settings-name-edit";
import {
  InstallationDetailsDisclosure,
  type InstallationDetailsRecord,
} from "@/components/settings/panels/host-settings-installation-details";
import {
  HostIdentityCard,
  HostIdRow,
  ThisWindowCard,
} from "@/components/settings/host-scope/host-identity-card";
import { HostDangerZone } from "@/components/settings/host-scope/host-danger-zone";
import { HostRegistryUpdates } from "@/components/settings/host-scope/host-registry-updates";
import { SettingsGroup } from "@/components/settings/settings-group";
import {
  HostOverviewActions,
  HostOverviewEndpointRow,
  HostOverviewNotice,
  HostOverviewUpdateProgress,
  HostRestartBusyNotice,
} from "@/components/settings/panels/host-overview-status-card";
import { HostOverviewUpdatesRegion } from "@/components/settings/panels/host-overview-updates";
import {
  customNameFromIdentityDraft,
  describeOverviewDegrade,
  overviewEndpointParts,
  overviewMethodDegrade,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import { persistedDraftFromIdentity } from "@/components/settings/panels/host-settings-panel-model";
import {
  managedInstallation,
  useHostIdentityQuery,
  useHostIdentitySet,
  useHostInstallationInfoQuery,
  useHostOverviewStatusQuery,
  useHostRestart,
} from "@/components/settings/panels/host-overview-rpc";
import { newTransitionId } from "@/components/settings/panels/host-overview-transition-id";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { cn } from "@/lib/utils";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { HostIdentity } from "@traycer/protocol/host/identity/index";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostStatusUpdateProgress } from "@traycer/protocol/host/status/index";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";

/**
 * ONE Overview, for every host.
 *
 * This page describes the SCOPED host by asking that host: `host.status` for
 * what it is running, `host.identity.get` for what it is called, and
 * `host.getInstallationInfo` for how it was installed. A machine on this desk
 * and a machine in a datacenter render the same components from the same
 * answers — that equivalence is the deliverable, not a side effect, and it is
 * what the fixture-parity test pins.
 *
 * What USED to be here was the local CLI bridge as primary source, which is why
 * a remote host got a thinner page describing it in a different dialect. The
 * bridge now serves exactly one surface, the recovery console, for the states
 * where no host process exists to answer.
 *
 * Every button degrades on its OWN capability. An old host can support
 * `host.status` and not `host.restart`; a current host on a box with no Traycer
 * CLI can restart but cannot run doctor or update itself. Collapsing those into
 * one page-level gate is how a capability downgrade during a fleet update turns
 * into "this page is broken".
 */
// The status card, the two cards under it and the two dialogs are each their
// own component; what is left here is the page's own state and the handful of
// conditions that decide which of its regions apply. That residue is
// irreducible branching over surfaced concerns rather than nesting, and the same
// disable sat on the page this replaced, for the same reason.
// eslint-disable-next-line complexity
export function HostOverviewPanel(props: {
  readonly scope: HostScope;
  /** This computer's live host process, when the scoped host IS this computer. */
  readonly localHost: LocalHostSnapshot | null;
  /** True when this shell has a CLI bridge for the local-only doctor repairs. */
  readonly hasLocalBridge: boolean;
  readonly onLocalDoctorFix: (issue: HostDoctorIssue) => void;
  readonly localDoctorFixPendingCode: string | null;
}): ReactNode {
  const { scope } = props;
  const compact = useSettingsDensity() === "compact";
  const host = scope.host;

  // The BINDING rather than `useHostClient()`: same context, re-provided by the
  // panel above for an explicit pick, but `null` instead of a throw when there
  // is no host runtime at all. Every read below is null-gated.
  const client = useHostBinding()?.hostClient ?? null;
  // MOUNTING, not rendering. A query hook mounted under a non-ready scope still
  // fires against the ambient host and caches the answer under this page's key,
  // however well a gate hides the result.
  const usable = isHostScopeUsable(scope.status) && client !== null;

  const [doctorOpen, setDoctorOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraftOverride, setNameDraftOverride] = useState<string | null>(
    null,
  );
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [restartBusyCount, setRestartBusyCount] = useState<number | null>(null);
  // The id of a restart whose DISPATCH OUTCOME IS UNKNOWN - the transport threw
  // after the host may already have granted the claim. `host.restart` is
  // claim-gated, so the retry has to carry that same id to adopt the claim it
  // may already hold; minting a fresh one turns the idempotent retry this
  // contract exists for into a busy refusal. Cleared on every DEFINITIVE
  // answer, so a genuinely new action never inherits a stale claim.
  const armedRestartIdRef = useRef<string | null>(null);
  const hostIdCopy = useClipboardCopy({
    resetMs: 1600,
    onSuccess: () => toast.success("Host ID copied"),
    onError: () => toast.error("Couldn't copy the host ID"),
  });

  const {
    identity: identityDegrade,
    identitySet: identitySetDegrade,
    restart: restartDegrade,
    doctor: doctorDegrade,
    installInfo: installInfoDegrade,
    updateCheck: updateCheckDegrade,
    updateInstall: updateInstallDegrade,
  } = useOverviewCapabilities(scope.hostId);

  const statusQuery = useHostOverviewStatusQuery({ client, enabled: usable });
  const identityQuery = useHostIdentityQuery({
    client,
    enabled: usable && identityDegrade === null,
  });
  const installationQuery = useHostInstallationInfoQuery({
    client,
    enabled: usable && installInfoDegrade === null,
  });

  const identitySet = useHostIdentitySet(client);
  const restart = useHostRestart(client);

  const view = useOverviewDisplay({
    scope,
    host,
    identity: identityQuery.data ?? null,
    status: statusQuery.data ?? null,
    localHost: props.localHost,
  });
  const { identity, displayName } = view;
  const nameDraft = nameDraftOverride ?? view.persistedNameDraft;

  // Focus restoration: "Edit name" unmounts while editing and comes back on
  // close, so the trigger is refocused on that true->false transition only —
  // never on mount, where it would steal focus from the page. Same pattern (and
  // the same `wasEditingRef`) the summary card uses for the same reason.
  const editNameRef = useRef<HTMLButtonElement>(null);
  const wasEditingRef = useRef(editingName);
  useEffect(() => {
    if (wasEditingRef.current && !editingName) {
      editNameRef.current?.focus();
    }
    wasEditingRef.current = editingName;
  }, [editingName]);

  // Save and Reset are the SAME write with a different argument — `null` clears
  // the override and falls the name back to the host's own default. Sharing the
  // handler is what keeps their success and failure behaviour identical; two
  // copies drifted the moment one of them grew a toast the other did not.
  const { mutate: mutateIdentity } = identitySet;
  const submitRename = (customName: string | null): void => {
    // Belt to the Save button's braces. The button is the UI guard against a
    // no-op write; this is the one that holds if a caller ever routes here
    // another way, because the write is not harmless: storing the current
    // effective name as an explicit `customName` FREEZES a registration label
    // that would otherwise keep tracking the host.
    if (customName === (identity?.customName ?? null)) {
      setNameDraftOverride(null);
      setEditingName(false);
      return;
    }
    mutateIdentity(
      { customName },
      {
        onSuccess: (next) => {
          setNameDraftOverride(null);
          setEditingName(false);
          toast.success(`Renamed to ${next.effectiveName}`);
        },
        onError: (error) =>
          toastFromHostError(error, "Couldn't rename this host."),
      },
    );
  };

  if (host === null) return null;

  const anyPending = restart.isPending || identitySet.isPending;
  const registryItem = host.item;

  return (
    <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
      <HostIdentityCard
        host={host}
        displayName={displayName}
        // Same two-layer rule as the name: the process's own answer when there
        // is a route, the registry copy when there is not.
        version={view.hostVersion ?? host.version}
        actions={
          // Withheld entirely when there is no route, rather than rendered and
          // disabled. Every one of these needs a live host to answer, so on an
          // unreachable host they would be dead controls under a card that
          // already says the host cannot be reached — and "disabled" would
          // wrongly imply a capability verdict rather than a connectivity one.
          // What survives an outage is the account-backed half below: the
          // update policy and the version pin, which need no route at all.
          !usable || editingName ? null : (
            <HostOverviewActions
              hostName={displayName}
              restartDegrade={restartDegrade}
              doctorDegrade={doctorDegrade}
              // The WRITE capability gates the rename controls, not the read.
              // "Edit name" and "Retry name" both lead to
              // `host.identity.set`, so a host that can be read but not
              // written must degrade them - otherwise Save calls a method the
              // handshake already declined.
              identityDegrade={identitySetDegrade ?? identityDegrade}
              restartPending={restart.isPending}
              anyPending={anyPending}
              // Opening a disabled editor is the other half of the same
              // focus-loss finding: block the TRIGGER while there is no name
              // data to edit, not just the input.
              identityLoaded={identity !== null}
              identityFailed={identity === null && identityQuery.isError}
              identityRetrying={identityQuery.isFetching}
              onRetryIdentity={() => {
                void identityQuery.refetch();
              }}
              editNameRef={editNameRef}
              onRestart={() => {
                setRestartBusyCount(null);
                setRestartConfirmOpen(true);
              }}
              onOpenDoctor={() => setDoctorOpen(true)}
              onEditName={() => setEditingName(true)}
            />
          )
        }
      >
        {view.updateProgress === null ? null : (
          <HostOverviewUpdateProgress
            state={view.updateProgress.state}
            error={view.updateProgress.error}
          />
        )}
        {restartBusyCount === null ? null : (
          <HostRestartBusyNotice
            busySessionCount={restartBusyCount}
            retryPending={restart.isPending}
            onRetry={() => {
              setRestartBusyCount(null);
              setRestartConfirmOpen(true);
            }}
            onDismiss={() => setRestartBusyCount(null)}
          />
        )}
        {editingName ? (
          <div className="border-t border-border/40 px-5 py-3">
            <HostNameEditForm
              settings={identity ?? undefined}
              pending={identityQuery.isPending}
              draftName={nameDraft}
              persistedDraft={view.persistedNameDraft}
              savePending={identitySet.isPending}
              toCustomName={customNameFromIdentityDraft}
              onDraftNameChange={setNameDraftOverride}
              onSave={() =>
                submitRename(customNameFromIdentityDraft(nameDraft))
              }
              onReset={() => submitRename(null)}
              onCancel={() => {
                setEditingName(false);
                setNameDraftOverride(null);
              }}
            />
          </div>
        ) : null}
        <HostOverviewEndpointRow parts={view.endpointParts} />
        <ThisWindowCard scope={scope} host={host} />
        <HostIdRow
          hostId={host.hostId}
          onCopy={(value) => hostIdCopy.copy(value)}
        />
      </HostIdentityCard>

      <HostOverviewUpdatesCard
        client={client}
        hostName={displayName}
        installedVersion={view.hostVersion}
        checkDegrade={updateCheckDegrade}
        installDegrade={updateInstallDegrade}
        busy={anyPending}
        usable={usable}
        registryItem={registryItem}
      />

      <HostOverviewInstallationCard
        usable={usable}
        hostName={displayName}
        degrade={installInfoDegrade}
        record={
          managedInstallation(installationQuery.data)?.installRecord ?? null
        }
        loading={installationQuery.isPending}
        readFailed={installationQuery.isError}
      />

      {/* No list of the OTHER hosts, and no "Add host": a page about one host
          is the wrong place to manage the collection it belongs to. The
          sidebar switcher owns both.

          Not gated from out here: the zone's rows sit on three different
          capability planes (host RPC, the local CLI bridge, an account write)
          and it gates each of them itself. A gate around all three took the
          recovery actions away in the states that need them. */}
      <HostDangerZone scope={scope} />

      <RestartHostConfirmDialog
        open={restartConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setRestartConfirmOpen(false);
        }}
        isPending={restart.isPending}
        onConfirm={() => {
          // Minted at CONFIRM — the moment the action is armed — then REUSED
          // for every attempt at that same action, including a retry after an
          // ambiguous transport failure. See `newTransitionId` for why neither
          // a fresh id per network retry nor a shared constant is correct.
          const transitionId = armedRestartIdRef.current ?? newTransitionId();
          armedRestartIdRef.current = transitionId;
          restart.mutate(
            { transitionId },
            {
              onSuccess: (response) => {
                setRestartConfirmOpen(false);
                // A definitive answer ends this action: accepted means the
                // claim is spent, busy means it was refused outright. Either
                // way the next confirm is a NEW action and must not adopt it.
                armedRestartIdRef.current = null;
                if (response.outcome === "busy") {
                  // Not an error: the host closed admission, found work in
                  // flight, and reopened it. Nothing was interrupted.
                  setRestartBusyCount(response.verdict.busySessionCount);
                  return;
                }
                toast.success(`Restarting ${displayName}`);
              },
              onError: (error) => {
                setRestartConfirmOpen(false);
                // Deliberately NOT cleared: a transport failure says nothing
                // about whether the host granted the claim, so the id stays
                // armed for the retry that adopts it.
                toastFromHostError(error, "Couldn't restart this host.");
              },
            },
          );
        }}
      />
      <DoctorSheet
        open={doctorOpen}
        onOpenChange={setDoctorOpen}
        source={{
          kind: "rpc",
          client,
          hostName: displayName,
          isLocalMachine: host.isLocalMachine,
          hasLocalBridge: props.hasLocalBridge,
          degrade: doctorDegrade,
          onLocalFix: props.onLocalDoctorFix,
          localFixPendingCode: props.localDoctorFixPendingCode,
        }}
      />
    </div>
  );
}

/**
 * Every Overview control's capability, asked separately.
 *
 * Six questions rather than one, because they have six different answers on a
 * fleet mid-update: a host can support `host.status` and not `host.restart`, and
 * a current host on a box with no Traycer CLI can restart but cannot run doctor
 * or update itself. One page-level gate would turn any of those into "this page
 * is broken", which is the ambiguity the whole track exists to remove.
 */
interface OverviewCapabilities {
  readonly identity: OverviewDegradeReason | null;
  readonly restart: OverviewDegradeReason | null;
  readonly doctor: OverviewDegradeReason | null;
  readonly installInfo: OverviewDegradeReason | null;
  readonly updateCheck: OverviewDegradeReason | null;
  readonly updateInstall: OverviewDegradeReason | null;
  /** `host.identity.set` support, negotiated apart from the read. */
  readonly identitySet: OverviewDegradeReason | null;
}

function useOverviewCapabilities(hostId: string | null): OverviewCapabilities {
  return {
    identity: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.identity.get"),
    ),
    // SEPARATE from the read. `host.identity.get` and `host.identity.set` are
    // independent registry capabilities, so a peer can advertise one without
    // the other - and inferring write support from a readable identity opened
    // Edit name against a host whose handshake said it cannot save, turning
    // Save into an RPC the negotiation already ruled out.
    identitySet: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.identity.set"),
    ),
    restart: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.restart"),
    ),
    doctor: overviewMethodDegrade(useHostMethodSupport(hostId, "host.doctor")),
    installInfo: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.getInstallationInfo"),
    ),
    updateCheck: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.update.check"),
    ),
    updateInstall: overviewMethodDegrade(
      useHostMethodSupport(hostId, "host.update.install"),
    ),
  };
}

/**
 * Everything the card DISPLAYS, derived in one place from the two host reads
 * plus the scope row.
 *
 * Pulled out of the component for a reason beyond tidiness: this is where the
 * name-precedence rule lives, and it is a rule about which of two sources wins,
 * not a rendering detail. `effectiveName` from a reachable host outranks the
 * registry `displayName` the scope row carries — and because the registry's copy
 * FOLLOWS that exact value over the presence heartbeat, the two agree on a
 * healthy fleet. So the hand-off is a settle onto the fresher of two agreeing
 * sources, never a blank waiting to be filled, and there is no state in which
 * this returns an empty name.
 */
interface OverviewDisplay {
  readonly identity: HostIdentity | null;
  readonly displayName: string;
  /** What the rename input shows before the user types. */
  readonly persistedNameDraft: string;
  readonly endpointParts: readonly string[];
  readonly hostVersion: string | null;
  readonly updateProgress: HostStatusUpdateProgress | null;
}

function useOverviewDisplay(input: {
  readonly scope: HostScope;
  readonly host: HostScopeOption | null;
  readonly identity: HostIdentity | null;
  /** The negotiated `host.status` response, as this client's registry sees it. */
  readonly status: ResponseOfMethod<HostRpcRegistry, "host.status"> | null;
  readonly localHost: LocalHostSnapshot | null;
}): OverviewDisplay {
  const { scope, host, identity, status, localHost } = input;
  const hostVersion = status?.hostVersion ?? null;
  const busySessionCount = status?.busySessionCount ?? null;
  const endpointParts = useMemo(
    () =>
      host === null
        ? []
        : overviewEndpointParts({
            host,
            busySessionCount,
            localHost,
          }),
    [host, busySessionCount, localHost],
  );
  return {
    identity,
    displayName: identity?.effectiveName ?? host?.name ?? scope.hostLabel,
    persistedNameDraft: persistedDraftFromIdentity(identity),
    endpointParts,
    hostVersion,
    updateProgress: status?.updateProgress ?? null,
  };
}

/**
 * ONE Updates card, both halves of a host's update story.
 *
 * The host's own immediate check/apply needs a route and goes away without one;
 * the account registry's policy and version pin do not, and keeping them is the
 * whole reason this card is not gated as a unit — an unreachable host is a
 * common moment to want exactly those. They are genuinely two mechanisms, but a
 * person has one update question, so the copy distinguishes them rather than the
 * layout.
 */
function HostOverviewUpdatesCard(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostName: string;
  readonly installedVersion: string | null;
  readonly checkDegrade: OverviewDegradeReason | null;
  readonly installDegrade: OverviewDegradeReason | null;
  readonly busy: boolean;
  readonly usable: boolean;
  readonly registryItem: HostListItem | null;
}): ReactNode {
  const { registryItem } = props;
  return (
    <SettingsGroup
      title="Updates"
      tone="default"
      dataTestId="host-updates"
      fill={false}
    >
      <div className="[&>*:first-child]:border-t-0">
        {props.usable ? (
          <HostOverviewUpdatesRegion
            client={props.client}
            hostName={props.hostName}
            installedVersion={props.installedVersion}
            checkDegrade={props.checkDegrade}
            installDegrade={props.installDegrade}
            busy={props.busy}
          />
        ) : null}
        {registryItem === null ? null : (
          // Keyed by host: every piece of state inside — an open drain-gate
          // confirmation, a half-typed version pin — belongs to ONE host, so a
          // scope change must destroy it rather than re-point it.
          <HostRegistryUpdates key={registryItem.hostId} item={registryItem} />
        )}
      </div>
    </SettingsGroup>
  );
}

/**
 * Installation, as the HOST reads its own records.
 *
 * Pure host RPC and nothing else, so with no route it renders NOTHING rather
 * than a gate notice. That is deliberate and was a bug once: this page already
 * states an unreachable host exactly once — the identity card's health line
 * says so, and the danger zone's gate explains which rows it costs. A second
 * gate here printed the same "can't reach this host" notice twice on one page.
 * An absent section under a card that already says why is quieter and truer
 * than repeating the reason.
 *
 * `unmanaged` IS a real state rather than an error: a host run from a checkout
 * has no install record, and reporting that as "nothing is installed" put a
 * false alarm on every developer's machine.
 */
function HostOverviewInstallationCard(props: {
  readonly usable: boolean;
  readonly hostName: string;
  readonly degrade: OverviewDegradeReason | null;
  readonly record: InstallationDetailsRecord | null;
  readonly loading: boolean;
  /** The read itself failed - which is NOT the same as "no record". */
  readonly readFailed: boolean;
}): ReactNode {
  if (!props.usable) return null;
  return (
    <SettingsGroup
      title="Installation"
      tone="default"
      dataTestId={undefined}
      fill={false}
    >
      <HostOverviewInstallationBody
        hostName={props.hostName}
        degrade={props.degrade}
        record={props.record}
        loading={props.loading}
        readFailed={props.readFailed}
      />
    </SettingsGroup>
  );
}

/**
 * Three outcomes, and the middle one is the finding: a FAILED read is not an
 * unmanaged host. Collapsing both to `record: null` made the card assert that
 * this host runs from a checkout or an unpacked tree - a fact the RPC never
 * established, stated to the user as if it had.
 */
function HostOverviewInstallationBody(props: {
  readonly hostName: string;
  readonly degrade: OverviewDegradeReason | null;
  readonly record: InstallationDetailsRecord | null;
  readonly loading: boolean;
  readonly readFailed: boolean;
}): ReactNode {
  if (props.degrade !== null) {
    return (
      <HostOverviewNotice testId="host-overview-installation-degraded">
        {describeOverviewDegrade(props.degrade, props.hostName)}
      </HostOverviewNotice>
    );
  }
  if (props.readFailed && props.record === null) {
    return (
      <HostOverviewNotice testId="host-overview-installation-unreadable">
        {`Couldn't read ${props.hostName}'s installation record.`}
      </HostOverviewNotice>
    );
  }
  return (
    <InstallationDetailsDisclosure
      record={props.record}
      loading={props.loading}
      emptyMessage={`${props.hostName} is running from a checkout or an unpacked tree, so it has no installation record.`}
    />
  );
}
