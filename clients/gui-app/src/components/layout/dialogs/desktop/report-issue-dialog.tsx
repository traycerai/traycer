import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bug } from "lucide-react";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";
import { buildGitHubIssueUrl } from "@traycer-clients/shared/support/issue-reporter";
import { runnerMutationKeys } from "@/lib/query-keys";
import type { ReportIssueContext } from "@/lib/report-issue-context";
import {
  serializeReportIssuePrivateDiagnostics,
  type ReportIssueDraftContext,
} from "@/lib/report-issue-draft-context";
import type {
  DesktopReportIssueForm,
  DesktopSubmitReportResult,
  DesktopSupportSnapshot,
} from "@/lib/windows/types";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type { DesktopSupportDialogProps } from "./types";
import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
  reportIssuePrivateSubmitPropertiesFromResult,
} from "@/lib/analytics";

interface ReportIssueForm {
  title: string;
  whatHappened: string;
  stepsToReproduce: string;
  expectedBehavior: string;
  actualBehavior: string;
}

interface ReportIssueSubmission {
  readonly draftId: number;
  readonly form: ReportIssueForm;
  readonly snapshot: DesktopSupportSnapshot | null;
}

const EMPTY_FORM: ReportIssueForm = {
  title: "",
  whatHappened: "",
  stepsToReproduce: "",
  expectedBehavior: "",
  actualBehavior: "",
};

export function ReportIssueDialog(
  props: DesktopSupportDialogProps & { readonly draftId: number },
): ReactNode {
  const { draftId, onOpenChange, open, support } = props;
  const runnerHost = useRunnerHost();
  const context = useDesktopDialogStore((state) => state.reportIssueContext);
  const draftContext = useDesktopDialogStore(
    (state) => state.reportIssueDraftContext,
  );
  const closeReportIssueDraft = useDesktopDialogStore(
    (state) => state.closeReportIssueDraft,
  );
  const [form, setForm] = useState<ReportIssueForm>(() =>
    reportIssueFormFromContext(context),
  );
  const [snapshot, setSnapshot] = useState<DesktopSupportSnapshot | null>(null);
  // Minted once at report-open (T2/T3) and reused by every retry as the
  // Sentry idempotency key. Null until the freeze IPC resolves; submit stays
  // disabled until then so it can never race ahead of the frozen evidence.
  const [reportId, setReportId] = useState<string | null>(null);
  const submitErrorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (support === null) return;
    // Fingerprint (when present) records an install-local sighting on first
    // freeze admission - powers "Nth time on this install". Null for manual
    // opens with no error envelope. Read of the occurrence is ticket 07's
    // evidence strip; the write path lands here so a freeze without a later
    // dialog redesign still advances the ledger.
    const fingerprint = draftContext?.privateDiagnostics.fingerprint ?? null;
    void support.freezeEvidence({ draftId, fingerprint }).then(
      (result) => setReportId(result.reportId),
      () => null,
    );
    return () => {
      void support.discardFrozenEvidence(draftId).catch(() => null);
    };
    // draftId is this component's identity for its whole mounted lifetime -
    // the host remounts it under a fresh `key` per draft, so this effect
    // only ever re-runs here if `support` itself changes identity.
    // draftContext is captured at open and is immutable for the draft's life.
  }, [draftId, support, draftContext]);

  useEffect(() => {
    if (!open || support === null) return;
    void support.getSnapshot().then(setSnapshot, () => null);
  }, [open, support]);

  const submitMutation = useMutation({
    mutationKey: runnerMutationKeys.supportSubmitReport(),
    mutationFn: async (
      submission: ReportIssueSubmission,
    ): Promise<DesktopSubmitReportResult> => {
      if (support === null) throw new Error("Support bridge unavailable");
      return support.submitReport(
        buildReportIssueFormRequest(submission, draftContext),
      );
    },
    onSuccess: async (result, submission) => {
      Analytics.getInstance().track(
        AnalyticsEvent.ReportIssuePrivateSubmit,
        reportIssuePrivateSubmitPropertiesFromResult(result),
      );
      // unconfirmed/unavailable/failed keep the dialog open with an honest
      // banner (see DeliveryOutcomeBanner) instead of the GitHub hand-off -
      // only a confirmed delivery is terminal here.
      if (result.status !== "delivered") return;
      await openPublicDraftInBrowser(submission);
      closeReportIssueDraft(submission.draftId);
    },
    onError: (error) => {
      Analytics.getInstance().track(AnalyticsEvent.ReportIssuePrivateSubmit, {
        outcome: "failed",
        blocker: analyticsBlockerFromError(error),
      });
    },
  });

  const saveDiagnosticBundleMutation = useMutation({
    mutationKey: runnerMutationKeys.supportSaveDiagnosticBundle(),
    mutationFn: async (submission: ReportIssueSubmission) => {
      if (support === null) throw new Error("Support bridge unavailable");
      return support.saveDiagnosticBundle({
        draftId: submission.draftId,
        ...submission.form,
      });
    },
    onSuccess: () => {
      toast.success("Diagnostic bundle saved", {
        description:
          "It's been revealed in your file browser. Review it before sharing publicly - it contains no logs yet.",
      });
    },
    onError: () => {
      toast.error("Could not save the diagnostic bundle");
    },
  });

  const deliveryResult = submitMutation.isSuccess ? submitMutation.data : null;
  // Known unavailable up front (DSN presence is known at startup) synthesizes
  // the same terminal state a submit attempt would eventually reach, so the
  // dialog can state it and offer the two honest actions before the user
  // invests any effort - never a submit round-trip whose only possible
  // outcome is "unavailable".
  const effectiveDeliveryResult: DesktopSubmitReportResult | null =
    deliveryResult ??
    (snapshot !== null && !snapshot.privateDeliveryAvailable
      ? { status: "unavailable" }
      : null);
  // Deliberately keyed off the real `deliveryResult`, not the synthesized
  // `effectiveDeliveryResult`: the upfront unavailable case already gets its
  // own copy in the description below, and repeating it in an alert-styled
  // banner would be redundant, not honest-er.
  const showsHonestBanner =
    submitMutation.isError ||
    (deliveryResult !== null && deliveryResult.status !== "delivered");

  useEffect(() => {
    if (!showsHonestBanner) return;
    submitErrorRef.current?.focus();
  }, [showsHonestBanner]);

  const handleOpenChange = (open: boolean) => {
    if (!open && submitMutation.isPending) return;
    if (!open) {
      setForm(EMPTY_FORM);
      setSnapshot(null);
    }
    onOpenChange(open);
  };

  const update =
    (field: keyof ReportIssueForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const retry = () => submitMutation.mutate({ draftId, form, snapshot });

  // Sole call site for `support:buildPublicDraft` (ticket 09 / T6) - the
  // terminal-delivered hand-off and every fallback ("Report on GitHub
  // instead", "Open a GitHub issue") route through here, so no path in this
  // dialog can produce a public URL except via the main-process scrub
  // boundary. `buildGitHubIssueUrl` is a pure field-to-URL assembler; every
  // text transform already happened server-side.
  const openPublicDraftInBrowser = async (
    submission: ReportIssueSubmission,
  ): Promise<void> => {
    if (support === null) return;
    const draft = await support
      .buildPublicDraft(buildReportIssueFormRequest(submission, draftContext))
      .catch(() => null);
    if (draft === null) return;
    const url = buildGitHubIssueUrl(draft);
    // openExternalLink is Promise<void> across the shared contract; the
    // underlying open success boolean is not available here. Emit
    // "attempted" after the await only - never claim GitHub publication.
    try {
      await runnerHost.openExternalLink(url);
    } catch {
      // Browser open can fail; the attempt still happened and is tracked.
    }
    Analytics.getInstance().track(
      AnalyticsEvent.ReportIssuePublicOpenAttempted,
      null,
    );
  };
  const openGithubFallback = (): Promise<void> =>
    openPublicDraftInBrowser({ draftId, form, snapshot });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,48rem)] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug className="size-4" />
            Report an Issue
          </DialogTitle>
          <DialogDescription>
            {effectiveDeliveryResult?.status === "unavailable"
              ? "Private reporting is not available in this build. You can save a diagnostic bundle and open a GitHub issue instead."
              : "Your report is uploaded privately so the team can diagnose it. A pre-filled GitHub issue will open after submitting."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          <div className="grid gap-4 py-1 pr-1">
            {snapshot !== null && <EnvBadge snapshot={snapshot} />}

            <Field htmlFor="report-issue-title" label="Title" required>
              <Input
                id="report-issue-title"
                placeholder="Short summary of the issue"
                value={form.title}
                onChange={update("title")}
                disabled={submitMutation.isPending}
              />
            </Field>

            <Field htmlFor="report-issue-what-happened" label="What happened?">
              <Textarea
                id="report-issue-what-happened"
                placeholder="A clear description of the bug. Include any error messages you saw."
                value={form.whatHappened}
                onChange={update("whatHappened")}
                disabled={submitMutation.isPending}
                className="min-h-20 resize-none"
              />
            </Field>

            <Field
              htmlFor="report-issue-steps-to-reproduce"
              label="Steps to reproduce"
            >
              <Textarea
                id="report-issue-steps-to-reproduce"
                placeholder={"1.\n2.\n3."}
                value={form.stepsToReproduce}
                onChange={update("stepsToReproduce")}
                disabled={submitMutation.isPending}
                className="min-h-20 resize-none"
              />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field
                htmlFor="report-issue-expected-behavior"
                label="Expected behavior"
              >
                <Textarea
                  id="report-issue-expected-behavior"
                  placeholder="What did you expect to happen?"
                  value={form.expectedBehavior}
                  onChange={update("expectedBehavior")}
                  disabled={submitMutation.isPending}
                  className="min-h-20 resize-none"
                />
              </Field>
              <Field
                htmlFor="report-issue-actual-behavior"
                label="Actual behavior"
              >
                <Textarea
                  id="report-issue-actual-behavior"
                  placeholder="What actually happened instead?"
                  value={form.actualBehavior}
                  onChange={update("actualBehavior")}
                  disabled={submitMutation.isPending}
                  className="min-h-20 resize-none"
                />
              </Field>
            </div>

            {snapshot !== null && snapshot.logs.length > 0 && <LogPathsInfo />}
          </div>
        </div>

        {showsHonestBanner ? (
          <div
            ref={submitErrorRef}
            role="alert"
            tabIndex={-1}
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-ui-sm text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {submitMutation.isError
              ? "Failed to submit report. Please try again."
              : deliveryOutcomeMessage(deliveryResult)}
          </div>
        ) : null}

        <DialogFooter className="flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitMutation.isPending}
          >
            Cancel
          </Button>
          <ReportIssueFooterActions
            deliveryResult={effectiveDeliveryResult}
            canSubmit={form.title.trim().length !== 0 && reportId !== null}
            isSubmitPending={submitMutation.isPending}
            isSaveBundlePending={saveDiagnosticBundleMutation.isPending}
            onSubmitOrRetry={retry}
            onOpenGithubFallback={() => void openGithubFallback()}
            onSaveDiagnosticBundle={() =>
              saveDiagnosticBundleMutation.mutate({ draftId, form, snapshot })
            }
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReportIssueFooterActions({
  deliveryResult,
  canSubmit,
  isSubmitPending,
  isSaveBundlePending,
  onSubmitOrRetry,
  onOpenGithubFallback,
  onSaveDiagnosticBundle,
}: {
  readonly deliveryResult: DesktopSubmitReportResult | null;
  readonly canSubmit: boolean;
  readonly isSubmitPending: boolean;
  readonly isSaveBundlePending: boolean;
  readonly onSubmitOrRetry: () => void;
  readonly onOpenGithubFallback: () => void;
  readonly onSaveDiagnosticBundle: () => void;
}): ReactNode {
  if (deliveryResult?.status === "unavailable") {
    return (
      <>
        <Button
          variant="outline"
          onClick={onSaveDiagnosticBundle}
          disabled={isSaveBundlePending}
        >
          {isSaveBundlePending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Save diagnostic bundle
        </Button>
        <Button onClick={onOpenGithubFallback}>Open a GitHub issue</Button>
      </>
    );
  }
  if (deliveryResult !== null && deliveryResult.status !== "delivered") {
    return (
      <>
        <Button variant="outline" onClick={onOpenGithubFallback}>
          Report on GitHub instead
        </Button>
        <Button onClick={onSubmitOrRetry} disabled={isSubmitPending}>
          {isSubmitPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Try again
        </Button>
      </>
    );
  }
  return (
    <Button onClick={onSubmitOrRetry} disabled={isSubmitPending || !canSubmit}>
      {isSubmitPending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      Submit Report
    </Button>
  );
}

function deliveryOutcomeMessage(
  result: DesktopSubmitReportResult | null,
): string {
  if (result?.status === "unconfirmed") {
    return "We could not confirm your report was uploaded - it may have arrived. Trying again is safe; it reuses the same report ID.";
  }
  if (result?.status === "unavailable") {
    return "Private reporting is not available in this build. You can save a diagnostic bundle and open a GitHub issue instead.";
  }
  return "Your report could not be sent. Nothing was lost - it is still here.";
}

function reportIssueFormFromContext(
  context: ReportIssueContext | null,
): ReportIssueForm {
  if (context === null) return EMPTY_FORM;
  const contextLines = [
    context.source === null ? null : `Area: ${context.source}`,
    context.code === null ? null : `Error code: ${context.code}`,
    context.message,
  ].filter((line): line is string => line !== null);
  return {
    ...EMPTY_FORM,
    title: context.title,
    whatHappened: contextLines.join("\n\n"),
  };
}

// Shared by `submitReport` and `buildPublicDraft`: both take the identical
// wire shape (draftId + the five public fields + optional privateDiagnostics)
// - see `SupportSubmitReportRequest` (`ipc-contracts/window-types.ts`).
function buildReportIssueFormRequest(
  submission: ReportIssueSubmission,
  draftContext: ReportIssueDraftContext | null,
): DesktopReportIssueForm {
  return {
    draftId: submission.draftId,
    ...submission.form,
    ...(draftContext === null
      ? {}
      : {
          privateDiagnostics: serializeReportIssuePrivateDiagnostics(
            draftContext.privateDiagnostics,
          ),
        }),
  };
}

function Field({
  htmlFor,
  label,
  required,
  children,
}: {
  htmlFor: string;
  label: string;
  required?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="grid gap-1.5">
      <Label
        htmlFor={htmlFor}
        className={cn(
          "text-ui-sm",
          required && "after:ml-0.5 after:text-destructive after:content-['*']",
        )}
      >
        {label}
      </Label>
      {children}
    </div>
  );
}

function EnvBadge({
  snapshot,
}: {
  snapshot: DesktopSupportSnapshot;
}): ReactNode {
  const parts = [
    `v${snapshot.appVersion}`,
    `${snapshot.platform} ${snapshot.arch}`,
    snapshot.host.version !== null ? `host ${snapshot.host.version}` : null,
  ].filter((p) => p !== null);

  return (
    <p className="font-mono text-code-xs text-muted-foreground">
      {parts.join(" · ")}
    </p>
  );
}

function LogPathsInfo(): ReactNode {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5">
      <p className="flex items-start gap-1 text-ui-xs font-medium text-muted-foreground">
        <span className="shrink-0 text-destructive">*</span>
        Log files are shared privately with your report.
      </p>
    </div>
  );
}
