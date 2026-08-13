import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostDoctorIssue,
  HostDoctorResponse,
} from "@traycer/protocol/host/maintenance/index";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  copyTerminalCommand,
  describeFreePortPrompt,
  doctorFixRoute,
  fixActionLabel,
  parseFreePortInput,
  severityBadgeClass,
  severityBorderClass,
  type DoctorFixRoute,
} from "@/components/settings/panels/host-doctor-actions";
import { HostSettingsDisclosure } from "@/components/settings/panels/host-settings-disclosure";
import {
  describeCliShellFailure,
  describeOverviewDegrade,
  splitDoctorIssuesByVantage,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import { useHostDoctorRun } from "@/components/settings/panels/host-overview-rpc";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostMaintenanceMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { newTransitionId } from "@/components/settings/panels/host-overview-transition-id";
import { cn } from "@/lib/utils";
import type { HostRpcRegistry } from "@/lib/host";

const DOCTOR_LOG_TAIL_LINES = 200;

/**
 * Host Doctor over the host's own RPC — the same report for a machine on this
 * desk and a machine in a datacenter.
 *
 * Two things make the report trustworthy over a connection, and both come from
 * the host rather than being guessed here:
 *
 *  1. **Vantage.** The host says which issue codes its transport already
 *     disproves. A `SERVICE_STOPPED` in a report that arrived over a live local
 *     WebSocket is describing the process that just answered; presenting it as
 *     an issue sends someone to fix a host that is demonstrably running. Over a
 *     relay the set is empty — the relay proves the relay, not the daemon's
 *     loopback listener — so the same code stays a real issue for a remote host.
 *  2. **Structured failure arms.** `cli-unavailable` / `cli-failed` /
 *     `invalid-output` are ANSWERS, not errors. The host reached us fine; it is
 *     reporting what happened when it tried to shell its CLI. Only a transport
 *     failure is an error, so only that gets error treatment.
 */
export function HostDoctorRpcCard(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostName: string;
  readonly isLocalMachine: boolean;
  /** True when this shell has a CLI bridge that could run local-only fixes. */
  readonly hasLocalBridge: boolean;
  /** `host.doctor` capability; `null` (no handshake yet) is NOT a degrade. */
  readonly degrade: OverviewDegradeReason | null;
  /** Runs the local-only repair actions on this computer. */
  readonly onLocalFix: (issue: HostDoctorIssue) => void;
  readonly localFixPendingCode: string | null;
}): ReactNode {
  const { client, hostName } = props;
  const doctorRun = useHostDoctorRun(client);
  const [report, setReport] = useState<HostDoctorResponse | null>(null);
  const [logTail, setLogTail] = useState<readonly string[] | null>(null);
  // The id of a Doctor-fix restart whose DISPATCH OUTCOME IS UNKNOWN - the
  // transport threw after the host may already have granted the claim. Retained
  // so the retry can adopt that claim, cleared on every definitive answer.
  const armedFixRestartIdRef = useRef<string | null>(null);
  // The one local fix that ENDS things — it kills the process holding the port
  // and restarts the host. The bridge Doctor has always confirmed it, and
  // routing it through this card must not quietly drop that: the RPC route
  // changed which report we are reading, not how destructive the repair is.
  const [freePortIssue, setFreePortIssue] = useState<HostDoctorIssue | null>(
    null,
  );

  const restartMutation = useHostMutation<
    HostRpcRegistry,
    "host.restart",
    { readonly hostId: string | null },
    { readonly transitionId: string }
  >({
    client,
    method: "host.restart",
    mapVariables: (variables) => ({ transitionId: variables.transitionId }),
    options: {
      mutationKey: hostMaintenanceMutationKeys.restart(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
    },
  });

  const logsMutation = useHostMutation<
    HostRpcRegistry,
    "diagnostics.logs.tail",
    undefined,
    void
  >({
    client,
    method: "diagnostics.logs.tail",
    mapVariables: () => ({
      target: "host" as const,
      tailLines: DOCTOR_LOG_TAIL_LINES,
    }),
    options: {
      mutationKey: hostMaintenanceMutationKeys.logsTail(),
      // No arm-time capture: the host-swap rule exists so `onSuccess` /
      // `onError` act on the host the request was ARMED against, and this
      // mutation's callbacks are supplied per `mutate` call and read only the
      // response. A context nothing consumes reads as a guarantee that isn't
      // there.
      onMutate: () => undefined,
    },
  });

  const { mutate: runDoctor } = doctorRun;
  const run = useCallback(() => {
    setLogTail(null);
    runDoctor(undefined, {
      onSuccess: setReport,
      onError: (error) => toastFromHostError(error, "Couldn't run Doctor."),
    });
  }, [runDoctor]);

  // Run once when the sheet mounts. The sheet only mounts this on open, so
  // "opened the sheet" IS the request — but the effect must not re-fire on
  // every render, and `run` changing identity would do exactly that.
  const hasRunRef = useRef(false);
  useEffect(() => {
    if (hasRunRef.current || props.degrade !== null || client === null) return;
    hasRunRef.current = true;
    run();
  }, [run, props.degrade, client]);

  if (props.degrade !== null) {
    return (
      <DoctorMessage>
        {describeOverviewDegrade(props.degrade, hostName)}
      </DoctorMessage>
    );
  }
  // A failed run leaves `report` null forever, and the toast that announced it
  // is gone within seconds - so without this the card sits on "Running Doctor…"
  // for the life of the sheet, spinning at a request that already finished, and
  // offers no way to try again from inside the card.
  // `isError` already excludes pending in the mutation's discriminated state,
  // so testing that too would be dead weight the linter can prove redundant.
  if (report === null && doctorRun.isError) {
    return (
      <div className="space-y-3" data-testid="host-doctor-run-failed">
        <DoctorMessage>
          {`Couldn't run Doctor on ${hostName}. The host may have gone away mid-check.`}
        </DoctorMessage>
        <DoctorRerunRow pending={doctorRun.isPending} onRerun={run} />
      </div>
    );
  }
  if (report === null) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-ui-sm text-muted-foreground">
        <AgentSpinningDots
          className="size-3"
          testId={undefined}
          variant={undefined}
        />
        Running Doctor…
      </div>
    );
  }
  if (report.status !== "ok") {
    return (
      <div className="space-y-3">
        <DoctorMessage>
          {describeCliShellFailure(report.status, hostName)}
        </DoctorMessage>
        <DoctorRerunRow pending={doctorRun.isPending} onRerun={run} />
      </div>
    );
  }

  const split = splitDoctorIssuesByVantage(
    report.issues,
    report.triviallyGreenIssueCodes,
  );

  return (
    <div className="space-y-3">
      <div className="text-ui-sm text-muted-foreground">
        {split.actionable.length === 0
          ? "Doctor: no issues detected."
          : `Diagnostics found ${split.actionable.length} issue${split.actionable.length === 1 ? "" : "s"}.`}
      </div>
      {split.actionable.map((issue) => (
        <DoctorRpcIssueCard
          key={issue.code}
          issue={issue}
          hostName={hostName}
          route={doctorFixRoute({
            fixAction: issue.fixAction ?? "",
            isLocalMachine: props.isLocalMachine,
            hasLocalBridge: props.hasLocalBridge,
          })}
          restartPending={restartMutation.isPending}
          logsPending={logsMutation.isPending}
          localFixPending={props.localFixPendingCode === issue.code}
          logTail={logTail}
          onRestart={() => {
            // Minted when the button is armed and REUSED across every attempt
            // at that same action, including a retry after an ambiguous
            // transport failure. The host adopts a claim it already granted
            // only when the id matches, so a fresh id per attempt turns the
            // idempotent retry this contract exists for into a busy refusal
            // against a claim the host is still holding. Mirrors the Overview
            // panel's confirm path; see `newTransitionId`.
            const transitionId =
              armedFixRestartIdRef.current ?? newTransitionId();
            armedFixRestartIdRef.current = transitionId;
            restartMutation.mutate(
              { transitionId },
              {
                onSuccess: (response) => {
                  // Definitive either way: accepted spends the claim, busy
                  // refuses it outright. The next click is a NEW action.
                  armedFixRestartIdRef.current = null;
                  if (response.outcome === "busy") {
                    toast.message(
                      `Not restarted — ${response.verdict.busySessionCount} session${response.verdict.busySessionCount === 1 ? " is" : "s are"} still working.`,
                    );
                    return;
                  }
                  toast.success(`Restarting ${hostName}`);
                },
                onError: (error) =>
                  toastFromHostError(error, "Couldn't restart this host."),
              },
            );
          }}
          onShowLogs={() => {
            logsMutation.mutate(undefined, {
              onSuccess: (response) => {
                setLogTail(
                  response.status === "available" ? response.lines : [],
                );
              },
              onError: (error) =>
                toastFromHostError(error, "Couldn't read this host's log."),
            });
          }}
          onLocalFix={() => {
            if (issue.fixAction === "host-free-port-and-restart") {
              setFreePortIssue(issue);
              return;
            }
            props.onLocalFix(issue);
          }}
        />
      ))}
      {split.disprovenByTransport.length === 0 ? null : (
        <HostSettingsDisclosure
          label={`${split.disprovenByTransport.length} check${split.disprovenByTransport.length === 1 ? "" : "s"} this connection already answers`}
          defaultOpen={false}
        >
          <div
            className="space-y-2"
            data-testid="host-doctor-disproven-by-transport"
          >
            <p className="text-ui-xs text-muted-foreground">
              Doctor ran on {hostName} and reported these, but the connection
              carrying its report contradicts them — this app is talking to the
              very listener they say is unavailable. Listed for completeness,
              not as something to fix.
            </p>
            {split.disprovenByTransport.map((issue) => (
              <div
                key={issue.code}
                className="rounded-md border border-border/60 bg-muted/20 px-3 py-2"
                data-testid={`host-doctor-disproven-${issue.code}`}
              >
                <div className="font-medium text-ui-sm">{issue.title}</div>
                <div className="text-ui-xs text-muted-foreground">
                  {issue.message}
                </div>
              </div>
            ))}
          </div>
        </HostSettingsDisclosure>
      )}
      <DoctorRerunRow pending={doctorRun.isPending} onRerun={run} />
      <ConfirmDestructiveDialog
        open={freePortIssue !== null}
        onOpenChange={(open) => {
          if (!open) setFreePortIssue(null);
        }}
        title="Free port and restart?"
        description={describeFreePortPrompt(
          freePortIssue === null ? null : parseFreePortInput(freePortIssue),
        )}
        cascadeSummary={null}
        actionLabel="Free port + restart"
        isPending={props.localFixPendingCode === freePortIssue?.code}
        onConfirm={() => {
          if (freePortIssue === null) return;
          props.onLocalFix(freePortIssue);
          setFreePortIssue(null);
        }}
      />
    </div>
  );
}

function DoctorRpcIssueCard(props: {
  readonly issue: HostDoctorIssue;
  readonly hostName: string;
  readonly route: DoctorFixRoute;
  readonly restartPending: boolean;
  readonly logsPending: boolean;
  readonly localFixPending: boolean;
  readonly logTail: readonly string[] | null;
  readonly onRestart: () => void;
  readonly onShowLogs: () => void;
  readonly onLocalFix: () => void;
}): ReactNode {
  const { issue, route } = props;
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={cn(
        "rounded-lg border bg-card/60 p-3",
        severityBorderClass(issue.severity),
      )}
      data-testid={`host-doctor-issue-${issue.code}`}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "mt-1 inline-flex size-5 items-center justify-center rounded-full text-ui-xs font-bold text-background",
            severityBadgeClass(issue.severity),
          )}
        >
          !
        </div>
        <div className="min-w-0 flex-1">
          <div className="break-words font-medium">{issue.title}</div>
          <div className="break-words text-ui-sm text-muted-foreground">
            {issue.message}
          </div>
          {issue.fixAction !== null && route === "copy-command" ? (
            <p
              className="mt-2 text-ui-xs text-muted-foreground"
              data-testid={`host-doctor-run-on-host-${issue.code}`}
            >
              {issue.terminalCommand === null
                ? `This repair has to run on ${props.hostName} itself, and Doctor didn't supply a command for it.`
                : `This repair has to run on ${props.hostName} itself — copy the command and run it there.`}
            </p>
          ) : null}
          <div className="mt-2 flex max-w-full flex-wrap items-center gap-2">
            <DoctorFixControl
              issue={issue}
              route={route}
              restartPending={props.restartPending}
              logsPending={props.logsPending}
              localFixPending={props.localFixPending}
              onRestart={props.onRestart}
              onShowLogs={props.onShowLogs}
              onLocalFix={props.onLocalFix}
            />
            {issue.terminalCommand !== null ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => copyTerminalCommand(issue.terminalCommand ?? "")}
                data-testid={`host-doctor-copy-command-${issue.code}`}
              >
                Copy command
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Hide details" : "Show details"}
            </Button>
          </div>
          {expanded && issue.terminalCommand !== null ? (
            <pre
              data-testid="host-doctor-issue-terminal-command"
              className="mt-2 max-h-40 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-code-xs text-muted-foreground"
            >
              {issue.terminalCommand}
            </pre>
          ) : null}
          {expanded && issue.details !== null ? (
            <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-code-xs text-muted-foreground">
              {JSON.stringify(issue.details, null, 2)}
            </pre>
          ) : null}
          {issue.fixAction === "host-logs" && props.logTail !== null ? (
            <pre
              className="mt-2 max-h-52 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-code-xs text-muted-foreground"
              data-testid="host-doctor-log-tail"
            >
              {props.logTail.length === 0
                ? "This host's log is empty or no longer there."
                : props.logTail.join("\n")}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DoctorFixControl(props: {
  readonly issue: HostDoctorIssue;
  readonly route: DoctorFixRoute;
  readonly restartPending: boolean;
  readonly logsPending: boolean;
  readonly localFixPending: boolean;
  readonly onRestart: () => void;
  readonly onShowLogs: () => void;
  readonly onLocalFix: () => void;
}): ReactNode {
  const { issue, route } = props;
  if (issue.fixAction === null) return null;
  if (route === "copy-command") return null;
  // Three destinations, and the fix action decides which: showing a log is the
  // one RPC route that is not a restart, so it is asked first.
  const isLogs = issue.fixAction === "host-logs";
  const isRpcRestart = !isLogs && route === "rpc";
  let pending = props.localFixPending;
  let onClick = props.onLocalFix;
  if (isLogs) {
    pending = props.logsPending;
    onClick = props.onShowLogs;
  } else if (isRpcRestart) {
    pending = props.restartPending;
    onClick = props.onRestart;
  }
  return (
    <Button
      variant="default"
      size="sm"
      disabled={pending}
      onClick={onClick}
      data-testid={`host-doctor-fix-${issue.code}`}
    >
      {pending ? (
        <AgentSpinningDots
          className="mr-2 size-3"
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      {fixActionLabel(issue.fixAction)}
    </Button>
  );
}

function DoctorRerunRow(props: {
  readonly pending: boolean;
  readonly onRerun: () => void;
}): ReactNode {
  return (
    <div className="flex justify-end">
      <Button
        variant="secondary"
        size="sm"
        disabled={props.pending}
        onClick={props.onRerun}
        data-testid="host-doctor-rerun"
      >
        {props.pending ? (
          <AgentSpinningDots
            className="mr-2 size-3"
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Re-run Doctor
      </Button>
    </div>
  );
}

function DoctorMessage(props: { readonly children: ReactNode }): ReactNode {
  return (
    <div
      className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-ui-sm text-muted-foreground"
      data-testid="host-doctor-message"
    >
      {props.children}
    </div>
  );
}
