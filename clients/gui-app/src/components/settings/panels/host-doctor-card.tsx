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
  parseFreePortInput,
  runFixAction,
} from "@/components/settings/panels/host-doctor-actions";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";
import type {
  HostDoctorIssue,
  HostDoctorReport,
  FreePortAndRestartInput,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";

export interface HostDoctorCardProps {
  readonly recurrenceState?: RecurrenceState;
  readonly onRecurrenceChange?: (next: RecurrenceState) => void;
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
      externalRecurrence={props.recurrenceState}
      onExternalRecurrenceChange={props.onRecurrenceChange}
    />
  );
}

interface HostDoctorCardInnerProps {
  readonly management: IHostManagement;
  readonly externalRecurrence: RecurrenceState | undefined;
  readonly onExternalRecurrenceChange:
    ((next: RecurrenceState) => void) | undefined;
}

function HostDoctorCardInner(props: HostDoctorCardInnerProps) {
  const { management, externalRecurrence, onExternalRecurrenceChange } = props;
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
    refetch: refetchReport,
  } = useQuery(
    queryOptions<HostDoctorReport>({
      queryKey: runnerQueryKeys.hostDoctor(management),
      queryFn: () => management.runDoctor(),
    }),
  );

  const fixMutation = useMutation<
    void,
    Error,
    HostDoctorIssue,
    { readonly management: IHostManagement }
  >({
    mutationKey: runnerMutationKeys.hostRunDoctor(),
    onMutate: () => ({ management }),
    mutationFn: async (issue) => {
      if (issue.fixAction === null) return;
      await runFixAction(management, issue);
    },
    onSuccess: (_data, _issue, context) => {
      toast.success("Fix applied");
      recurrenceModel.setRecurrence({ failures: [], locked: false });
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostDoctor(context.management),
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
    mutationFn: (input) => management.freePortAndRestart(input),
    onSuccess: (_data, _input, context) => {
      toast.success("Restarted with port freed");
      setFreePortPrompt(null);
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostDoctor(context.management),
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
        toast.error(
          "Doctor paused after 3 failed fixes. Click Re-run Doctor to retry.",
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
    ((next: RecurrenceState) => void) | undefined;
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
