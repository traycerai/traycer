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
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { HostOverviewPanel } from "@/components/settings/panels/host-overview-panel";
import { HostRecoveryConsole } from "@/components/settings/panels/host-recovery-console";
import { useLocalHostSnapshot } from "@/components/settings/panels/host-settings-panel-hooks";
import { runFixAction } from "@/components/settings/panels/host-doctor-actions";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { HostRuntimeContext } from "@/lib/host";
import { useHostCapabilityProbe } from "@/hooks/host/use-host-capability-probe";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { toastHostRestartDeclined } from "@/lib/host-restart-toast";
import { useRunnerHost } from "@/providers/use-runner-host";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";
import type {
  HostDoctorIssue as BridgeDoctorIssue,
  HostInstalledRecord,
  IHostManagement,
  IRunnerHost,
  LocalHostSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import type { ReactNode } from "react";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/**
 * The one Overview page, and the one decision about which surface it shows.
 *
 * The page proper (`HostOverviewPanel`) reads the SCOPED HOST'S OWN RPC and is
 * identical for a machine on this desk and a machine in a datacenter. The
 * recovery console (`HostRecoveryConsole`) is what remains of the old
 * CLI-bridge page: it renders only for THIS COMPUTER, and only when there is no
 * host process here to answer — install, start and re-register a service that
 * is down.
 *
 * The split is the SUBJECT plus the presence of a process, never reachability
 * as a page-level gate. Gating the console on dialability is what once removed
 * Install and Start in exactly the state they exist for; gating the RPC page on
 * "is this local?" is what gave remote hosts a thinner page in a different
 * dialect. Both mistakes are named here because both were shipped.
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
  const localHost = useLocalHostSnapshot(runnerHost);

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

  // The fresh-install carve-out. On a first run there is no local host id yet,
  // so the union has no local row at all: the scope resolves to NOTHING and the
  // honest-state rule above would leave only an empty notice — while the CLI
  // bridge sits right here reporting `not-installed`, which is the one state
  // the install console exists for. An EMPTY account (both lists answered,
  // nothing failed, no vanished pick) is exactly when this computer's console
  // is recovery rather than misattribution: there is no other host the controls
  // could be mistaken for.
  const emptyAccountLocalRecovery =
    scope.host === null &&
    scope.vanishedHostId === null &&
    scope.hosts.length === 0 &&
    !scope.isLoading &&
    !scope.listsFailed;

  // Which surface this computer's host gets, and the bridge that would run it.
  const recoveryManagement = useRecoveryConsoleManagement({
    management,
    localHost,
    connectable: scope.host?.connectable ?? false,
    scopedIsLocalMachine,
    emptyAccountLocalRecovery,
  });

  // The doctor's three repair-a-down-host fixes still run over the bridge when
  // the host being shown is this computer. Owned here rather than inside the
  // sheet because `IHostManagement` is a property of the SHELL, not of the
  // scoped host, and the sheet must not be able to reach for it by accident for
  // a host on another machine.
  const localDoctorFix = useLocalDoctorFixMutation(management);

  // Keeps a `false` capability answer refutable. See the hook below.
  useOverviewCapabilityProbe(scope);

  const description =
    scope.host === null
      ? "Status, updates and maintenance for the selected host."
      : `Status, updates and maintenance for ${scope.host.name}.`;

  // Say NOTHING about a host the scope cannot resolve. This is the whole-panel
  // gate, and it is now safe to use one: unlike the old page, everything below
  // describes the scoped host, so there is no region that would be wrongly
  // withheld by it.
  //
  // The carve-out is stated as "...and there is no recovery console to offer",
  // not as the carve-out flag itself. A fresh install has no row to resolve, so
  // the gate must stand aside for the console that creates the first host — but
  // a shell with no CLI bridge (web, mobile) has no console either, and there
  // the gate's "No hosts yet" is the only honest thing on the page.
  const unresolved =
    (scope.host === null && recoveryManagement === null) ||
    scope.status === "vanished";

  const body = renderOverviewBody({
    scope,
    unresolved,
    compact,
    recoveryManagement,
    runnerHost,
    emptyAccountLocalRecovery,
    // Only ever this computer's snapshot, and only when this computer is the
    // SUBJECT. Handing it over for a remote row would print a local pid under
    // another machine's name.
    localHost: scopedIsLocalMachine ? localHost : null,
    hasLocalBridge: management !== null && scopedIsLocalMachine,
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
 * The recovery console's precondition, and the bridge that would drive it.
 *
 * Returns the bridge when this computer's host has no process to answer for
 * itself, and `null` otherwise — so the caller narrows `IHostManagement` by
 * using the answer rather than re-deriving it, and there is exactly one place
 * that decides when the CLI-bridge surface appears.
 */
function useRecoveryConsoleManagement(input: {
  readonly management: IHostManagement | null;
  readonly localHost: LocalHostSnapshot | null;
  readonly connectable: boolean;
  readonly scopedIsLocalMachine: boolean;
  readonly emptyAccountLocalRecovery: boolean;
}): IHostManagement | null {
  const { management, scopedIsLocalMachine, emptyAccountLocalRecovery } = input;
  // "Not installed" is a BRIDGE fact with no RPC twin: a host that was never
  // installed cannot answer `host.getInstallationInfo`, or anything else.
  //
  // Reading it for a local scope is free — `useHostScope` runs this exact query
  // under this exact key for every shell with a bridge, so this observer shares
  // that cache entry rather than adding a call.
  const installedQuery = useQuery(
    queryOptions<HostInstalledRecord | null>({
      queryKey:
        management === null
          ? runnerQueryKeys.hostInstalledRecordUnavailable()
          : runnerQueryKeys.hostInstalledRecord(management),
      queryFn:
        management === null
          ? skipInstalledRecord
          : () => management.installedRecord(),
      enabled:
        management !== null &&
        (scopedIsLocalMachine || emptyAccountLocalRecovery),
      staleTime: 30_000,
    }),
  );

  // `deriveStatus`'s "not-installed" state, which is why the live snapshot is
  // part of it rather than the record alone.
  //
  // A live local process outranks a missing install record: someone running the
  // host from a checkout HAS no record, and reading that as "not installed"
  // would offer Install for a host answering RPCs right now. It is also what
  // keeps the page from FLIPPING surfaces. The record arrives asynchronously, so
  // a record-only rule renders the RPC page first and swaps to the console when
  // it lands — destroying anything opened in between, which is how a restart
  // confirmation gets dismissed out from under a click. With the snapshot in the
  // conjunct a running host never enters this branch, and a stopped one is
  // already caught by `!connectable` on the very first render.
  const notInstalled =
    input.localHost === null &&
    installedQuery.isSuccess &&
    installedQuery.data === null;

  const applies =
    (scopedIsLocalMachine && (!input.connectable || notInstalled)) ||
    emptyAccountLocalRecovery;
  return applies ? management : null;
}

/**
 * Which of the three surfaces the page is showing, in one place.
 *
 * Extracted from the panel so the decision reads as three named, mutually
 * exclusive outcomes rather than a chain of conditions embedded in JSX — the
 * shape that let "local" and "unresolved" quietly overlap in the old page.
 */
function renderOverviewBody(input: {
  readonly scope: HostScope;
  readonly unresolved: boolean;
  readonly compact: boolean;
  readonly recoveryManagement: IHostManagement | null;
  readonly runnerHost: IRunnerHost;
  readonly emptyAccountLocalRecovery: boolean;
  readonly localHost: LocalHostSnapshot | null;
  readonly hasLocalBridge: boolean;
  readonly onLocalDoctorFix: (issue: RpcDoctorIssue) => void;
  readonly localDoctorFixPendingCode: string | null;
}): ReactNode {
  const { scope, recoveryManagement } = input;
  if (input.unresolved) {
    return (
      <HostScopeGate
        scope={scope}
        skeleton={<HostScopeConnecting hostName={scope.hostLabel} />}
      >
        {null}
      </HostScopeGate>
    );
  }
  if (recoveryManagement !== null) {
    return (
      <div className={cn("flex flex-col", input.compact ? "gap-3.5" : "gap-5")}>
        <HostRecoveryConsole
          management={recoveryManagement}
          runnerHost={input.runnerHost}
          scope={scope}
          emptyAccountLocalRecovery={input.emptyAccountLocalRecovery}
        />
      </div>
    );
  }
  return (
    <HostOverviewPanel
      scope={scope}
      localHost={input.localHost}
      hasLocalBridge={input.hasLocalBridge}
      onLocalDoctorFix={input.onLocalDoctorFix}
      localDoctorFixPendingCode={input.localDoctorFixPendingCode}
    />
  );
}

/**
 * Stand-in `queryFn` for the disabled installed-record query.
 *
 * TanStack requires one even when `enabled` is false, and a rejecting stub is
 * the honest shape: if it ever runs, the `enabled` guard above it is wrong and
 * should fail loudly rather than resolve a fake `null` that would read as
 * "nothing is installed" — and put the install console on screen.
 */
function skipInstalledRecord(): Promise<HostInstalledRecord | null> {
  return Promise.reject(new Error("host management bridge unavailable"));
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
 * callbacks can tell "applied" from "the host declined to restart". A
 * discriminated pair rather than a bare boolean, because the declined arm is
 * the only one with a message and the applied arm must never carry one.
 */
type LocalDoctorFixOutcome =
  | { readonly applied: true; readonly declinedMessage: null }
  | { readonly applied: false; readonly declinedMessage: string };

function useLocalDoctorFixMutation(management: IHostManagement | null) {
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
      const result = await runFixAction(management, issueForBridge);
      return result.kind === "declined"
        ? { applied: false, declinedMessage: result.message }
        : { applied: true, declinedMessage: null };
    },
    onSuccess: (outcome) => {
      if (!outcome.applied) {
        toastHostRestartDeclined(outcome.declinedMessage);
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
