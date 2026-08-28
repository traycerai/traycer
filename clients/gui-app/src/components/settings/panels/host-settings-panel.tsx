import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type { HostDoctorIssue as RpcDoctorIssue } from "@traycer/protocol/host/maintenance/index";
import {
  HostScopeConnecting,
  HostScopeGate,
} from "@/components/settings/host-scope/host-scope-gate";
import { LocalRecoveryDangerZone } from "@/components/settings/host-scope/host-danger-zone";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { HostOverviewPanel } from "@/components/settings/panels/host-overview-panel";
import {
  fixActionLabel,
  parseFreePortInput,
  runFixAction,
} from "@/components/settings/panels/host-doctor-actions";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { HostRuntimeContext } from "@/lib/host";
import { useHostCapabilityProbe } from "@/hooks/host/use-host-capability-probe";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import {
  toastHostRepairDeclined,
  toastHostRestartDeclined,
} from "@/lib/host-restart-toast";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useSettingsDensity } from "@/providers/settings-density-context";
import type {
  HostDoctorIssue as BridgeDoctorIssue,
  HostInstalledRecord,
  IHostManagement,
  DoctorRepairIntent,
} from "@traycer-clients/shared/platform/runner-host";
import type { ReactNode } from "react";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/**
 * The one Overview page. No second surface, and so no decision about which to
 * show.
 *
 * `HostOverviewPanel` reads the SCOPED HOST'S OWN RPC, and a machine on this
 * desk renders the same components from the same answers as a machine in a
 * datacenter. There used to be a second page beside it — a CLI-bridge recovery
 * console, picked when the subject was THIS COMPUTER and no host process was up
 * — and the pair is what this file no longer does. The bridge can only ever
 * speak for the local machine, so anything built on it is a surface a remote
 * host can never have; a page whose layout depends on which machine you are
 * looking at, and on whether its process happens to be up, is two products
 * wearing one name. That is how the offline surface drifted a full redesign
 * behind the online one without anyone noticing.
 *
 * When a host cannot answer, the page says so and shows what the ACCOUNT
 * REGISTRY already knows — never a hidden local fallback. Restarting a host
 * that is down belongs to the window narrator, which owns the app-level "your
 * host isn't up" surface; that is app state, not a property of the host you
 * happen to be viewing.
 */
export function HostSettingsPanel() {
  const scope = useHostScope();
  // Keyed by scoped host: every piece of page state below — an open restart
  // confirmation, a half-typed rename, a doctor sheet — belongs to ONE host.
  // Without this, a scope switch while a confirmation was open left the dialog
  // mounted and armed against the host the page had just moved away from.
  const scopeKey = scope.hostId ?? "unresolved";
  return <HostSettingsPanelInner key={scopeKey} />;
}

function HostSettingsPanelInner() {
  const scope = useHostScope();
  const runnerHost = useRunnerHost();
  const compact = useSettingsDensity() === "compact";
  const management = runnerHost.hostManagement;

  // Re-provided so every hook beneath this resolves to the SELECTED host rather
  // than the ambient one — the Providers-panel pattern, with its `status ===
  // "ready"` guard. `null` for `following` (the ambient binding already IS this
  // host's) and for every non-ready status.
  const scopedBinding = useScopedHostBinding(scope);

  // The scoped host is the SUBJECT of this page.
  //
  // `?? false`, never `?? true`. A null host means the scope resolved to
  // NOTHING — vanished, unreachable, or still loading — and defaulting that to
  // "yes, this is your machine" put this computer's install / restart console
  // on screen under a host that no longer exists. The gate below withholds the
  // body in those states; this is the second line, so a future caller that
  // forgets the gate fails closed.
  const scopedIsLocalMachine = scope.host?.isLocalMachine ?? false;

  // The doctor's three repair-a-down-host fixes still run over the bridge when
  // the host being shown is this computer. Owned here rather than inside the
  // sheet because `IHostManagement` is a property of the SHELL, not of the
  // scoped host, and the sheet must not be able to reach for it by accident for
  // a host on another machine.
  const localDoctorFix = useLocalDoctorFixMutation(
    management,
    scopedIsLocalMachine ? (scope.hostId ?? null) : null,
  );

  // Keeps a `false` capability answer refutable. See the hook below.
  useOverviewCapabilityProbe(scope);

  const localRecoveryZone = useEmptyAccountLocalRecoveryZone(scope, management);

  const description =
    scope.host === null
      ? "Status, updates and maintenance for the selected host."
      : `Status, updates and maintenance for ${scope.host.name}.`;

  // Say NOTHING about a host the scope cannot resolve. This is the whole-panel
  // gate, and it is safe to use one: everything below describes the scoped
  // host, so there is no region that would be wrongly withheld by it.
  //
  // There is no longer a carve-out PAGE for a first run. The recovery console
  // this page used to fall back to is GONE, along with the whole idea that a
  // host which cannot answer gets a different page: one component now describes
  // every host from whatever source can answer for it, and says plainly when
  // that is only the account registry. Creating the first host was never
  // unique to that console anyway — the desktop auto-converges at startup
  // (`host-launch-converge.ts`) and the window narrator owns the app-level
  // "your host is not up" surface with its own recovery actions. What survives of it is
  // the single VERB above (`localRecoveryZone`), rendered under this gate.
  const unresolved = scope.host === null || scope.status === "vanished";

  const body = renderOverviewBody({
    scope,
    unresolved,
    compact,
    hasLocalBridge: management !== null && scopedIsLocalMachine,
    localRecoveryZone,
    onLocalDoctorFix: (issue) => localDoctorFix.mutate(issue),
    localDoctorFixPendingCode: localDoctorFix.isPending
      ? localDoctorFix.variables.code
      : null,
  });

  const shell = (
    <SettingsPanelShell
      title="Overview"
      // The card below names the host, in bigger type, next to its status and
      // its Edit name control. Repeating it as the page title printed the same
      // string twice, two lines apart, and made the header look like a bug.
      description={description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {body}
    </SettingsPanelShell>
  );

  if (scopedBinding === null) return shell;
  return (
    <HostRuntimeContext.Provider value={scopedBinding}>
      {shell}
    </HostRuntimeContext.Provider>
  );
}

/**
 * Keeps a stale `false` capability answer from becoming permanent.
 *
 * This page parks reads on those answers — the identity read, the installation
 * read, and the buttons around them — and the reads that would produce the next
 * handshake are exactly the ones a `false` turns off. Without a counterweight, a
 * host upgraded in place under the same id keeps its stale verdict and the page
 * keeps promising an update that already happened. The probe keeps one bounded
 * released-floor read mounted while that is true; the response is unused, the
 * handshake is the point.
 *
 * `scope.client`, never the ambient one: probing the wrong machine would refresh
 * a capability record for a host this page is not showing.
 */
function useOverviewCapabilityProbe(scope: HostScope): void {
  const identitySupported = useHostMethodSupport(
    scope.hostId,
    "host.identity.get",
  );
  const installInfoSupported = useHostMethodSupport(
    scope.hostId,
    "host.getInstallationInfo",
  );
  useHostCapabilityProbe({
    client: scope.client,
    stale: identitySupported === false || installInfoSupported === false,
    incarnation: [
      scope.host?.version ?? null,
      scope.host?.connectable ?? false,
    ],
  });
}

/**
 * Two outcomes, not three.
 *
 * There used to be a third — a CLI-bridge "recovery console" that replaced this
 * whole page whenever the local host had no process to answer for itself. It is
 * gone, and deliberately not replaced by a fallback data source: the bridge can
 * only ever speak for THIS computer, so anything built on it is a surface a
 * remote host can never have. A page whose layout depends on which machine you
 * are looking at, and on whether its process happens to be up, is two products
 * wearing one name — which is exactly how the offline surface drifted a full
 * redesign behind the online one without anyone noticing.
 *
 * So: either the scope cannot name a host at all, or `HostOverviewPanel`
 * describes it from whatever source can answer — the host's own RPCs when it is
 * reachable, the account registry when it is not, and it says which.
 */
function renderOverviewBody(input: {
  readonly scope: HostScope;
  readonly unresolved: boolean;
  readonly compact: boolean;
  readonly hasLocalBridge: boolean;
  /** The empty-account uninstall carve-out; `null` in every other state. */
  readonly localRecoveryZone: ReactNode | null;
  readonly onLocalDoctorFix: (issue: RpcDoctorIssue) => void;
  readonly localDoctorFixPendingCode: string | null;
}): ReactNode {
  const { scope } = input;
  if (input.unresolved) {
    return (
      <div className="flex w-full flex-col gap-5">
        <HostScopeGate
          scope={scope}
          skeleton={<HostScopeConnecting hostName={scope.hostLabel} />}
        >
          {null}
        </HostScopeGate>
        {input.localRecoveryZone}
      </div>
    );
  }
  return (
    // No `key` here: `HostSettingsPanel` already remounts everything below it on
    // a scope change (`key={scopeKey}`), so a second one would be decoration.
    // That is also what makes it safe for the update state to live at page level
    // now that its two halves render in two different containers — an armed
    // drain-gate confirmation and the manifest the last check returned die with
    // the host they belonged to, one boundary up.
    <HostOverviewPanel
      scope={scope}
      hasLocalBridge={input.hasLocalBridge}
      onLocalDoctorFix={input.onLocalDoctorFix}
      localDoctorFixPendingCode={input.localDoctorFixPendingCode}
    />
  );
}

/**
 * The doctor's local-only repairs (`service-install`, `free-port-and-restart`,
 * `host-install-latest`) over the CLI bridge.
 *
 * These stay local by design and not for want of an RPC: they repair a host
 * that is down or broken, and such a host generally cannot answer one. The
 * remote degrade is the terminal command, not a remote verb — the plan dropped
 * those deliberately, because they would be dead controls.
 *
 * The issue shape crosses transports here. The RPC report and the bridge report
 * describe the same CLI diagnostics, and `runFixAction` reads only `fixAction`
 * and `details`, so the bridge runner serves both.
 */
/**
 * What the bridge fix actually did, carried out of `mutationFn` so the
 * callbacks can tell "applied" from "nothing was enqueued". A discriminated
 * pair rather than a bare boolean, because the declined arm is the only one
 * with a message and the applied arm must never carry one.
 *
 * The declined arm is deliberately intent-FREE: it says only that the repair
 * did not run. Which repair it was is the mutation's own variable, so the
 * callbacks read it from there rather than from a copy in here that could
 * disagree with the issue that was actually clicked.
 */
type LocalDoctorFixOutcome =
  | { readonly applied: true; readonly declinedMessage: null }
  | { readonly applied: false; readonly declinedMessage: string };

// Tripwire, never called: the query above is `enabled` only with a bridge.
function skipInstalledRecord(): Promise<HostInstalledRecord | null> {
  return Promise.reject(new Error("host management bridge unavailable"));
}

/**
 * The one carve-out the whole-panel gate still owes: an install that completed
 * while sign-in did not. An EMPTY account (both lists answered, nothing
 * failed, no vanished pick) with installed local components has exactly one
 * thing left to offer — removal over the CLI bridge, which needs no host row —
 * and `LocalRecoveryDangerZone`'s contract names this page as the only
 * uninstall surface. Everything else about recovery stays the window
 * narrator's job; this is the verb that must not vanish with the row. The caller decides
 * whether anything is actually installed — the zone cannot know — so the
 * bridge's install record is the gate, and only the empty-account state asks.
 */
function useEmptyAccountLocalRecoveryZone(
  scope: HostScope,
  management: IHostManagement | null,
): ReactNode | null {
  const emptyAccountLocalRecovery =
    scope.host === null &&
    scope.vanishedHostId === null &&
    scope.hosts.length === 0 &&
    !scope.isLoading &&
    !scope.listsFailed;
  const installedRecord = useQuery(
    queryOptions<HostInstalledRecord | null>({
      queryKey:
        management === null
          ? runnerQueryKeys.hostInstalledRecordUnavailable()
          : runnerQueryKeys.hostInstalledRecord(management),
      queryFn:
        management === null
          ? skipInstalledRecord
          : () => management.installedRecord(),
      enabled: management !== null && emptyAccountLocalRecovery,
      staleTime: 30_000,
    }),
  );
  if (!emptyAccountLocalRecovery || management === null) return null;
  if ((installedRecord.data ?? null) === null) return null;
  return <LocalRecoveryDangerZone />;
}

/**
 * Which Doctor fix actions are controller LIFECYCLE intents, and therefore
 * take the refusing dispatch rather than the queueing one. `null` means the
 * action is a repair for a host that is already down, where waiting behind
 * whatever is running is the point.
 */
function doctorRepairIntentFor(
  fixAction: string | null,
): DoctorRepairIntent | null {
  // Both spellings of "there is no usable host installed" converge.
  if (fixAction === "host-install" || fixAction === "host-install-latest") {
    return "converge-ready";
  }
  if (fixAction === "service-install") return "register-service";
  return null;
}

function useLocalDoctorFixMutation(
  management: IHostManagement | null,
  /**
   * The local host these repairs are for, or `null` when the scoped host is
   * not this machine. Sent with the two LIFECYCLE repairs so main can refuse
   * one aimed at a host that has since been replaced.
   */
  localHostId: string | null,
) {
  const queryClient = useQueryClient();
  // `mutationFn` REPORTS the outcome; it does not announce it. Raising the
  // toasts inside it also collapsed "declined" into a resolved promise, so
  // `onSuccess` invalidated the installed-record query after a fix that never
  // ran - a re-read charged to a change that did not happen.
  return useMutation<LocalDoctorFixOutcome, Error, RpcDoctorIssue>({
    mutationKey: runnerMutationKeys.hostRunDoctor(),
    mutationFn: async (issue) => {
      if (management === null) {
        throw new Error("This shell has no local Traycer CLI to run that fix.");
      }
      // No conversion: the two `HostDoctorIssue` declarations are the same
      // seven fields with the same severity union, because they describe the
      // same CLI diagnostic — one arrived over the wire and one over the
      // bridge. `runFixAction` reads only `fixAction` and `details`.
      const issueForBridge: BridgeDoctorIssue = issue;
      // The two LIFECYCLE repairs take the refusing path. `convergeReady`
      // converges to LATEST and `registerService` adds a service cycle, and
      // both QUEUE behind a running controller intent rather than being
      // refused — so one clicked during a pinned install lands after it and
      // overrides the version the person chose. This page cannot gate that on
      // its own: its lifecycle state cannot see a lane the tray or the
      // background reconciler armed. The remaining repairs keep the queueing
      // path, which is right for a host that is already down.
      // Free port + restart is the third repair that must be REFUSED rather
      // than queued for a sheet someone is watching: it kills the recorded
      // process and forces a restart, so landing it behind a competing
      // lifecycle write aims a kill the person approved for one state at
      // another. The card's own gate cannot close that window — it sees only
      // what it last rendered — so admission is tested in main, atomically.
      if (issue.fixAction === "host-free-port-and-restart") {
        const input = parseFreePortInput(issueForBridge);
        if (input === null) {
          throw new Error("Doctor issue is missing a valid conflicting port.");
        }
        const dispatch = await management.freePortAndRestartIfIdle({
          ...input,
          expectedHostId: localHostId ?? "",
        });
        if (dispatch.kind !== "dispatched") {
          return { applied: false, declinedMessage: dispatch.message };
        }
        if (dispatch.outcome.kind !== "ok") {
          throw new Error(dispatch.outcome.message);
        }
        return { applied: true, declinedMessage: null };
      }
      const repair = doctorRepairIntentFor(issue.fixAction);
      if (repair !== null && localHostId !== null) {
        const dispatch = await management.runDoctorRepairIfIdle({
          repair,
          expectedHostId: localHostId,
        });
        if (dispatch.kind !== "dispatched") {
          return { applied: false, declinedMessage: dispatch.message };
        }
        if (dispatch.outcome.kind !== "ok") {
          throw new Error(dispatch.outcome.message);
        }
        return { applied: true, declinedMessage: null };
      }
      // `localHostId` is null when this page's host is not this machine, and
      // an empty id is refused by every host that can name itself - the right
      // answer, since a bridge fix would then be running against a different
      // computer than the one the report describes.
      const result = await runFixAction(
        management,
        issueForBridge,
        localHostId ?? "",
      );
      return result.kind === "declined"
        ? { applied: false, declinedMessage: result.message }
        : { applied: true, declinedMessage: null };
    },
    onSuccess: (outcome, issue) => {
      if (!outcome.applied) {
        // WHICH action was refused decides the wording. Before the refusing
        // repair path existed, `declined` could only ever come from
        // `restartHost`, so "Host not restarted" was always true; now
        // `runDoctorRepairIfIdle` refuses Install host and Register service
        // through the same arm. React Query hands the mutation's own
        // variables back here, so the intent is read from the issue that was
        // clicked rather than re-derived or carried in the outcome.
        const fixAction = issue.fixAction;
        if (fixAction === "host-start" || fixAction === "host-restart") {
          toastHostRestartDeclined(outcome.declinedMessage);
          return;
        }
        toastHostRepairDeclined(
          fixActionLabel(fixAction ?? ""),
          outcome.declinedMessage,
        );
        return;
      }
      toast.success("Fix applied");
      if (management === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostInstalledRecord(management),
      });
    },
    onError: (error) => toastFromRunnerError(error, "Fix failed"),
  });
}
