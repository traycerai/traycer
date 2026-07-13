import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bug } from "lucide-react";
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
import type { DesktopSupportSnapshot } from "@/lib/windows/types";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type { DesktopSupportDialogProps } from "./types";

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
  const closeReportIssueDraft = useDesktopDialogStore(
    (state) => state.closeReportIssueDraft,
  );
  const [form, setForm] = useState<ReportIssueForm>(() =>
    reportIssueFormFromContext(context),
  );
  const [snapshot, setSnapshot] = useState<DesktopSupportSnapshot | null>(null);
  const submitErrorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || support === null) return;
    void support.getSnapshot().then(setSnapshot, () => null);
  }, [open, support]);

  const submitMutation = useMutation({
    mutationKey: runnerMutationKeys.supportSubmitReport(),
    mutationFn: async (submission: ReportIssueSubmission) => {
      if (support === null) throw new Error("Support bridge unavailable");
      const result = await support.submitReport(submission.form);
      return result.reportId;
    },
    onSuccess: (reportId, submission) => {
      const url = buildSupportIssueUrl(
        submission.snapshot,
        submission.form,
        reportId,
      );
      void runnerHost.openExternalLink(url);
      closeReportIssueDraft(submission.draftId);
    },
  });

  useEffect(() => {
    if (!submitMutation.isError) return;
    submitErrorRef.current?.focus();
  }, [submitMutation.isError]);

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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,48rem)] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug className="size-4" />
            Report an Issue
          </DialogTitle>
          <DialogDescription>
            Your report is uploaded privately so the team can diagnose it. A
            pre-filled GitHub issue will open after submitting.
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

        {submitMutation.isError ? (
          <div
            ref={submitErrorRef}
            role="alert"
            tabIndex={-1}
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-ui-sm text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Failed to submit report. Please try again.
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => submitMutation.mutate({ draftId, form, snapshot })}
            disabled={
              submitMutation.isPending || form.title.trim().length === 0
            }
          >
            {submitMutation.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Submit Report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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

function buildSupportIssueUrl(
  snapshot: DesktopSupportSnapshot | null,
  form: ReportIssueForm,
  reportId: string,
): string {
  return buildGitHubIssueUrl({
    ...supportSnapshotIssueFields(snapshot),
    title: form.title,
    whatHappened: form.whatHappened,
    stepsToReproduce: form.stepsToReproduce,
    expectedBehavior: form.expectedBehavior,
    actualBehavior: form.actualBehavior,
    reportId,
  });
}

function supportSnapshotIssueFields(snapshot: DesktopSupportSnapshot | null) {
  return {
    appVersion: snapshot?.appVersion ?? "unknown",
    platform: snapshot?.platform ?? "unknown",
    arch: snapshot?.arch ?? "unknown",
    ...supportRuntimeIssueFields(snapshot),
    ...supportHostIssueFields(snapshot),
  };
}

function supportRuntimeIssueFields(snapshot: DesktopSupportSnapshot | null) {
  return {
    electronVersion: snapshot?.versions.electron ?? null,
    chromeVersion: snapshot?.versions.chrome ?? null,
    nodeVersion: snapshot?.versions.node ?? null,
  };
}

function supportHostIssueFields(snapshot: DesktopSupportSnapshot | null) {
  return {
    hostVersion: snapshot?.host.version ?? null,
    hostStatus: snapshot?.host.status ?? null,
    hostPid: snapshot?.host.pid ?? null,
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
