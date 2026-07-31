import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Bug } from "lucide-react";
import { toast } from "sonner";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
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
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { CopyTextButton } from "@/components/copy-text-button";
import { cn } from "@/lib/utils";
import { buildGitHubIssueUrl } from "@traycer-clients/shared/support/issue-reporter";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import {
  serializeReportIssuePrivateDiagnostics,
  type ReportIssueDraftContext,
} from "@/lib/report-issue-draft-context";
import type {
  DesktopCapturedField,
  DesktopFingerprintOccurrence,
  DesktopReportFrequency,
  DesktopReportIssueForm,
  DesktopReportType,
  DesktopSubmitReportResult,
  DesktopSupportBuildPublicDraftResult,
  DesktopSupportLogTarget,
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

type ReportIssueScreen = "capture" | "confirmed" | "preview";

const CURRENT_LOCATION_VALUE = "__current__";
const LOCATION_OPTIONS = [
  "Chat",
  "Terminal",
  "Epic canvas",
  "Settings",
  "Command palette",
  "Something else",
] as const;

const TYPE_OPTIONS: ReadonlyArray<{
  readonly value: DesktopReportType;
  readonly label: string;
}> = [
  { value: "bug", label: "Bug" },
  { value: "idea", label: "Idea" },
  { value: "other", label: "Something else" },
];

const FREQUENCY_OPTIONS: ReadonlyArray<{
  readonly value: DesktopReportFrequency;
  readonly label: string;
}> = [
  { value: "once", label: "Once" },
  { value: "sometimes", label: "Sometimes" },
  { value: "every_time", label: "Every time" },
  { value: "not_sure", label: "Not sure" },
];

interface ReportIssueFormState {
  readonly type: DesktopReportType;
  readonly intent: string;
  readonly frequency: DesktopReportFrequency | null;
  readonly locationValue: string;
  readonly locationChanged: boolean;
  readonly allowContact: boolean;
  readonly includeDesktopLog: boolean;
  readonly includeHostLog: boolean;
  readonly includeDiagnostics: boolean;
}

const INITIAL_FORM_STATE: ReportIssueFormState = {
  type: "bug",
  intent: "",
  frequency: null,
  locationValue: CURRENT_LOCATION_VALUE,
  locationChanged: false,
  allowContact: false,
  includeDesktopLog: true,
  includeHostLog: true,
  includeDiagnostics: true,
};

function errorEnvelopeFromContext(
  draftContext: ReportIssueDraftContext | null,
): {
  readonly cause: ReportIssueDraftContext["privateDiagnostics"]["cause"];
  readonly fingerprint: string | null;
  readonly hasErrorEnvelope: boolean;
} {
  const cause = draftContext?.privateDiagnostics.cause ?? null;
  const fingerprint = draftContext?.privateDiagnostics.fingerprint ?? null;
  return {
    cause,
    fingerprint,
    hasErrorEnvelope: cause !== null || fingerprint !== null,
  };
}

interface ReportIssueDerivedFlags {
  readonly deliveryResult: DesktopSubmitReportResult | null;
  readonly effectiveDeliveryResult: DesktopSubmitReportResult | null;
  readonly showsHonestBanner: boolean;
  readonly gateSatisfied: boolean;
  readonly showGateError: boolean;
  readonly showFrequencyChips: boolean;
  readonly showLocationSelector: boolean;
  readonly contactCheckboxVisible: boolean;
  readonly isDeliveryUnavailable: boolean;
}

// Consolidates every UI-gating boolean derived from render state into one
// call so `ReportIssueDialog` itself stays a thin orchestrator - splitting
// these into a dozen separate `&&`/`||`/`?:` consts inline pushed its own
// cyclomatic complexity well past the repo's lint budget.
interface ReportIssueDeliveryFlags {
  readonly deliveryResult: DesktopSubmitReportResult | null;
  readonly effectiveDeliveryResult: DesktopSubmitReportResult | null;
  readonly showsHonestBanner: boolean;
  readonly isDeliveryUnavailable: boolean;
}

function deriveDeliveryFlags(input: {
  readonly snapshot: DesktopSupportSnapshot | null;
  readonly submitIsSuccess: boolean;
  readonly submitData: DesktopSubmitReportResult | undefined;
  readonly submitIsError: boolean;
}): ReportIssueDeliveryFlags {
  const deliveryResult = input.submitIsSuccess
    ? (input.submitData ?? null)
    : null;
  const deliveryUnavailableUpfront =
    input.snapshot !== null && !input.snapshot.privateDeliveryAvailable;
  // Known unavailable up front (DSN presence is known at startup) synthesizes
  // the same terminal state a submit attempt would eventually reach, so the
  // dialog can state it and offer the two honest actions before the user
  // invests any effort.
  const effectiveDeliveryResult: DesktopSubmitReportResult | null =
    deliveryResult ??
    (deliveryUnavailableUpfront ? { status: "unavailable" } : null);
  const deliveredAlready = deliveryResult?.status === "delivered";
  const showsHonestBanner =
    input.submitIsError || (deliveryResult !== null && !deliveredAlready);
  return {
    deliveryResult,
    effectiveDeliveryResult,
    showsHonestBanner,
    isDeliveryUnavailable: effectiveDeliveryResult?.status === "unavailable",
  };
}

interface ReportIssueGateFlags {
  readonly gateSatisfied: boolean;
  readonly showGateError: boolean;
  readonly showFrequencyChips: boolean;
  readonly showLocationSelector: boolean;
}

function deriveGateFlags(input: {
  readonly hasErrorEnvelope: boolean;
  readonly form: ReportIssueFormState;
  readonly gateErrorVisible: boolean;
  readonly occurrence: DesktopFingerprintOccurrence | null;
}): ReportIssueGateFlags {
  const gateApplies = !input.hasErrorEnvelope;
  const locationSatisfiesGate =
    input.form.type === "bug" && input.form.locationChanged;
  const intentSatisfiesGate = input.form.intent.trim().length > 0;
  const gateSatisfied =
    !gateApplies || intentSatisfiesGate || locationSatisfiesGate;
  const occurrenceIsRepeat =
    input.occurrence !== null && input.occurrence.count > 1;
  return {
    gateSatisfied,
    showGateError: input.gateErrorVisible && !gateSatisfied,
    showFrequencyChips: input.hasErrorEnvelope && !occurrenceIsRepeat,
    showLocationSelector: !input.hasErrorEnvelope && input.form.type === "bug",
  };
}

function deriveReportIssueFlags(input: {
  readonly hasErrorEnvelope: boolean;
  readonly form: ReportIssueFormState;
  readonly gateErrorVisible: boolean;
  readonly occurrence: DesktopFingerprintOccurrence | null;
  readonly snapshot: DesktopSupportSnapshot | null;
  readonly submitIsSuccess: boolean;
  readonly submitData: DesktopSubmitReportResult | undefined;
  readonly submitIsError: boolean;
}): ReportIssueDerivedFlags {
  const delivery = deriveDeliveryFlags(input);
  const gate = deriveGateFlags(input);
  const contactCheckboxVisible =
    input.snapshot !== null && input.snapshot.user.email !== null;
  return { ...delivery, ...gate, contactCheckboxVisible };
}

function fingerprintOccurrenceQueryOptions(
  support: DesktopSupportDialogProps["support"],
  fingerprint: string | null,
) {
  return queryOptions({
    queryKey: runnerQueryKeys.supportFingerprintOccurrence(
      support,
      fingerprint ?? "",
    ),
    queryFn: (): Promise<DesktopFingerprintOccurrence | null> => {
      if (support === null || fingerprint === null) {
        return Promise.resolve(null);
      }
      return support.getFingerprintOccurrence(fingerprint);
    },
    enabled: support !== null && fingerprint !== null,
  });
}

export function ReportIssueDialog(
  props: DesktopSupportDialogProps & { readonly draftId: number },
): ReactNode {
  const { draftId, onOpenChange, open, support } = props;
  const runnerHost = useRunnerHost();
  const draftContext = useDesktopDialogStore(
    (state) => state.reportIssueDraftContext,
  );
  const setLastConfirmedReport = useDesktopDialogStore(
    (state) => state.setLastConfirmedReport,
  );

  // Flow 1 (error-triggered) vs Flow 2 (manual): an error envelope is either
  // a structured cause or a fingerprint captured at catch time. The evidence
  // gate (D7/tech-plan T4) and the type-chip row are both keyed off this.
  const { cause, fingerprint, hasErrorEnvelope } =
    errorEnvelopeFromContext(draftContext);

  const [snapshot, setSnapshot] = useState<DesktopSupportSnapshot | null>(null);
  // Minted once at report-open (T2/T3) and reused by every retry as the
  // Sentry idempotency key. Null until the freeze IPC resolves; submit stays
  // disabled until then so it can never race ahead of the frozen evidence.
  const [reportId, setReportId] = useState<string | null>(null);
  const submitErrorRef = useRef<HTMLDivElement | null>(null);
  const intentRef = useRef<HTMLTextAreaElement | null>(null);

  const [screen, setScreen] = useState<ReportIssueScreen>("capture");
  // Non-migrated error surfaces still call `openReportIssueWithContext` with
  // only a public `ReportIssueContext` (no structured private cause) - that
  // context would otherwise be silently dropped by a redesign built around
  // the structured capture. Prefilling the intent question from it (mirrors
  // the old five-field form's `whatHappened` composition) keeps that context
  // visible until those surfaces migrate to a full draft context (ticket 05's
  // "the rest follow incrementally"). Error-triggered opens (a structured
  // cause) never prefill here - the evidence strip already shows that.
  const [form, setForm] = useState<ReportIssueFormState>(() => ({
    ...INITIAL_FORM_STATE,
    intent: intentFromUnmigratedContext(draftContext),
  }));
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [gateErrorVisible, setGateErrorVisible] = useState(false);
  const [logsTouchedByUser, setLogsTouchedByUser] = useState(false);
  // Flow 1 (error-triggered) shows every toggle expanded by default; Flow 2
  // (manual, either type) collapses the consent panel to one summary line
  // with a "details" expand affordance - both flows' own wireframes draw it
  // this way.
  const [consentExpanded, setConsentExpanded] = useState(hasErrorEnvelope);
  const [previewDraft, setPreviewDraft] =
    useState<DesktopSupportBuildPublicDraftResult | null>(null);
  const [previewTitle, setPreviewTitle] = useState("");

  useEffect(() => {
    if (support === null) return;
    // Fingerprint (when present) records an install-local sighting on first
    // freeze admission - powers "Nth time on this install".
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
  }, [draftId, support, draftContext, fingerprint]);

  useEffect(() => {
    if (!open || support === null) return;
    void support.getSnapshot().then(setSnapshot, () => null);
  }, [open, support]);

  const occurrenceQuery = useQuery(
    fingerprintOccurrenceQueryOptions(support, fingerprint),
  );
  const occurrence = occurrenceQuery.data ?? null;

  function buildRequest(): DesktopReportIssueForm {
    return {
      draftId,
      type: form.type,
      intent: form.intent,
      frequency: form.frequency,
      location:
        form.type === "bug" && form.locationChanged ? form.locationValue : null,
      allowContact: form.allowContact,
      includeDesktopLog: form.includeDesktopLog,
      includeHostLog: form.includeHostLog,
      ...(draftContext === null || !form.includeDiagnostics
        ? {}
        : {
            privateDiagnostics: serializeReportIssuePrivateDiagnostics(
              draftContext.privateDiagnostics,
            ),
          }),
    };
  }

  const submitMutation = useMutation({
    mutationKey: runnerMutationKeys.supportSubmitReport(),
    mutationFn: async (): Promise<DesktopSubmitReportResult> => {
      if (support === null) throw new Error("Support bridge unavailable");
      return support.submitReport(buildRequest());
    },
    onSuccess: (result) => {
      Analytics.getInstance().track(
        AnalyticsEvent.ReportIssuePrivateSubmit,
        reportIssuePrivateSubmitPropertiesFromResult(result),
      );
      if (result.status !== "delivered") return;
      setLastConfirmedReport({ draftId, reportId: result.reportId });
      setScreen("confirmed");
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
    mutationFn: async () => {
      if (support === null) throw new Error("Support bridge unavailable");
      return support.saveDiagnosticBundle(buildRequest());
    },
    onSuccess: () => {
      toast.success("Diagnostic bundle saved", {
        description:
          "It's been revealed in your file browser. It contains scrubbed logs - review it before sharing publicly.",
      });
    },
    onError: () => {
      toast.error("Could not save the diagnostic bundle");
    },
  });

  const {
    deliveryResult,
    effectiveDeliveryResult,
    showsHonestBanner,
    gateSatisfied,
    showGateError,
    showFrequencyChips,
    showLocationSelector,
    contactCheckboxVisible,
    isDeliveryUnavailable,
  } = deriveReportIssueFlags({
    hasErrorEnvelope,
    form,
    gateErrorVisible,
    occurrence,
    snapshot,
    submitIsSuccess: submitMutation.isSuccess,
    submitData: submitMutation.data,
    submitIsError: submitMutation.isError,
  });

  useEffect(() => {
    if (!showsHonestBanner) return;
    submitErrorRef.current?.focus();
  }, [showsHonestBanner]);

  // Sole call site for `support:buildPublicDraft` (ticket 09/07) across every
  // route to GitHub - the opt-in "Also post publicly", the unconfirmed/failed
  // "Report on GitHub instead" fallback, and the no-DSN "Open a GitHub issue"
  // fallback all fetch the same preview before anything opens, so the preview
  // is the consent event for public exposure everywhere, not just the
  // opt-in path (publish flow, Flow 3b).
  const buildDraftMutation = useMutation({
    mutationKey: runnerMutationKeys.supportBuildPublicDraft(),
    mutationFn: async (): Promise<DesktopSupportBuildPublicDraftResult> => {
      if (support === null) throw new Error("Support bridge unavailable");
      return support.buildPublicDraft(buildRequest());
    },
    onSuccess: (draft) => {
      setPreviewDraft(draft);
      setPreviewTitle(draft.title);
      setScreen("preview");
    },
    onError: () => {
      toast.error("Could not load the GitHub preview", {
        description: "Your report is safe - you can try again.",
        action: {
          label: "Try again",
          onClick: () => buildDraftMutation.mutate(),
        },
      });
    },
  });

  const openPublicDraftMutation = useMutation({
    mutationKey: runnerMutationKeys.supportPublicDraftOpen(),
    mutationFn: async (): Promise<void> => {
      if (previewDraft === null) throw new Error("No draft to open");
      const url = buildGitHubIssueUrl({ ...previewDraft, title: previewTitle });
      try {
        await runnerHost.openExternalLink(url);
      } catch {
        // Browser open can fail; the attempt still happened and is tracked -
        // pre-existing tolerance, orthogonal to whether buildPublicDraft
        // itself succeeded.
      }
      Analytics.getInstance().track(
        AnalyticsEvent.ReportIssuePublicOpenAttempted,
        null,
      );
    },
    onSuccess: () => {
      toast.success("Opened in your browser");
      setScreen("confirmed");
    },
    onError: () => {
      toast.error("Could not open the GitHub draft", {
        description: "Your report is safe - you can try opening it again.",
        action: {
          label: "Try again",
          onClick: () => openPublicDraftMutation.mutate(),
        },
      });
    },
  });

  const handleOpenChange = (nextOpen: boolean): void => {
    if (
      !nextOpen &&
      (submitMutation.isPending || buildDraftMutation.isPending)
    ) {
      return;
    }
    onOpenChange(nextOpen);
  };

  function selectType(nextType: DesktopReportType): void {
    setForm((prev) => {
      if (logsTouchedByUser) return { ...prev, type: nextType };
      // D8: log toggles default OFF for idea/other, ON for bug.
      const logsOn = nextType === "bug";
      return {
        ...prev,
        type: nextType,
        includeDesktopLog: logsOn,
        includeHostLog: logsOn,
      };
    });
  }

  function handleSend(): void {
    if (!gateSatisfied) {
      Analytics.getInstance().track(AnalyticsEvent.ReportIssueBlocked, {
        report_type: form.type,
      });
      setGateErrorVisible(true);
      intentRef.current?.focus();
      return;
    }
    submitMutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,48rem)] w-full flex-col sm:max-w-2xl">
        <ReportIssueDialogHeader
          screen={screen}
          hasErrorEnvelope={hasErrorEnvelope}
          isDeliveryUnavailable={isDeliveryUnavailable}
        />

        {screen === "capture" ? (
          <CaptureScreenBody
            hasErrorEnvelope={hasErrorEnvelope}
            cause={cause}
            draftContext={draftContext}
            snapshot={snapshot}
            occurrence={occurrence}
            reviewExpanded={reviewExpanded}
            onToggleReviewExpanded={() => setReviewExpanded((v) => !v)}
            form={form}
            setForm={setForm}
            showLocationSelector={showLocationSelector}
            showFrequencyChips={showFrequencyChips}
            showGateError={showGateError}
            intentRef={intentRef}
            isPending={submitMutation.isPending}
            consentExpanded={consentExpanded}
            onToggleConsentExpanded={() => setConsentExpanded(true)}
            isDeliveryUnavailable={isDeliveryUnavailable}
            draftId={draftId}
            support={support}
            contactCheckboxVisible={contactCheckboxVisible}
            contactEmail={snapshot?.user.email ?? null}
            onLogsTouched={() => setLogsTouchedByUser(true)}
            onSelectType={selectType}
          />
        ) : null}

        {screen === "confirmed" ? (
          <ConfirmationScreen
            reportId={
              submitMutation.data?.status === "delivered"
                ? submitMutation.data.reportId
                : null
            }
          />
        ) : null}

        {screen === "preview" ? (
          <PublishPreviewScreen
            draft={previewDraft}
            title={previewTitle}
            onTitleChange={setPreviewTitle}
            disabled={openPublicDraftMutation.isPending}
          />
        ) : null}

        {screen === "capture" && showsHonestBanner ? (
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
          <ReportIssueDialogFooter
            screen={screen}
            deliveryResult={effectiveDeliveryResult}
            isSubmitPending={submitMutation.isPending}
            isSaveBundlePending={saveDiagnosticBundleMutation.isPending}
            isBuildingDraft={buildDraftMutation.isPending}
            isOpeningPublicDraft={openPublicDraftMutation.isPending}
            canSubmit={reportId !== null}
            onCancel={() => handleOpenChange(false)}
            onDone={() => handleOpenChange(false)}
            onBackToConfirmed={() => setScreen("confirmed")}
            onSubmit={handleSend}
            onOpenGithubFallback={() => buildDraftMutation.mutate()}
            onSaveDiagnosticBundle={() => saveDiagnosticBundleMutation.mutate()}
            onOpenPublicDraft={() => openPublicDraftMutation.mutate()}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReportIssueDialogHeader({
  screen,
  hasErrorEnvelope,
  isDeliveryUnavailable,
}: {
  readonly screen: ReportIssueScreen;
  readonly hasErrorEnvelope: boolean;
  readonly isDeliveryUnavailable: boolean;
}): ReactNode {
  if (screen === "confirmed") {
    return (
      <DialogHeader>
        <DialogTitle>Report sent</DialogTitle>
        <DialogDescription className="sr-only">
          Your report was sent privately.
        </DialogDescription>
      </DialogHeader>
    );
  }
  if (screen === "preview") {
    return (
      <DialogHeader>
        <DialogTitle>Preview the public issue</DialogTitle>
        <DialogDescription>
          This is what we will fill in for you on GitHub. You can edit
          everything there before posting.
        </DialogDescription>
      </DialogHeader>
    );
  }
  return (
    <DialogHeader>
      <DialogTitle className="flex items-center gap-2">
        <Bug className="size-4" />
        Report an issue
      </DialogTitle>
      <DialogDescription>
        {captureDescriptionCopy(isDeliveryUnavailable, hasErrorEnvelope)}
      </DialogDescription>
    </DialogHeader>
  );
}

function CaptureScreenBody({
  hasErrorEnvelope,
  cause,
  draftContext,
  snapshot,
  occurrence,
  reviewExpanded,
  onToggleReviewExpanded,
  form,
  setForm,
  showLocationSelector,
  showFrequencyChips,
  showGateError,
  intentRef,
  isPending,
  consentExpanded,
  onToggleConsentExpanded,
  isDeliveryUnavailable,
  draftId,
  support,
  contactCheckboxVisible,
  contactEmail,
  onLogsTouched,
  onSelectType,
}: {
  readonly hasErrorEnvelope: boolean;
  readonly cause: ReportIssueDraftContext["privateDiagnostics"]["cause"];
  readonly draftContext: ReportIssueDraftContext | null;
  readonly snapshot: DesktopSupportSnapshot | null;
  readonly occurrence: DesktopFingerprintOccurrence | null;
  readonly reviewExpanded: boolean;
  readonly onToggleReviewExpanded: () => void;
  readonly form: ReportIssueFormState;
  readonly setForm: (
    updater: (prev: ReportIssueFormState) => ReportIssueFormState,
  ) => void;
  readonly showLocationSelector: boolean;
  readonly showFrequencyChips: boolean;
  readonly showGateError: boolean;
  readonly intentRef: RefObject<HTMLTextAreaElement | null>;
  readonly isPending: boolean;
  readonly consentExpanded: boolean;
  readonly onToggleConsentExpanded: () => void;
  readonly isDeliveryUnavailable: boolean;
  readonly draftId: number;
  readonly support: DesktopSupportDialogProps["support"];
  readonly contactCheckboxVisible: boolean;
  readonly contactEmail: string | null;
  readonly onLogsTouched: () => void;
  readonly onSelectType: (type: DesktopReportType) => void;
}): ReactNode {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="grid gap-4 py-1 pr-1">
        {hasErrorEnvelope ? (
          <EvidenceStrip
            expanded={reviewExpanded}
            onToggleExpanded={onToggleReviewExpanded}
            cause={cause}
            draftContext={draftContext}
            snapshot={snapshot}
            occurrence={occurrence}
          />
        ) : null}

        {!hasErrorEnvelope ? (
          <div
            role="radiogroup"
            aria-label="Report type"
            className="flex flex-wrap gap-1.5"
          >
            {TYPE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={form.type === option.value}
                size="sm"
                variant={form.type === option.value ? "default" : "outline"}
                onClick={() => onSelectType(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : null}

        {showLocationSelector ? (
          <Field htmlFor="report-issue-location" label="Where did this happen?">
            <Select
              value={
                form.locationChanged
                  ? form.locationValue
                  : CURRENT_LOCATION_VALUE
              }
              onValueChange={(next) => {
                setForm((prev) =>
                  next === CURRENT_LOCATION_VALUE
                    ? {
                        ...prev,
                        locationChanged: false,
                        locationValue: CURRENT_LOCATION_VALUE,
                      }
                    : { ...prev, locationChanged: true, locationValue: next },
                );
              }}
            >
              <SelectTrigger id="report-issue-location" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CURRENT_LOCATION_VALUE}>
                  {currentLocationLabel(draftContext)} (current)
                </SelectItem>
                {LOCATION_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        <Field
          htmlFor="report-issue-intent"
          label={intentLabel(hasErrorEnvelope, form.type)}
          required
        >
          <Textarea
            id="report-issue-intent"
            ref={intentRef}
            placeholder="e.g. sending a message in an existing chat"
            value={form.intent}
            onChange={(e) => {
              setForm((prev) => ({ ...prev, intent: e.target.value }));
            }}
            disabled={isPending}
            aria-invalid={showGateError}
            className={cn(
              "min-h-20 resize-none",
              showGateError && "border-destructive",
            )}
          />
          <IntentFieldHint
            showGateError={showGateError}
            type={form.type}
            intent={form.intent}
          />
        </Field>

        {showFrequencyChips ? (
          <div className="flex flex-wrap items-center gap-1.5 text-ui-xs text-muted-foreground">
            <span>How often?</span>
            {FREQUENCY_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                aria-pressed={form.frequency === option.value}
                size="sm"
                variant={
                  form.frequency === option.value ? "default" : "outline"
                }
                onClick={() => {
                  setForm((prev) => ({
                    ...prev,
                    frequency:
                      prev.frequency === option.value ? null : option.value,
                  }));
                }}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : null}

        <AttachmentDropTarget />

        <ConsentPanel
          expanded={consentExpanded}
          onToggleExpanded={onToggleConsentExpanded}
          deliveryUnavailable={isDeliveryUnavailable}
          draftId={draftId}
          support={support}
          includeDesktopLog={form.includeDesktopLog}
          includeHostLog={form.includeHostLog}
          includeDiagnostics={form.includeDiagnostics}
          allowContact={form.allowContact}
          contactCheckboxVisible={contactCheckboxVisible}
          contactEmail={contactEmail}
          disabled={isPending}
          onToggleDesktopLog={(checked) => {
            onLogsTouched();
            setForm((prev) => ({ ...prev, includeDesktopLog: checked }));
          }}
          onToggleHostLog={(checked) => {
            onLogsTouched();
            setForm((prev) => ({ ...prev, includeHostLog: checked }));
          }}
          onToggleDiagnostics={(checked) => {
            setForm((prev) => ({ ...prev, includeDiagnostics: checked }));
          }}
          onToggleAllowContact={(checked) => {
            setForm((prev) => ({ ...prev, allowContact: checked }));
          }}
        />
      </div>
    </div>
  );
}

function ReportIssueDialogFooter(props: {
  readonly screen: ReportIssueScreen;
  readonly deliveryResult: DesktopSubmitReportResult | null;
  readonly isSubmitPending: boolean;
  readonly isSaveBundlePending: boolean;
  readonly isBuildingDraft: boolean;
  readonly isOpeningPublicDraft: boolean;
  readonly canSubmit: boolean;
  readonly onCancel: () => void;
  readonly onDone: () => void;
  readonly onBackToConfirmed: () => void;
  readonly onSubmit: () => void;
  readonly onOpenGithubFallback: () => void;
  readonly onSaveDiagnosticBundle: () => void;
  readonly onOpenPublicDraft: () => void;
}): ReactNode {
  if (props.screen === "confirmed") {
    return (
      <>
        <Button variant="outline" onClick={props.onDone}>
          Done
        </Button>
        <Button
          onClick={props.onOpenGithubFallback}
          disabled={props.isBuildingDraft}
        >
          {props.isBuildingDraft ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Also post publicly on GitHub
        </Button>
      </>
    );
  }
  if (props.screen === "preview") {
    return (
      <>
        <Button variant="outline" onClick={props.onBackToConfirmed}>
          Back
        </Button>
        <Button
          onClick={props.onOpenPublicDraft}
          disabled={props.isOpeningPublicDraft}
        >
          {props.isOpeningPublicDraft ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Open GitHub draft
        </Button>
      </>
    );
  }
  return (
    <>
      <Button
        variant="outline"
        onClick={props.onCancel}
        disabled={props.isSubmitPending}
      >
        Cancel
      </Button>
      <ReportIssueFooterActions
        deliveryResult={props.deliveryResult}
        isSubmitPending={props.isSubmitPending}
        isSaveBundlePending={props.isSaveBundlePending}
        isBuildingDraft={props.isBuildingDraft}
        canSubmit={props.canSubmit}
        onSubmit={props.onSubmit}
        onOpenGithubFallback={props.onOpenGithubFallback}
        onSaveDiagnosticBundle={props.onSaveDiagnosticBundle}
      />
    </>
  );
}

function captureDescriptionCopy(
  isDeliveryUnavailable: boolean,
  hasErrorEnvelope: boolean,
): string {
  if (isDeliveryUnavailable) {
    return "Private reporting is not available in this build. You can save a diagnostic bundle and open a GitHub issue instead.";
  }
  if (hasErrorEnvelope) {
    return "The details below were captured automatically. Add what you were doing and send.";
  }
  return "Sent privately to the Traycer team so we can look into it.";
}

function intentLabel(
  hasErrorEnvelope: boolean,
  type: DesktopReportType,
): string {
  if (hasErrorEnvelope) return "What were you trying to do?";
  if (type === "bug") return "What were you trying to do, and what went wrong?";
  if (type === "idea") return "What's your idea?";
  return "What's on your mind?";
}

function gateErrorCopy(type: DesktopReportType): string {
  if (type === "bug") {
    return "Add a sentence, a screenshot, or pick where it happened - we need at least one to act on the report.";
  }
  return "Add a sentence or a screenshot - we need at least one to act on the report.";
}

function IntentFieldHint({
  showGateError,
  type,
  intent,
}: {
  readonly showGateError: boolean;
  readonly type: DesktopReportType;
  readonly intent: string;
}): ReactNode {
  if (showGateError) {
    return <p className="text-ui-xs text-destructive">{gateErrorCopy(type)}</p>;
  }
  const trimmedLength = intent.trim().length;
  if (trimmedLength > 0 && trimmedLength < 20) {
    return (
      <p className="text-ui-xs text-muted-foreground">
        A little more detail helps - one short sentence is usually enough.
      </p>
    );
  }
  return null;
}

function intentFromUnmigratedContext(
  draftContext: ReportIssueDraftContext | null,
): string {
  if (draftContext === null || draftContext.privateDiagnostics.cause !== null) {
    return "";
  }
  const context = draftContext.publicPrefill;
  const lines = [
    context.source === null ? null : `Area: ${context.source}`,
    context.code === null ? null : `Error code: ${context.code}`,
    context.message,
  ].filter((line): line is string => line !== null);
  return lines.join("\n\n");
}

function currentLocationLabel(
  draftContext: ReportIssueDraftContext | null,
): string {
  const field = draftContext?.privateDiagnostics.registry.routeTemplate;
  if (field === undefined || field.status === "unavailable") {
    return "Current location";
  }
  return field.value;
}

function ordinal(count: number): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${count}th`;
  switch (count % 10) {
    case 1:
      return `${count}st`;
    case 2:
      return `${count}nd`;
    case 3:
      return `${count}rd`;
    default:
      return `${count}th`;
  }
}

function capturedFieldDisplay(
  field: DesktopCapturedField<string> | undefined,
): string | null {
  if (field === undefined || field.status === "unavailable") return null;
  return field.value;
}

function EvidenceStrip({
  expanded,
  onToggleExpanded,
  cause,
  draftContext,
  snapshot,
  occurrence,
}: {
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  readonly cause: ReportIssueDraftContext["privateDiagnostics"]["cause"];
  readonly draftContext: ReportIssueDraftContext | null;
  readonly snapshot: DesktopSupportSnapshot | null;
  readonly occurrence: DesktopFingerprintOccurrence | null;
}): ReactNode {
  const registry = draftContext?.privateDiagnostics.registry;
  const harness = capturedFieldDisplay(registry?.harnessId);
  const model = capturedFieldDisplay(registry?.model);
  const summaryParts = evidenceSummaryParts(cause, snapshot, harness, model);

  if (!expanded) {
    return (
      <div className="flex items-start justify-between gap-2 rounded-md border border-emerald-800/40 bg-emerald-950/10 px-3 py-2 text-ui-xs">
        <span>
          <span className="font-medium text-emerald-600 dark:text-emerald-400">
            ✓ Captured
          </span>{" "}
          {summaryParts.join(" · ")}
        </span>
        <button
          type="button"
          onClick={onToggleExpanded}
          className="shrink-0 text-muted-foreground underline"
        >
          Review
        </button>
      </div>
    );
  }

  return (
    <div className="grid max-h-64 gap-2 overflow-y-auto rounded-md border border-border bg-muted/20 px-3 py-2.5 text-ui-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-emerald-600 dark:text-emerald-400">
          ✓ Captured
        </span>
        <button
          type="button"
          onClick={onToggleExpanded}
          className="text-muted-foreground underline"
        >
          Hide
        </button>
      </div>
      <EvidenceReviewDetails
        cause={cause}
        where={capturedFieldDisplay(registry?.routeTemplate)}
        harness={harness}
        model={model}
        snapshot={snapshot}
        occurrence={occurrence}
      />
      <p className="text-muted-foreground">
        Identifiers are opaque IDs; workspace paths and file contents are never
        included. Log tails can be viewed or turned off below.
      </p>
    </div>
  );
}

function evidenceSummaryParts(
  cause: ReportIssueDraftContext["privateDiagnostics"]["cause"],
  snapshot: DesktopSupportSnapshot | null,
  harness: string | null,
  model: string | null,
): readonly string[] {
  return [
    cause?.errorCode,
    cause?.sourceAction,
    snapshot !== null ? `v${snapshot.appVersion}` : null,
    snapshot !== null ? `${snapshot.platform} ${snapshot.arch}` : null,
    harness !== null && model !== null ? `${harness} / ${model}` : null,
  ].filter(
    (part): part is string =>
      part !== null && part !== undefined && part.length > 0,
  );
}

function EvidenceReviewDetails({
  cause,
  where,
  harness,
  model,
  snapshot,
  occurrence,
}: {
  readonly cause: ReportIssueDraftContext["privateDiagnostics"]["cause"];
  readonly where: string | null;
  readonly harness: string | null;
  readonly model: string | null;
  readonly snapshot: DesktopSupportSnapshot | null;
  readonly occurrence: DesktopFingerprintOccurrence | null;
}): ReactNode {
  const messageFirstLine = cause?.message.split("\n")[0] ?? null;
  return (
    <dl className="grid gap-1.5">
      {cause !== null ? (
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">Error</dt>
          <dd>
            {[cause.errorCode, messageFirstLine].filter(Boolean).join(": ")}
          </dd>
          {cause.stack !== null ? (
            <pre className="max-h-24 overflow-auto rounded-md border border-border/60 bg-background/60 p-1.5 font-mono text-code-xs text-muted-foreground">
              {cause.stack}
            </pre>
          ) : null}
        </div>
      ) : null}
      {cause !== null && cause.sourceAction !== null ? (
        <ReviewRow label="Operation" value={cause.sourceAction} />
      ) : null}
      {where !== null ? <ReviewRow label="Where" value={where} /> : null}
      {harness !== null || model !== null ? (
        <ReviewRow
          label="Agent"
          value={[harness, model]
            .filter((v): v is string => v !== null)
            .join(" · ")}
        />
      ) : null}
      {snapshot !== null ? (
        <ReviewRow
          label="Versions"
          value={`app ${snapshot.appVersion} · host ${snapshot.host.version ?? "unknown"} · ${snapshot.platform} ${snapshot.arch}`}
        />
      ) : null}
      {occurrence !== null ? (
        <ReviewRow
          label="Frequency here"
          value={`${ordinal(occurrence.count)} time on this install`}
        />
      ) : null}
    </dl>
  );
}

function ReviewRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function AttachmentDropTarget(): ReactNode {
  return (
    <div
      aria-disabled
      className="cursor-not-allowed rounded-md border border-dashed border-border px-3 py-2.5 text-center text-ui-xs text-muted-foreground opacity-60"
    >
      Paste or drop screenshots (coming soon)
    </div>
  );
}

function logsToggleSummary(desktopOn: boolean, hostOn: boolean): string {
  if (desktopOn && hostOn) return "log tails on";
  if (!desktopOn && !hostOn) return "log tails off";
  return "log tails partially on";
}

function ConsentPanel(props: {
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  readonly deliveryUnavailable: boolean;
  readonly draftId: number;
  readonly support: DesktopSupportDialogProps["support"];
  readonly includeDesktopLog: boolean;
  readonly includeHostLog: boolean;
  readonly includeDiagnostics: boolean;
  readonly allowContact: boolean;
  readonly contactCheckboxVisible: boolean;
  readonly contactEmail: string | null;
  readonly disabled: boolean;
  readonly onToggleDesktopLog: (checked: boolean) => void;
  readonly onToggleHostLog: (checked: boolean) => void;
  readonly onToggleDiagnostics: (checked: boolean) => void;
  readonly onToggleAllowContact: (checked: boolean) => void;
}): ReactNode {
  const summary = props.deliveryUnavailable
    ? "Included in your diagnostic bundle and GitHub draft"
    : "Sent privately to the Traycer team: adds your words, screenshots and logs to the crash data we already receive.";

  if (!props.expanded) {
    const logsState = logsToggleSummary(
      props.includeDesktopLog,
      props.includeHostLog,
    );
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-ui-xs text-muted-foreground">
        <span>
          {summary} · {logsState}
        </span>
        <button
          type="button"
          onClick={props.onToggleExpanded}
          className="shrink-0 underline"
        >
          details
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-2.5 rounded-md border border-border px-3 py-2.5">
      <p className="text-ui-xs text-muted-foreground">{summary}</p>
      <ConsentLogToggleRow
        label="App log tail"
        target="desktop"
        draftId={props.draftId}
        support={props.support}
        checked={props.includeDesktopLog}
        disabled={props.disabled}
        onCheckedChange={props.onToggleDesktopLog}
      />
      <ConsentLogToggleRow
        label="Host log tail"
        target="host"
        draftId={props.draftId}
        support={props.support}
        checked={props.includeHostLog}
        disabled={props.disabled}
        onCheckedChange={props.onToggleHostLog}
      />
      <div className="flex items-center justify-between gap-2">
        <Label
          htmlFor="report-issue-diagnostics-toggle"
          className="text-ui-xs font-normal"
        >
          Diagnostics (crash context, versions, provider info)
        </Label>
        <Switch
          id="report-issue-diagnostics-toggle"
          checked={props.includeDiagnostics}
          disabled={props.disabled}
          onCheckedChange={props.onToggleDiagnostics}
        />
      </div>
      {props.contactCheckboxVisible ? (
        <label className="flex items-center gap-2 text-ui-xs">
          <Checkbox
            checked={props.allowContact}
            disabled={props.disabled}
            onCheckedChange={(value) =>
              props.onToggleAllowContact(value === true)
            }
          />
          You may contact me at {props.contactEmail}
        </label>
      ) : null}
    </div>
  );
}

function ConsentLogToggleRow(props: {
  readonly label: string;
  readonly target: DesktopSupportLogTarget;
  readonly draftId: number;
  readonly support: DesktopSupportDialogProps["support"];
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}): ReactNode {
  const [viewOpen, setViewOpen] = useState(false);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-ui-xs font-normal">{props.label}</Label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setViewOpen((v) => !v)}
            className="text-ui-xs text-muted-foreground underline"
          >
            {viewOpen ? "hide" : "view"}
          </button>
          <Switch
            checked={props.checked}
            disabled={props.disabled}
            onCheckedChange={props.onCheckedChange}
            aria-label={`Include ${props.label}`}
          />
        </div>
      </div>
      {viewOpen ? (
        <FrozenLogTailView
          support={props.support}
          draftId={props.draftId}
          target={props.target}
        />
      ) : null}
    </div>
  );
}

function frozenLogTailQueryOptions(
  support: DesktopSupportDialogProps["support"],
  draftId: number,
  target: DesktopSupportLogTarget,
) {
  return queryOptions({
    queryKey: runnerQueryKeys.supportFrozenLogTail(support, draftId, target),
    queryFn: () => {
      if (support === null) {
        return Promise.reject(new Error("Support bridge unavailable"));
      }
      return support.readFrozenLogTail({ draftId, target });
    },
    enabled: support !== null,
  });
}

function FrozenLogTailView(props: {
  readonly support: DesktopSupportDialogProps["support"];
  readonly draftId: number;
  readonly target: DesktopSupportLogTarget;
}): ReactNode {
  const { data, isFetching, isError } = useQuery(
    frozenLogTailQueryOptions(props.support, props.draftId, props.target),
  );

  if (isFetching) {
    return (
      <p className="text-ui-xs text-muted-foreground">Loading frozen tail...</p>
    );
  }
  if (isError || data === undefined) {
    return (
      <p className="text-ui-xs text-muted-foreground">
        Could not load the frozen log tail.
      </p>
    );
  }
  if (data.lines.length === 0) {
    return <p className="text-ui-xs text-muted-foreground">Tail is empty.</p>;
  }
  return (
    <pre className="max-h-32 overflow-auto rounded-md border border-border/60 bg-muted/30 p-1.5 font-mono text-code-xs text-muted-foreground">
      {data.lines.join("\n")}
    </pre>
  );
}

function ConfirmationScreen({
  reportId,
}: {
  readonly reportId: string | null;
}): ReactNode {
  return (
    <div className="grid gap-2 rounded-md border border-emerald-800/40 bg-emerald-950/10 px-3 py-3 text-ui-sm">
      <p className="font-medium text-emerald-600 dark:text-emerald-400">
        Sent privately to the Traycer team.
      </p>
      {reportId !== null ? (
        <p className="flex items-center gap-2 font-mono text-code-xs text-muted-foreground">
          Report ID {reportId}
          <CopyTextButton
            value={reportId}
            label={null}
            ariaLabel="Copy report ID"
            disabled={false}
          />
        </p>
      ) : null}
      <p className="text-muted-foreground">
        New reports get a first look within 1 business day.
      </p>
      <p className="text-muted-foreground">
        Want other users to be able to find and follow this?
      </p>
    </div>
  );
}

interface PreviewFieldRow {
  readonly label: string;
  readonly value: string;
}

// Explicit per-template field lists (not a generic label lookup): each
// template's field set is a concrete, named interface, and this keeps the
// preview exhaustive over `draft.template` the same way the main-process
// composer is - a new/renamed field id fails to compile here, not silently
// falls back to its raw key.
function previewFieldRows(
  draft: DesktopSupportBuildPublicDraftResult,
): readonly PreviewFieldRow[] {
  switch (draft.template) {
    case "bug_report.yml":
      return [
        { label: "What happened", value: draft.fields["what-happened"] },
        { label: "Version", value: draft.fields.version },
        { label: "OS / platform", value: draft.fields.os },
        { label: "Component", value: draft.fields.component },
        { label: "Steps to reproduce", value: draft.fields.repro },
      ];
    case "feature_request.yml":
      return [
        { label: "Problem / motivation", value: draft.fields.problem },
        { label: "Proposed solution", value: draft.fields.proposal },
        {
          label: "Alternatives considered",
          value: draft.fields.alternatives,
        },
        { label: "Component", value: draft.fields.component },
      ];
    case "general.yml":
      return [{ label: "Details", value: draft.fields.details }];
  }
}

function PublishPreviewScreen({
  draft,
  title,
  onTitleChange,
  disabled,
}: {
  readonly draft: DesktopSupportBuildPublicDraftResult | null;
  readonly title: string;
  readonly onTitleChange: (value: string) => void;
  readonly disabled: boolean;
}): ReactNode {
  if (draft === null) {
    return (
      <p className="text-ui-sm text-muted-foreground">Loading preview...</p>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="grid gap-3 py-1 pr-1">
        <Field htmlFor="report-issue-preview-title" label="Title">
          <Input
            id="report-issue-preview-title"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            disabled={disabled}
          />
        </Field>
        <div className="grid gap-2 rounded-md border border-border bg-muted/20 px-3 py-2.5 text-ui-xs">
          {previewFieldRows(draft).map((row) => (
            <div key={row.label} className="grid gap-1">
              <span className="font-medium text-muted-foreground">
                {row.label}
              </span>
              <p className="whitespace-pre-wrap text-foreground">{row.value}</p>
            </div>
          ))}
        </div>
        <p className="rounded-md border border-border px-3 py-2 text-ui-xs text-muted-foreground">
          Logs, stack traces and identifiers stay in the private report.
          Publishing needs a GitHub account; the issue is posted from yours, not
          by the app.
        </p>
      </div>
    </div>
  );
}

function ReportIssueFooterActions({
  deliveryResult,
  isSubmitPending,
  isSaveBundlePending,
  isBuildingDraft,
  canSubmit,
  onSubmit,
  onOpenGithubFallback,
  onSaveDiagnosticBundle,
}: {
  readonly deliveryResult: DesktopSubmitReportResult | null;
  readonly isSubmitPending: boolean;
  readonly isSaveBundlePending: boolean;
  readonly isBuildingDraft: boolean;
  readonly canSubmit: boolean;
  readonly onSubmit: () => void;
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
        <Button onClick={onOpenGithubFallback} disabled={isBuildingDraft}>
          {isBuildingDraft ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Open a GitHub issue
        </Button>
      </>
    );
  }
  if (deliveryResult !== null && deliveryResult.status !== "delivered") {
    return (
      <>
        <Button
          variant="outline"
          onClick={onOpenGithubFallback}
          disabled={isBuildingDraft}
        >
          {isBuildingDraft ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Report on GitHub instead
        </Button>
        <Button onClick={onSubmit} disabled={isSubmitPending}>
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
    <Button onClick={onSubmit} disabled={isSubmitPending || !canSubmit}>
      {isSubmitPending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      Send report
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
