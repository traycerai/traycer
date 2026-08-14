import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Bug, X } from "lucide-react";
import { toast } from "sonner";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { MAX_REPORT_IMAGES } from "@traycer-clients/shared/support/image-attachment-guards";
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
import {
  runnerMutationKeys,
  runnerQueryKeys,
  supportBridgeQueryScopeId,
} from "@/lib/query-keys";
import {
  serializeReportIssuePrivateDiagnostics,
  type ReportIssueDraftContext,
} from "@/lib/report-issue-draft-context";
import {
  getSupportContextSnapshot,
  type CapturedField,
} from "@/lib/support-context-registry";
import {
  useReportIssueAttachments,
  type ReportIssueAttachmentImage,
  type UseReportIssueAttachmentsResult,
} from "@/hooks/support/use-report-issue-attachments";
import {
  classifyFileTransferDrag,
  collectFileTransferEntries,
  hasClaimableFileTransfer,
} from "@/lib/files/file-transfer-paths";
import type {
  DesktopCapturedField,
  DesktopFingerprintOccurrence,
  DesktopPrivateOutcome,
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
import type { FileRouteTypes } from "@/routeTree.gen";
import type { DesktopSupportDialogProps } from "./types";
import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
  reportIssuePrivateSubmitPropertiesFromResult,
} from "@/lib/analytics";
import {
  toastFromRunnerError,
  toastFromRunnerErrorWithOptions,
} from "@/lib/runner-error-toast";

// "opened" is the honest terminal state for a public-draft open when nothing
// was ever privately delivered (no-DSN Case B, or a definite failure) - never
// "confirmed", which claims a private send that did not happen.
type ReportIssueScreen = "capture" | "confirmed" | "preview" | "opened";

// Keyed by the generated route tree's `fullPaths` union (not a plain
// `string`) so adding a route fails compile here until it gets a human
// label - compiler-guaranteed completeness, zero manual drift. The registry
// can still hold a `routeTemplate` captured by an older session/build that
// no longer exists in the current tree, so `humanRouteLabel`'s `?? "This
// screen"` fallback below is load-bearing at runtime even though every key
// here is exhaustive at compile time.
const ROUTE_TEMPLATE_LABELS: Readonly<
  Record<FileRouteTypes["fullPaths"], string>
> = {
  "/": "Start page",
  "/epics": "Epics list",
  "/epics/": "Epics list",
  "/epics/$epicId/$tabId": "Epic tab",
  "/draft/new": "New chat draft",
  "/draft/$draftId": "Chat draft",
  "/onboarding": "Onboarding",
  "/settings": "Settings",
  "/settings/": "Settings",
  "/settings/agents": "Settings - Agents",
  "/settings/app-diagnostics": "Settings - App diagnostics",
  "/settings/appearance": "Settings - Appearance",
  "/settings/devices": "Settings - Devices",
  "/settings/diagnostics": "Settings - Host diagnostics",
  "/settings/general": "Settings - General",
  "/settings/host": "Settings - Host",
  "/settings/keybindings": "Settings - Keybindings",
  "/settings/notifications": "Settings - Notifications",
  "/settings/providers": "Settings - Providers",
  "/settings/service": "Settings - Service",
  "/settings/shell": "Settings - Shell",
  "/settings/usage": "Settings - Usage",
  "/settings/worktrees": "Settings - Worktrees",
};

// Widened for runtime lookup: `ROUTE_TEMPLATE_LABELS` above is exhaustive
// over the CURRENT route tree, but a registry value from an older
// session/build can be a template that no longer exists in it - indexing
// with an arbitrary `string` must stay honestly `string | undefined`, not
// inherit the literal's exhaustiveness, or the fallback below reads as
// unreachable when it is exactly what stale input needs.
const ROUTE_TEMPLATE_LABEL_LOOKUP: Readonly<
  Record<string, string | undefined>
> = ROUTE_TEMPLATE_LABELS;

// Shared between an unmapped-but-known template (`humanRouteLabel`'s own
// fallback) and a template that was never captured at all
// (`currentLocationLabel`'s "unavailable" case, ADV-L6) - one constant so the
// two paths can never drift into two different-sounding generic strings.
const ROUTE_TEMPLATE_FALLBACK_LABEL = "This screen";

function humanRouteLabel(template: string): string {
  return ROUTE_TEMPLATE_LABEL_LOOKUP[template] ?? ROUTE_TEMPLATE_FALLBACK_LABEL;
}

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

// What the private channel actually did with this draft, as known by the
// renderer right now - main has no memory of a prior `submitReport` call, so
// this travels on every `buildPublicDraft` request. A definite `failed`
// result and "never attempted" both collapse to "none": neither left
// anything on the Sentry side for the public draft to honestly reference.
function privateOutcomeFor(
  deliveryResult: DesktopSubmitReportResult | null,
): DesktopPrivateOutcome {
  if (deliveryResult === null) return "none";
  if (deliveryResult.status === "delivered") return "delivered";
  if (deliveryResult.status === "unconfirmed") return "unconfirmed";
  return "none";
}

// Both `delivered` and `unconfirmed` carry a reportId - a private report was
// actually minted and (at least attempted to be) filed, unlike `failed`/
// `unavailable`/never-attempted. `ConfirmationScreen` requires this be
// non-null so the false "sent privately" state is unrepresentable: it is
// simply never rendered when this returns null (KB1).
function confirmedReportId(
  deliveryResult: DesktopSubmitReportResult | null,
): string | null {
  if (deliveryResult?.status === "delivered") return deliveryResult.reportId;
  if (deliveryResult?.status === "unconfirmed") return deliveryResult.reportId;
  return null;
}

// The preview is only ever entered from "capture" or "confirmed" - never
// from "preview"/"opened" themselves (neither renders a button that opens
// the preview) - but `screen` is typed as the full union at the call site,
// so this narrows it explicitly rather than asserting.
function previewOriginFor(screen: ReportIssueScreen): "capture" | "confirmed" {
  return screen === "confirmed" ? "confirmed" : "capture";
}

interface ReportIssueDeliveryFlags {
  readonly deliveryResult: DesktopSubmitReportResult | null;
  readonly effectiveDeliveryResult: DesktopSubmitReportResult | null;
  readonly showsHonestBanner: boolean;
  readonly isDeliveryUnavailable: boolean;
}

function deriveDeliveryFlags(input: {
  readonly snapshot: DesktopSupportSnapshot | null;
  readonly snapshotIsError: boolean;
  readonly submitIsSuccess: boolean;
  readonly submitData: DesktopSubmitReportResult | undefined;
  readonly submitIsError: boolean;
}): ReportIssueDeliveryFlags {
  const deliveryResult = input.submitIsSuccess
    ? (input.submitData ?? null)
    : null;
  const deliveryUnavailableUpfront =
    input.snapshotIsError ||
    (input.snapshot !== null && !input.snapshot.privateDeliveryAvailable);
  // A rejected submitReport promise (IPC/parser/bridge exception - not a
  // typed `{status:"failed"}` result) must still land on the same terminal
  // action set as a definite failure - "Try again" + "Report on GitHub
  // instead" - never silently fall through to a bare, misleadingly-fresh
  // "Send report" because `deliveryResult` stayed null.
  const rejectedResult: DesktopSubmitReportResult | null = input.submitIsError
    ? { status: "failed", reason: "error" }
    : null;
  // Known unavailable up front (DSN presence is known at startup) synthesizes
  // the same terminal state a submit attempt would eventually reach, so the
  // dialog can state it and offer the two honest actions before the user
  // invests any effort.
  const effectiveDeliveryResult: DesktopSubmitReportResult | null =
    deliveryResult ??
    rejectedResult ??
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

// Consolidates every UI-gating boolean derived from render state into one
// call so `ReportIssueDialog` itself stays a thin orchestrator - splitting
// these into a dozen separate `&&`/`||`/`?:` consts inline pushed its own
// cyclomatic complexity well past the repo's lint budget.
type ReportIssueDerivedFlags = ReportIssueDeliveryFlags &
  ReportIssueGateFlags & { readonly contactCheckboxVisible: boolean };

function deriveGateFlags(input: {
  readonly hasErrorEnvelope: boolean;
  readonly form: ReportIssueFormState;
  readonly gateErrorVisible: boolean;
  readonly occurrence: DesktopFingerprintOccurrence | null;
  readonly hasImages: boolean;
}): ReportIssueGateFlags {
  const gateApplies = !input.hasErrorEnvelope;
  const locationSatisfiesGate =
    input.form.type === "bug" && input.form.locationChanged;
  const intentSatisfiesGate = input.form.intent.trim().length > 0;
  // Flow 1/2's evidence gate: a sentence, an image, or (bug-only) an
  // actively-changed location - any one satisfies it (tech-plan T4/T5).
  const gateSatisfied =
    !gateApplies ||
    intentSatisfiesGate ||
    locationSatisfiesGate ||
    input.hasImages;
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
  readonly snapshotIsError: boolean;
  readonly submitIsSuccess: boolean;
  readonly submitData: DesktopSubmitReportResult | undefined;
  readonly submitIsError: boolean;
  readonly hasImages: boolean;
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
      supportBridgeQueryScopeId(support),
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

function supportSnapshotQueryOptions(
  support: DesktopSupportDialogProps["support"],
  open: boolean,
) {
  return queryOptions({
    queryKey: runnerQueryKeys.supportSnapshot(
      supportBridgeQueryScopeId(support),
    ),
    queryFn: (): Promise<DesktopSupportSnapshot> => {
      if (support === null) {
        return Promise.reject(new Error("Support bridge unavailable"));
      }
      return support.getSnapshot();
    },
    enabled: open && support !== null,
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

  // ADV-L6: a plain manual open (Flow 2) never assembles a `draftContext` at
  // all (`openReportIssue()` sets it to null - there is no error to capture),
  // so the location selector's current-location option had nothing to read
  // and fell back to a hardcoded "Current location" string instead of the
  // real route. Reuse the draft's own captured registry when one exists
  // (error-triggered/legacy-context opens); otherwise read the live registry
  // once at mount - the "where the user is/was right now" this option means
  // either way. Lazy `useState` initializer: evaluated once, matching
  // `draftContext`'s own "immutable for the draft's life" invariant above.
  const [routeTemplateField] = useState<CapturedField<string>>(
    () =>
      draftContext?.privateDiagnostics.registry.routeTemplate ??
      getSupportContextSnapshot().routeTemplate,
  );

  const submitErrorRef = useRef<HTMLDivElement | null>(null);
  const intentRef = useRef<HTMLTextAreaElement | null>(null);

  const [screen, setScreen] = useState<ReportIssueScreen>("capture");
  // Non-migrated error surfaces still call `openReportIssueWithContext` with
  // only a public `ReportIssueContext` (no structured private cause) - that
  // context would otherwise be silently dropped by a redesign built around
  // the structured capture. It used to be prefilled straight into the intent
  // textarea (mirroring the old five-field form's `whatHappened`
  // composition), but machine text ("Area: ... Error code: ...") answering
  // the human question both buried the actual prompt and trivially satisfied
  // the evidence gate with zero human signal. It's rendered as its own
  // captured-context row instead (`legacyContext`, below the type chips) and
  // still folded into the submitted intent (`composeIntentForSubmission`) -
  // just never into the user-editable textarea the gate reads from.
  // Error-triggered opens (a structured cause) never have this - the
  // evidence strip already shows that.
  const legacyContext = intentFromUnmigratedContext(draftContext);
  const [form, setForm] = useState<ReportIssueFormState>(INITIAL_FORM_STATE);
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
  // KB1: the preview is entered from either "capture" (the two fallback
  // routes) or "confirmed" (opt-in publish) - Back must return there, never
  // unconditionally to "confirmed" (which would claim a private send that
  // never happened on the fallback routes).
  const [previewOrigin, setPreviewOrigin] = useState<"capture" | "confirmed">(
    "capture",
  );

  const snapshotQuery = useQuery(supportSnapshotQueryOptions(support, open));
  const snapshot = snapshotQuery.data ?? null;
  const occurrenceQuery = useQuery(
    fingerprintOccurrenceQueryOptions(support, fingerprint),
  );
  const occurrence = occurrenceQuery.data ?? null;

  const attachments = useReportIssueAttachments();

  const {
    data: freezeEvidenceData,
    isError: freezeEvidenceIsError,
    mutate: freezeEvidence,
  } = useMutation({
    mutationKey: runnerMutationKeys.supportFreezeEvidence(),
    mutationFn: async () => {
      if (support === null) throw new Error("Support bridge unavailable");
      return support.freezeEvidence({ draftId, fingerprint });
    },
  });
  const reportId = freezeEvidenceData?.reportId ?? null;

  useEffect(() => {
    if (support === null) return;
    // Fingerprint (when present) records an install-local sighting on first
    // freeze admission - powers "Nth time on this install". The mutation
    // state keeps a rejected host call visible so the dialog can fail closed
    // to its bundle/GitHub fallbacks instead of silently disabling Send.
    freezeEvidence();
    return () => {
      void support.discardFrozenEvidence(draftId).catch(() => null);
    };
    // draftId is this component's identity for its whole mounted lifetime -
    // the host remounts it under a fresh `key` per draft, so this effect
    // only ever re-runs here if `support` itself changes identity.
    // draftContext is captured at open and is immutable for the draft's life.
  }, [draftId, support, draftContext, fingerprint, freezeEvidence]);

  // `includeDiagnostics` no longer decides whether `privateDiagnostics` rides
  // the wire at all - main is the sole authority on what it honors from it
  // (fix: the diagnostics toggle used to only omit this object, while main
  // independently computed layer-0/process-metrics/version tags regardless).
  // `privateDiagnostics` is always sent when a draft context exists; the
  // `includeDiagnostics` flag below is what main actually gates on.
  function buildRequest(overrideTitle: string | null): DesktopReportIssueForm {
    return {
      draftId,
      type: form.type,
      // The legacy machine-text context rides along here (unchanged from
      // before KB2) - just appended to the user's own words instead of
      // masquerading as them in the textarea/gate.
      intent: composeIntentForSubmission(form.intent, legacyContext),
      frequency: form.frequency,
      location:
        form.type === "bug" && form.locationChanged ? form.locationValue : null,
      allowContact: form.allowContact,
      includeDesktopLog: form.includeDesktopLog,
      includeHostLog: form.includeHostLog,
      includeDiagnostics: form.includeDiagnostics,
      images: attachments.images.map((image) => ({
        fileName: image.fileName,
        mimeType: image.mimeType,
        bytes: image.bytes,
      })),
      // `overrideTitle`/`privateOutcome` are `buildPublicDraft`-only (ignored
      // by submit/bundle) - shared here per the one-contract rule.
      overrideTitle,
      privateOutcome,
      ...(draftContext === null
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
      return support.submitReport(buildRequest(null));
    },
    onSuccess: (result) => {
      Analytics.getInstance().track(
        AnalyticsEvent.ReportIssuePrivateSubmit,
        reportIssuePrivateSubmitPropertiesFromResult(
          result,
          attachments.images.length,
        ),
      );
      if (result.status !== "delivered") return;
      setLastConfirmedReport({ draftId, reportId: result.reportId });
      setScreen("confirmed");
    },
    onError: (error) => {
      Analytics.getInstance().track(AnalyticsEvent.ReportIssuePrivateSubmit, {
        outcome: "failed",
        blocker: analyticsBlockerFromError(error),
        attachment_count: attachments.images.length,
      });
    },
  });

  const saveDiagnosticBundleMutation = useMutation({
    mutationKey: runnerMutationKeys.supportSaveDiagnosticBundle(),
    mutationFn: async () => {
      if (support === null) throw new Error("Support bridge unavailable");
      return support.saveDiagnosticBundle(buildRequest(null));
    },
    onSuccess: () => {
      toast.success("Diagnostic bundle saved", {
        description:
          "It's been revealed in your file browser. It contains scrubbed logs - review it before sharing publicly.",
      });
    },
    onError: (error) =>
      toastFromRunnerError(error, "Could not save the diagnostic bundle"),
  });

  // Single source of truth for what the private channel actually did with
  // this draft - shared by `buildRequest`'s wire field, the confirmation
  // screen's reportId, and the post-open screen branch below (KB1).
  const lastSubmitResult = submitMutation.isSuccess
    ? submitMutation.data
    : null;
  const privateOutcome = privateOutcomeFor(lastSubmitResult);
  const confirmedReportIdValue = confirmedReportId(lastSubmitResult);

  const {
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
    snapshotIsError: snapshotQuery.isError || freezeEvidenceIsError,
    submitIsSuccess: submitMutation.isSuccess,
    submitData: submitMutation.data,
    submitIsError: submitMutation.isError,
    hasImages: attachments.images.length > 0,
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
      // Initial preview fetch: no override yet, title is derived normally.
      return support.buildPublicDraft(buildRequest(null));
    },
    onSuccess: (draft) => {
      setPreviewDraft(draft);
      setPreviewTitle(draft.title);
      setScreen("preview");
    },
    onError: (error) => {
      toastFromRunnerErrorWithOptions(
        error,
        "Could not load the GitHub preview",
        {
          description: "Your report is safe - you can try again.",
          action: {
            label: "Try again",
            onClick: () => buildDraftMutation.mutate(),
          },
        },
      );
    },
  });

  const openPublicDraftMutation = useMutation({
    mutationKey: runnerMutationKeys.supportPublicDraftOpen(),
    mutationFn: async (): Promise<void> => {
      if (support === null) throw new Error("Support bridge unavailable");
      if (previewDraft === null) throw new Error("No draft to open");
      // Re-invokes the builder with the user's as-typed preview-title edit
      // as the override: `issue-reporter.ts` is assembly-only and must never
      // see raw text, so the edited title is re-scrubbed and re-fit through
      // the same budget pipeline as a derived title before it can reach the
      // URL - never the raw `previewTitle` state swapped in directly.
      const finalDraft = await support.buildPublicDraft(
        buildRequest(previewTitle),
      );
      const url = buildGitHubIssueUrl(finalDraft);
      // Track the attempt whether the OS handoff succeeds or not - the
      // analytics event is about the user asking to open, not about the
      // browser actually launching. Re-throw after tracking so onError keeps
      // the preview screen and a retryable toast (publish flow: open failure
      // must never silently claim success or leave the confirmation).
      try {
        await runnerHost.openExternalLink(url);
      } catch (error) {
        Analytics.getInstance().track(
          AnalyticsEvent.ReportIssuePublicOpenAttempted,
          null,
        );
        throw error;
      }
      Analytics.getInstance().track(
        AnalyticsEvent.ReportIssuePublicOpenAttempted,
        null,
      );
    },
    onSuccess: () => {
      toast.success("Opened in your browser");
      // KB1: "confirmed" claims a private send happened - only true when
      // delivered/unconfirmed actually minted a report. A no-DSN or definite-
      // failure open (privateOutcome "none") lands on the honest "opened"
      // terminal state instead, never the green confirmation.
      setScreen(privateOutcome === "none" ? "opened" : "confirmed");
    },
    onError: (error) => {
      toastFromRunnerErrorWithOptions(
        error,
        "Could not open the GitHub draft",
        {
          description: "Your report is safe - you can try opening it again.",
          action: {
            label: "Try again",
            onClick: () => openPublicDraftMutation.mutate(),
          },
        },
      );
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

  // N1: every capture-screen action that produces a report artifact - Send,
  // the two GitHub-fallback buttons, and Save diagnostic bundle - must pass
  // the same evidence gate Send always did; only Send used to check it, so
  // e.g. the no-DSN "Open a GitHub issue" primary action could open a public
  // preview off zero evidence. Same focus + inline-copy behavior for all
  // four, same telemetry (now tagged with which action was blocked).
  function runIfGateSatisfied(
    blockedAction:
      "send" | "open_github_issue" | "report_on_github" | "save_bundle",
    run: () => void,
  ): void {
    if (!gateSatisfied) {
      Analytics.getInstance().track(AnalyticsEvent.ReportIssueBlocked, {
        report_type: form.type,
        blocked_action: blockedAction,
      });
      setGateErrorVisible(true);
      intentRef.current?.focus();
      return;
    }
    run();
  }

  function handleSend(): void {
    runIfGateSatisfied("send", () => submitMutation.mutate());
  }

  // Shared by all three routes into the preview - the no-DSN "Open a GitHub
  // issue", the unconfirmed/failed "Report on GitHub instead", and the
  // confirmed screen's opt-in "Also post publicly on GitHub". Captures which
  // screen we're leaving so the preview's Back can return there (KB1)
  // instead of always landing on "confirmed".
  function enterPreview(): void {
    setPreviewOrigin(previewOriginFor(screen));
    buildDraftMutation.mutate();
  }

  // Case B's primary action (no-DSN) - N1: previously ungated, so an empty
  // report with only the un-actioned default location could still open a
  // public preview.
  function handleOpenGithubIssue(): void {
    runIfGateSatisfied("open_github_issue", enterPreview);
  }

  // The unconfirmed/failed banner's fallback - same gate as Send, since it
  // produces the same kind of report artifact.
  function handleReportOnGithub(): void {
    runIfGateSatisfied("report_on_github", enterPreview);
  }

  function handleSaveDiagnosticBundle(): void {
    runIfGateSatisfied("save_bundle", () =>
      saveDiagnosticBundleMutation.mutate(),
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,48rem)] w-full flex-col sm:max-w-2xl">
        <ReportIssueDialogHeader
          screen={screen}
          hasErrorEnvelope={hasErrorEnvelope}
          isDeliveryUnavailable={isDeliveryUnavailable}
          preparationIsError={freezeEvidenceIsError}
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
            attachments={attachments}
            legacyContext={legacyContext}
            routeTemplateField={routeTemplateField}
          />
        ) : null}

        {screen === "confirmed" && confirmedReportIdValue !== null ? (
          <ConfirmationScreen reportId={confirmedReportIdValue} />
        ) : null}

        {screen === "opened" ? <GithubDraftOpenedScreen /> : null}

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
            {deliveryOutcomeMessage(effectiveDeliveryResult)}
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
            isIngesting={attachments.isIngesting}
            canSubmit={reportId !== null}
            onCancel={() => handleOpenChange(false)}
            onDone={() => handleOpenChange(false)}
            onBack={() => setScreen(previewOrigin)}
            onSubmit={handleSend}
            onOpenGithubIssue={handleOpenGithubIssue}
            onReportOnGithub={handleReportOnGithub}
            onPostPubliclyOnGithub={enterPreview}
            onSaveDiagnosticBundle={handleSaveDiagnosticBundle}
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
  preparationIsError,
}: {
  readonly screen: ReportIssueScreen;
  readonly hasErrorEnvelope: boolean;
  readonly isDeliveryUnavailable: boolean;
  readonly preparationIsError: boolean;
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
  if (screen === "opened") {
    return (
      <DialogHeader>
        <DialogTitle>GitHub draft opened</DialogTitle>
        <DialogDescription className="sr-only">
          Nothing was sent from this app - finish posting in your browser.
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
        {captureDescriptionCopy(
          isDeliveryUnavailable,
          hasErrorEnvelope,
          preparationIsError,
        )}
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
  attachments,
  legacyContext,
  routeTemplateField,
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
  readonly attachments: UseReportIssueAttachmentsResult;
  // KB2: the legacy machine-text context (non-migrated surfaces) is no
  // longer prefilled into the intent textarea - it renders as its own
  // captured-context row instead, so it never buries the actual question or
  // trivially satisfies the evidence gate with zero human signal.
  readonly legacyContext: string;
  // ADV-L6: resolved once at report-open regardless of whether a
  // `draftContext` exists (a plain manual open never assembles one) - the
  // single source for the location selector's current-location option.
  readonly routeTemplateField: CapturedField<string>;
}): ReactNode {
  // Paste is bound at this wrapper, not on the attachment target below: a
  // `paste` DOM event only bubbles through the FOCUSED element's ancestors,
  // and the intent textarea (the dialog's natural focus target) is this
  // div's sibling, not the target's descendant - scoping the handler to the
  // small target box would silently never fire while the user is typing.
  // `handleBodyPaste` only intercepts when the clipboard actually carries a
  // claimable image (mirrors the composer's own `hasClaimableFileTransfer`
  // gate), so ordinary text paste into the textarea is untouched.
  function handleBodyPaste(event: ClipboardEvent<HTMLDivElement>): void {
    if (isPending) return;
    if (!hasClaimableFileTransfer(event.clipboardData)) return;
    const { files } = collectFileTransferEntries(event.clipboardData);
    const imageFiles = files.filter(isImageFile);
    if (imageFiles.length === 0) return;
    event.preventDefault();
    attachments.addFiles(imageFiles);
  }

  return (
    <div className="flex-1 overflow-y-auto" onPaste={handleBodyPaste}>
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

        {legacyContext !== "" ? (
          <LegacyCapturedContextRow context={legacyContext} />
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
                  {currentLocationLabel(routeTemplateField)} (current)
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

        <AttachmentSection attachments={attachments} disabled={isPending} />

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

// KB2: a compact, read-only line for the legacy machine-text context - never
// editable (it isn't the user's words) and never counted by the evidence
// gate; it still rides in the submitted report via
// `composeIntentForSubmission`.
function LegacyCapturedContextRow({
  context,
}: {
  readonly context: string;
}): ReactNode {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-ui-xs text-muted-foreground">
      <span className="font-medium text-foreground">
        Captured automatically:{" "}
      </span>
      {legacyContextSummaryLine(context)}
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
  // Screenshot ingest (paste/drop/browse, ticket 08) runs async; `buildRequest`
  // only ever snapshots already-committed images, so any capture-screen
  // action that fires while a paste is still being read would silently ship
  // without it. Gates Send/Try again/Report on GitHub instead/Save
  // diagnostic bundle - not "confirmed"/"preview" screen actions, which have
  // no attachment UI and can never race an in-flight ingest.
  readonly isIngesting: boolean;
  readonly canSubmit: boolean;
  readonly onCancel: () => void;
  readonly onDone: () => void;
  readonly onBack: () => void;
  readonly onSubmit: () => void;
  readonly onOpenGithubIssue: () => void;
  readonly onReportOnGithub: () => void;
  readonly onPostPubliclyOnGithub: () => void;
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
          onClick={props.onPostPubliclyOnGithub}
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
  if (props.screen === "opened") {
    return (
      <>
        <Button
          variant="outline"
          onClick={props.onSaveDiagnosticBundle}
          disabled={props.isSaveBundlePending}
        >
          {props.isSaveBundlePending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Save diagnostic bundle
        </Button>
        <Button onClick={props.onDone}>Done</Button>
      </>
    );
  }
  if (props.screen === "preview") {
    return (
      <>
        <Button variant="outline" onClick={props.onBack}>
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
        isIngesting={props.isIngesting}
        canSubmit={props.canSubmit}
        onSubmit={props.onSubmit}
        onOpenGithubIssue={props.onOpenGithubIssue}
        onReportOnGithub={props.onReportOnGithub}
        onSaveDiagnosticBundle={props.onSaveDiagnosticBundle}
      />
    </>
  );
}

function captureDescriptionCopy(
  isDeliveryUnavailable: boolean,
  hasErrorEnvelope: boolean,
  preparationIsError: boolean,
): string {
  if (preparationIsError) {
    return "We couldn't prepare private evidence for this report. Nothing was sent; you can still save a diagnostic bundle or open a GitHub issue.";
  }
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

// The legacy context still rides in the submitted report (unchanged from
// before it stopped being prefilled into the textarea) - just appended to
// whatever the user actually typed, rather than masquerading as their words.
function composeIntentForSubmission(
  userIntent: string,
  legacyContext: string,
): string {
  if (legacyContext === "") return userIntent;
  if (userIntent.trim() === "") return legacyContext;
  return `${userIntent}\n\n${legacyContext}`;
}

// Display-only: the captured-context row is one compact line, not the
// multi-paragraph form `composeIntentForSubmission` sends.
function legacyContextSummaryLine(legacyContext: string): string {
  return legacyContext.split("\n\n").join(" · ");
}

// ADV-L6: routes through the exact same `humanRouteLabel` path as the
// evidence review's "Where" row - a genuinely unavailable field (the
// registry never observed a route this session) gets the same generic
// fallback an unmapped-but-known template gets, never a third,
// differently-worded "Current location" string.
function currentLocationLabel(field: CapturedField<string>): string {
  if (field.status === "unavailable") return ROUTE_TEMPLATE_FALLBACK_LABEL;
  return humanRouteLabel(field.value);
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
  return field.status === "stale" ? `${field.value} (last known)` : field.value;
}

// KB3: the "Where" row in the evidence review details is the same raw route
// template as the location selector's current-location option - same fix.
function humanRouteFieldDisplay(
  field: DesktopCapturedField<string> | undefined,
): string | null {
  const raw = capturedFieldDisplay(field);
  return raw === null ? null : humanRouteLabel(raw);
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
        where={humanRouteFieldDisplay(registry?.routeTemplate)}
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

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/**
 * The dialog's attachment target (ticket 08 / T5): paste, drop, and
 * click-to-browse all funnel into `attachments.addFiles`, which owns every
 * attach-time rejection (count/type/size/budget - see
 * `use-report-issue-attachments.ts`). The review-warning line renders only
 * once the first thumbnail exists - never beside an empty target - per the
 * capture flow's wireframe.
 */
function AttachmentSection({
  attachments,
  disabled,
}: {
  readonly attachments: UseReportIssueAttachmentsResult;
  readonly disabled: boolean;
}): ReactNode {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const { images, isIngesting, rejection, canAddMore, addFiles, removeImage } =
    attachments;

  // Paste is handled once, at `CaptureScreenBody`'s outer wrapper - see the
  // comment there. This target still owns drag-drop and click-to-browse.
  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    setIsDragOver(false);
    if (disabled) return;
    if (!hasClaimableFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    const { files } = collectFileTransferEntries(event.dataTransfer);
    const imageFiles = files.filter(isImageFile);
    if (imageFiles.length === 0) return;
    addFiles(imageFiles);
  }

  return (
    <div className="grid gap-1.5">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) addFiles(files);
        }}
      />
      <div
        role="button"
        tabIndex={disabled || !canAddMore ? -1 : 0}
        aria-label="Attach screenshots"
        aria-disabled={disabled || !canAddMore}
        onDragOver={(event) => {
          if (classifyFileTransferDrag(event.dataTransfer) === null) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragEnter={(event) => {
          if (classifyFileTransferDrag(event.dataTransfer) === null) return;
          event.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => {
          if (disabled || !canAddMore) return;
          inputRef.current?.click();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          if (disabled || !canAddMore) return;
          event.preventDefault();
          inputRef.current?.click();
        }}
        className={cn(
          "rounded-md border border-dashed border-border px-3 py-2.5 text-center text-ui-xs text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          !disabled && canAddMore && "cursor-pointer",
          isDragOver && "border-primary bg-primary/5",
          (disabled || !canAddMore) && "cursor-not-allowed opacity-60",
        )}
      >
        {canAddMore
          ? `Paste or drop screenshots (up to ${MAX_REPORT_IMAGES}, kept private)`
          : `${MAX_REPORT_IMAGES} screenshots attached`}
      </div>
      {isIngesting ? (
        <p className="text-ui-xs text-muted-foreground">
          Adding image... Send is disabled until it finishes.
        </p>
      ) : null}
      {rejection !== null ? (
        <p className="text-ui-xs text-destructive">{rejection.message}</p>
      ) : null}
      {images.length > 0 ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {images.map((image) => (
              <AttachmentThumbnail
                key={image.id}
                image={image}
                disabled={disabled}
                onRemove={() => removeImage(image.id)}
              />
            ))}
          </div>
          <p className="text-ui-xs text-muted-foreground">
            Check images for anything you would not share - screens often show
            code.
          </p>
        </>
      ) : null}
    </div>
  );
}

function AttachmentThumbnail({
  image,
  disabled,
  onRemove,
}: {
  readonly image: ReportIssueAttachmentImage;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}): ReactNode {
  return (
    <div className="relative h-[38px] w-14 shrink-0 overflow-hidden rounded border border-border bg-muted">
      <img
        src={image.previewUrl}
        alt={image.fileName}
        className="h-full w-full object-cover"
      />
      <button
        type="button"
        aria-label={`Remove ${image.fileName}`}
        disabled={disabled}
        onClick={onRemove}
        className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground"
      >
        <X className="size-2.5" />
      </button>
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
  // Honest per build: the no-DSN bundle never includes screenshots (a
  // deliberate ticket 08 choice - see `saveDiagnosticBundle`'s own doc
  // comment) and log tails only when their toggle is on below, so the
  // summary must say exactly that rather than implying screenshots are
  // "in the GitHub draft" (the public draft never carries images either -
  // only a private-report reference, and only when one exists).
  const summary = props.deliveryUnavailable
    ? "Included in your diagnostic bundle: your words, type/frequency, and any log tails still toggled on below. Screenshots stay on this device - attach them manually if you post a GitHub issue."
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
    queryKey: runnerQueryKeys.supportFrozenLogTail(
      supportBridgeQueryScopeId(support),
      draftId,
      target,
    ),
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

// KB1: `reportId` is required, not `string | null` - the caller only renders
// this screen when `confirmedReportId` returned non-null, so the false
// "sent privately" state (no private report ever minted) is unrepresentable
// here rather than merely avoided by caller discipline.
function ConfirmationScreen({
  reportId,
}: {
  readonly reportId: string;
}): ReactNode {
  return (
    <div className="grid gap-2 rounded-md border border-emerald-800/40 bg-emerald-950/10 px-3 py-3 text-ui-sm">
      <p className="font-medium text-emerald-600 dark:text-emerald-400">
        Sent privately to the Traycer team.
      </p>
      <p className="flex items-center gap-2 font-mono text-code-xs text-muted-foreground">
        Report ID {reportId}
        <CopyTextButton
          value={reportId}
          label={null}
          ariaLabel="Copy report ID"
          disabled={false}
        />
      </p>
      <p className="text-muted-foreground">
        New reports get a first look within 1 business day.
      </p>
      <p className="text-muted-foreground">
        Want other users to be able to find and follow this?
      </p>
    </div>
  );
}

// KB1's honest terminal state for a public-draft open when nothing was ever
// privately delivered (no-DSN Case B, or a definite `failed`/rejected
// submit) - never the green "Sent privately" confirmation.
function GithubDraftOpenedScreen(): ReactNode {
  return (
    <div className="grid gap-2 rounded-md border border-border bg-muted/20 px-3 py-3 text-ui-sm">
      <p className="font-medium text-foreground">
        GitHub draft opened - finish posting in your browser.
      </p>
      <p className="text-muted-foreground">Nothing was sent from this app.</p>
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
  isIngesting,
  canSubmit,
  onSubmit,
  onOpenGithubIssue,
  onReportOnGithub,
  onSaveDiagnosticBundle,
}: {
  readonly deliveryResult: DesktopSubmitReportResult | null;
  readonly isSubmitPending: boolean;
  readonly isSaveBundlePending: boolean;
  readonly isBuildingDraft: boolean;
  readonly isIngesting: boolean;
  readonly canSubmit: boolean;
  readonly onSubmit: () => void;
  readonly onOpenGithubIssue: () => void;
  readonly onReportOnGithub: () => void;
  readonly onSaveDiagnosticBundle: () => void;
}): ReactNode {
  if (deliveryResult?.status === "unavailable") {
    return (
      <>
        <Button
          variant="outline"
          onClick={onSaveDiagnosticBundle}
          disabled={isSaveBundlePending || isIngesting}
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
        <Button
          onClick={onOpenGithubIssue}
          disabled={isBuildingDraft || isIngesting}
        >
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
          onClick={onReportOnGithub}
          disabled={isBuildingDraft || isIngesting}
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
        <Button onClick={onSubmit} disabled={isSubmitPending || isIngesting}>
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
    <Button
      onClick={onSubmit}
      disabled={isSubmitPending || !canSubmit || isIngesting}
    >
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
