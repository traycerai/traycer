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
import { useScopedStreamBinding } from "@/components/settings/host-scope/use-scoped-stream-binding";
import { HostOverviewPanel } from "@/components/settings/panels/host-overview-panel";
import {
  fixActionLabel,
  parseFreePortInput,
  runFixAction,
} from "@/components/settings/panels/host-doctor-actions";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { HostRuntimeContext, useHostBinding } from "@/lib/host";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
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
import { use, type ReactNode } from "react";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/** When a host cannot answer, the page says so and shows what the account registry already knows - never a
 * hidden local fallback. */
export function HostSettingsPanel() {
  const scope = useHostScope();
  // Without this, a scope switch while a confirmation was open left the dialog mounted and armed against the
  // host the page had just moved away from.
  const scopeKey = scope.hostId ?? "unresolved";
  return <HostSettingsPanelInner key={scopeKey} />;
}

function HostSettingsPanelInner() {
  const scope = useHostScope();
  const runnerHost = useRunnerHost();
  const compact = useSettingsDensity() === "compact";
  const management = runnerHost.hostManagement;

  // Re-provided so every hook beneath this resolves to the selected host rather than the ambient one - the
  // Providers-panel pattern, with its `status === "ready"` guard.
  const scopedBinding = useScopedHostBinding(scope);

  // Import and migration are the only things on this page that ride a stream, and both move one machine's local
  // data.
  const scopedStreamBinding = useScopedStreamBinding(scope);
  const ambientStreamBinding = use(StreamRuntimeContext);
  const ambientBinding = useHostBinding();

  // false`, never `?? The gate below withholds the body in those states; this is the second line, so a future
  // caller that forgets the gate fails closed.
  const scopedIsLocalMachine = scope.host?.isLocalMachine ?? false;

  // Owned here rather than inside the sheet because `IHostManagement` is a property of the shell, not of the
  // scoped host, and the sheet must not be able to reach for it by accident for a host on another machine.
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

  // Say nothing about a host the scope cannot resolve.
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
      // The card below names the host, in bigger type, next to its status and its Edit name control.
      description={description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {body}
    </SettingsPanelShell>
  );

  // Both providers are rendered unconditionally, which is load-bearing rather than tidy.
  return (
    <HostRuntimeContext.Provider value={scopedBinding ?? ambientBinding}>
      <StreamRuntimeContext.Provider
        value={scopedStreamBinding ?? ambientStreamBinding}
      >
        {shell}
      </StreamRuntimeContext.Provider>
    </HostRuntimeContext.Provider>
  );
}

/** `scope.client`, never the ambient one: probing the wrong machine would refresh a capability record for a
 * host this page is not showing. */
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

/** It is gone, and deliberately not replaced by a fallback data source: the bridge can only ever speak for this
 * computer, so anything built on it is a surface a remote host can never have. */
function renderOverviewBody(input: {
  readonly scope: HostScope;
  readonly unresolved: boolean;
  readonly compact: boolean;
  readonly hasLocalBridge: boolean;
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
    // No `key` here: `HostSettingsPanel` already remounts everything below it on a scope change
    // (`key={scopeKey}`), so a second one would be decoration.
    <HostOverviewPanel
      scope={scope}
      hasLocalBridge={input.hasLocalBridge}
      onLocalDoctorFix={input.onLocalDoctorFix}
      localDoctorFixPendingCode={input.localDoctorFixPendingCode}
    />
  );
}

/** These stay local by design and not for want of an RPC: they repair a host that is down or broken, and such a
 * host generally cannot answer one. */
/** A discriminated pair rather than a bare boolean, because the declined arm is the only one with a message and
 * the applied arm must never carry one. */
type LocalDoctorFixOutcome =
  | { readonly applied: true; readonly declinedMessage: null }
  | { readonly applied: false; readonly declinedMessage: string };

// Tripwire, never called: the query above is `enabled` only with a bridge.
function skipInstalledRecord(): Promise<HostInstalledRecord | null> {
  return Promise.reject(new Error("host management bridge unavailable"));
}

/** Everything else about recovery stays the window narrator's job; this is the verb that must not vanish with
 * the row. */
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

/** Which Doctor fix actions are controller lifecycle intents, and therefore take the refusing dispatch rather
 * than the queueing one. */
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
  /** Sent with the two lifecycle repairs so main can refuse one aimed at a host that has since been replaced. */
  localHostId: string | null,
) {
  const queryClient = useQueryClient();
  // Raising the toasts inside it also collapsed "declined" into a resolved promise, so `onSuccess` invalidated
  // the installed-record query after a fix that never ran - a re-read charged to a change that did not happen.
  return useMutation<LocalDoctorFixOutcome, Error, RpcDoctorIssue>({
    mutationKey: runnerMutationKeys.hostRunDoctor(),
    mutationFn: async (issue) => {
      if (management === null) {
        throw new Error("This shell has no local Traycer CLI to run that fix.");
      }
      // `runFixAction` reads only `fixAction` and `details`.
      const issueForBridge: BridgeDoctorIssue = issue;
      // The card's own gate cannot close that window - it sees only what it last rendered - so admission is tested
      // in main, atomically.
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
      // `localHostId` is null when this page's host is not this machine, and an empty id is refused by every host
      // that can name itself.
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
        // React Query hands the mutation's own variables back here, so the intent is read from the issue that was
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
