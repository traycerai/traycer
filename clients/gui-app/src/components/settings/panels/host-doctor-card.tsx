import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  INITIAL_RECURRENCE_STATE,
  type RecurrenceState,
} from "@/components/settings/panels/host-doctor-recurrence";
import { HostDoctorReportContent } from "@/components/settings/panels/host-doctor-report-content";
import {
  RECURRENCE_THRESHOLD,
  RECURRENCE_WINDOW_MS,
} from "@/components/settings/panels/host-doctor-model";
import {
  fixActionLabel,
  parseFreePortInput,
  runFixAction,
  type FixActionResult,
} from "@/components/settings/panels/host-doctor-actions";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
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
import type {
  HostDoctorIssue,
  HostDoctorReport,
  FreePortAndRestartInput,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

export interface HostDoctorCardProps {
  readonly recurrenceState?: RecurrenceState;
  readonly onRecurrenceChange?: (next: RecurrenceState) => void;
  /**
   * The local host this console is recovering. Its fixes run THIS machine's
   * CLI, so they carry the id for the same reason every other bridge call
   * does - the console outlives the host it names, and a replaced host must
   * not inherit the repairs (or the log) aimed at its predecessor.
   */
  readonly expectedHostId: string;
}

export function HostDoctorCard(props: HostDoctorCardProps) {
  const runnerHost = useRunnerHost();
  const management = runnerHost.hostManagement;
  if (management === null) {
    return null;
  }
  return (
    <HostDoctorCardInner
      management={management}
      expectedHostId={props.expectedHostId}
      externalRecurrence={props.recurrenceState}
      onExternalRecurrenceChange={props.onRecurrenceChange}
    />
  );
}

interface HostDoctorCardInnerProps {
  readonly management: IHostManagement;
  readonly expectedHostId: string;
  readonly externalRecurrence: RecurrenceState | undefined;
  readonly onExternalRecurrenceChange:
    | ((next: RecurrenceState) => void)
    | undefined;
}

function HostDoctorCardInner(props: HostDoctorCardInnerProps) {
  const {
    management,
    expectedHostId,
    externalRecurrence,
    onExternalRecurrenceChange,
  } = props;
  const queryClient = useQueryClient();
  const recurrenceModel = useDoctorRecurrence({
    externalRecurrence,
    onExternalRecurrenceChange,
  });
  const [expandedCodes, setExpandedCodes] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [freePortPrompt, setFreePortPrompt] =
    useState<FreePortAndRestartInput | null>(null);

  const {
    data: report,
    isPending: reportPending,
    isFetching: reportFetching,
    error: reportError,
    refetch: refetchReport,
  } = useQuery(
    queryOptions<HostDoctorReport>({
      queryKey: runnerQueryKeys.hostDoctor(management, expectedHostId),
      queryFn: () => management.runDoctor({ expectedHostId }),
    }),
  );

  const fixMutation = useMutation<
    FixActionResult,
    Error,
    HostDoctorIssue,
    { readonly management: IHostManagement }
  >({
    mutationKey: runnerMutationKeys.hostRunDoctor(),
    onMutate: () => ({ management }),
    mutationFn: async (issue) => {
      if (issue.fixAction === null) return { kind: "applied" };
      return runFixAction(management, issue, expectedHostId);
    },
    onSuccess: (result, issue, context) => {
      // A declined fix is neither applied nor failed: it did not run for a
      // self-clearing reason (the host was busy, a lock was held, or this
      // machine's host is no longer the one this console opened on).
      // Announce it as information and leave the recurrence model alone.
      //
      // WHICH action was refused decides the wording, for the same reason it
      // does on the watched sheet: now that the lifecycle repairs are fenced,
      // an Install host or Register service click can decline too, and
      // reporting either as "Host not restarted" names an action nobody
      // asked for.
      if (result.kind === "declined") {
        const fixAction = issue.fixAction;
        if (fixAction === "host-start" || fixAction === "host-restart") {
          toastHostRestartDeclined(result.message);
          return;
        }
        toastHostRepairDeclined(
          fixActionLabel(fixAction ?? ""),
          result.message,
        );
        return;
      }
      toast.success("Fix applied");
      recurrenceModel.setRecurrence({ failures: [], locked: false });
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostDoctor(
          context.management,
          expectedHostId,
        ),
      });
    },
    onError: (err, issue) => {
      toastFromRunnerError(err, "Fix failed");
      recurrenceModel.setRecurrence((prev) =>
        nextFailedRecurrence(prev, issue.code),
      );
    },
  });

  const freePortMutation = useMutation<
    FreePortAndRestartInput,
    Error,
    FreePortAndRestartInput,
    { readonly management: IHostManagement }
  >({
    mutationKey: runnerMutationKeys.hostFreePortAndRestart(),
    onMutate: () => ({ management }),
    mutationFn: (input) =>
      management.freePortAndRestart({ ...input, expectedHostId }),
    onSuccess: (_data, _input, context) => {
      toast.success("Restarted with port freed");
      setFreePortPrompt(null);
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostDoctor(
          context.management,
          expectedHostId,
        ),
      });
    },
    onError: (err) => toastFromRunnerError(err, "Couldn't free port"),
  });

  const handleRerun = useCallback(() => {
    recurrenceModel.setRecurrence({ failures: [], locked: false });
    void refetchReport();
  }, [refetchReport, recurrenceModel]);

  const { mutate: mutateFix } = fixMutation;
  const handleFix = useCallback(
    (issue: HostDoctorIssue) => {
      if (recurrenceModel.recurrence.locked) {
        reportableErrorToast(
          "Doctor paused after 3 failed fixes. Click Re-run Doctor to retry.",
          undefined,
          {
            title: "Host Doctor paused",
            message: "Host Doctor paused after repeated failed fixes.",
            code: null,
            source: "Host Doctor",
          },
        );
        return;
      }
      const freePortInput = freePortPromptFromIssue(issue);
      if (freePortInput !== undefined) {
        setFreePortPrompt(freePortInput);
        return;
      }
      mutateFix(issue);
    },
    [mutateFix, recurrenceModel.recurrence.locked],
  );

  const handleToggleIssue = useCallback((code: string) => {
    setExpandedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
      }
      return next;
    });
  }, []);

  const issues = useMemo<readonly HostDoctorIssue[]>(
    () => report?.issues ?? [],
    [report?.issues],
  );

  if (reportPending) {
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

  // A report that FAILED is not a report with no issues. Without this arm the
  // `issues ?? []` default below renders "no issues detected" for a read that
  // never produced one — an identity refusal, a CLI that could not run — which
  // is the most dangerous thing this card could say.
  if (reportError !== null) {
    return (
      <div className="space-y-2">
        <div className="rounded-md border border-rose-700/40 bg-rose-900/20 px-3 py-2 text-ui-sm text-rose-200">
          Doctor could not run: {reportError.message}
        </div>
        {/* The retry belongs on THIS arm above all others. The commonest way
            to land here is a momentary identity refusal, whose own message
            says "try again in a moment" — an arm that says that while
            offering no way to try again forces the sheet closed and reopened
            to do what the text just asked for.

            It carries no pending state, and that is not an oversight. This
            report is a QUERY, and v5 clears the error when a refetch starts;
            with no data to fall back on the status returns to `pending`, so
            the click unmounts this whole arm and the spinner above becomes
            the in-flight surface. A `disabled={reportFetching}` here could
            never render — the button is gone by the time it would be true.
            The RPC card's rerun row DOES take a pending flag because its run
            is a mutation, whose pending state no arm swap can hide. */}
        <div className="flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRerun}
            data-testid="host-doctor-rerun"
          >
            Re-run Doctor
          </Button>
        </div>
      </div>
    );
  }

  if (issues.length === 0) {
    return (
      <div className="rounded-md border border-emerald-700/40 bg-emerald-900/20 px-3 py-2 text-ui-sm text-emerald-200">
        Doctor: no issues detected.
      </div>
    );
  }

  return (
    <HostDoctorReportContent
      issues={issues}
      expandedCodes={expandedCodes}
      recurrence={recurrenceModel.recurrence}
      reportFetching={reportFetching}
      fixPendingCode={fixMutation.isPending ? fixMutation.variables.code : null}
      freePortPrompt={freePortPrompt}
      freePortPending={freePortMutation.isPending}
      onFix={handleFix}
      onToggleIssue={handleToggleIssue}
      onRerun={handleRerun}
      onFreePortOpenChange={(open) => {
        if (!open) setFreePortPrompt(null);
      }}
      onConfirmFreePort={() => {
        if (freePortPrompt !== null) {
          freePortMutation.mutate(freePortPrompt);
        }
      }}
    />
  );
}

interface DoctorRecurrenceInput {
  readonly externalRecurrence: RecurrenceState | undefined;
  readonly onExternalRecurrenceChange:
    | ((next: RecurrenceState) => void)
    | undefined;
}

function useDoctorRecurrence(input: DoctorRecurrenceInput) {
  const { externalRecurrence, onExternalRecurrenceChange } = input;
  const [localRecurrence, setLocalRecurrence] = useState<RecurrenceState>(
    INITIAL_RECURRENCE_STATE,
  );
  const usingExternalRecurrence =
    externalRecurrence !== undefined &&
    onExternalRecurrenceChange !== undefined;
  const recurrence: RecurrenceState = usingExternalRecurrence
    ? externalRecurrence
    : localRecurrence;
  const latestRef = useRef({
    recurrence,
    usingExternal: usingExternalRecurrence,
    onExternalChange: onExternalRecurrenceChange,
  });
  useEffect(() => {
    latestRef.current = {
      recurrence,
      usingExternal: usingExternalRecurrence,
      onExternalChange: onExternalRecurrenceChange,
    };
  });
  const setRecurrence = useCallback(
    (
      updater: RecurrenceState | ((prev: RecurrenceState) => RecurrenceState),
    ): void => {
      const snapshot = latestRef.current;
      const next =
        typeof updater === "function" ? updater(snapshot.recurrence) : updater;
      if (snapshot.usingExternal && snapshot.onExternalChange !== undefined) {
        snapshot.onExternalChange(next);
      } else {
        setLocalRecurrence(next);
      }
    },
    [],
  );
  return useMemo(
    () => ({ recurrence, setRecurrence }),
    [recurrence, setRecurrence],
  );
}

function nextFailedRecurrence(
  prev: RecurrenceState,
  code: string,
): RecurrenceState {
  const now = Date.now();
  const within = prev.failures.filter(
    (entry) => now - entry.at < RECURRENCE_WINDOW_MS,
  );
  const next = [...within, { at: now, code }].slice(
    -(RECURRENCE_THRESHOLD + 1),
  );
  return {
    failures: next,
    locked: next.length >= RECURRENCE_THRESHOLD,
  };
}

function freePortPromptFromIssue(
  issue: HostDoctorIssue,
): FreePortAndRestartInput | undefined {
  if (issue.fixAction !== "host-free-port-and-restart") return undefined;
  return parseFreePortInput(issue) ?? undefined;
}
