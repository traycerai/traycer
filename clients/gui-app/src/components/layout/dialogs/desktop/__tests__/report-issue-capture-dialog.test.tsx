import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { toast } from "sonner";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type {
  DesktopReportIssueForm,
  DesktopSubmitReportResult,
  DesktopSupportBuildPublicDraftResult,
  DesktopSupportBridge,
  DesktopSupportLogTarget,
  DesktopSupportSnapshot,
} from "@/lib/windows/types";
import { createReportIssueDraftContext } from "@/lib/report-issue-draft-context";
import { captureReportIssueError } from "@/lib/report-issue-error-capture";
import {
  knownField,
  setSupportContextSnapshot,
  __resetSupportContextRegistryForTests,
} from "@/lib/support-context-registry";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { ReportIssueDialogHost } from "@/components/layout/dialogs/report-issue-dialog-host";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

const baseSnapshot: DesktopSupportSnapshot = {
  appName: "Traycer",
  appVersion: "1.2.3",
  platform: "darwin",
  arch: "arm64",
  user: {
    status: "signed-in",
    userName: "Test User",
    email: "test@example.com",
  },
  versions: { electron: "30.0.0", chrome: "124.0.0", node: "22.0.0" },
  host: {
    status: "ready",
    version: "0.4.0",
    pid: 1234,
    hostId: "host-1",
  },
  logs: [
    {
      target: "desktop",
      label: "Desktop Log",
      path: "/tmp/traycer-desktop.log",
    },
    {
      target: "host",
      label: "Host Log",
      path: "/tmp/host.log",
    },
  ],
  links: [],
  supportEmail: "support@traycer.ai",
  privateDeliveryAvailable: true,
};

function bugPublicDraft(
  form: DesktopReportIssueForm,
): DesktopSupportBuildPublicDraftResult {
  return {
    template: "bug_report.yml",
    title: form.overrideTitle ?? form.intent,
    fields: {
      "what-happened": form.intent,
      version: "1.2.3",
      os: "darwin (arm64)",
      component: "Desktop app",
      repro:
        "Not captured step-by-step - see the private support report rpt_test.",
    },
    truncated: false,
  };
}

function ideaPublicDraft(
  form: DesktopReportIssueForm,
): DesktopSupportBuildPublicDraftResult {
  return {
    template: "feature_request.yml",
    title: form.overrideTitle ?? form.intent,
    fields: {
      problem: form.intent,
      proposal: "<!-- Describe the solution you'd like. -->",
      alternatives: "<!-- Any alternatives considered. -->",
      component: "Desktop app",
    },
    truncated: false,
  };
}

function otherPublicDraft(
  form: DesktopReportIssueForm,
): DesktopSupportBuildPublicDraftResult {
  return {
    template: "general.yml",
    title: form.overrideTitle ?? form.intent,
    fields: {
      details: form.intent,
    },
    truncated: false,
  };
}

function publicDraftForForm(
  form: DesktopReportIssueForm,
): DesktopSupportBuildPublicDraftResult {
  if (form.type === "idea") return ideaPublicDraft(form);
  if (form.type === "other") return otherPublicDraft(form);
  return bugPublicDraft(form);
}

interface SupportBridgeHarness {
  readonly openedLinks: string[];
  readonly submittedForms: DesktopReportIssueForm[];
  readonly frozenLogReads: Array<{
    readonly draftId: number;
    readonly target: DesktopSupportLogTarget;
  }>;
  tailLogCalls: number;
  submitReport: (
    form: DesktopReportIssueForm,
  ) => Promise<DesktopSubmitReportResult>;
  buildPublicDraft: (
    form: DesktopReportIssueForm,
  ) => Promise<DesktopSupportBuildPublicDraftResult>;
  openExternalLink: (url: string) => Promise<void>;
  snapshot: DesktopSupportSnapshot;
  frozenDesktopLines: readonly string[];
  frozenHostLines: readonly string[];
}

function createSupportBridgeHarness(overrides: {
  readonly snapshot: DesktopSupportSnapshot | undefined;
  readonly submitReport:
    | ((form: DesktopReportIssueForm) => Promise<DesktopSubmitReportResult>)
    | undefined;
  readonly buildPublicDraft:
    | ((
        form: DesktopReportIssueForm,
      ) => Promise<DesktopSupportBuildPublicDraftResult>)
    | undefined;
  readonly openExternalLink: ((url: string) => Promise<void>) | undefined;
  readonly frozenDesktopLines: readonly string[] | undefined;
  readonly frozenHostLines: readonly string[] | undefined;
}): SupportBridgeHarness {
  const harness: SupportBridgeHarness = {
    openedLinks: [],
    submittedForms: [],
    frozenLogReads: [],
    tailLogCalls: 0,
    snapshot: overrides.snapshot ?? baseSnapshot,
    frozenDesktopLines: overrides.frozenDesktopLines ?? [
      "desktop line one",
      "desktop line two",
    ],
    frozenHostLines: overrides.frozenHostLines ?? ["host line one"],
    submitReport:
      overrides.submitReport ??
      (() =>
        Promise.resolve({
          status: "delivered" as const,
          reportId: "rpt_test",
        })),
    buildPublicDraft:
      overrides.buildPublicDraft ??
      ((form) => Promise.resolve(publicDraftForForm(form))),
    openExternalLink:
      overrides.openExternalLink ??
      ((url) => {
        harness.openedLinks.push(url);
        return Promise.resolve();
      }),
  };
  return harness;
}

function createBaseRunnerHost(): IRunnerHost {
  return {
    signInUrl: "https://auth.example.invalid/sign-in",
    authnBaseUrl: "https://auth.example.invalid",
    relayBaseUrl: "wss://relay.example.invalid/attach",
    hasLocalHost: true,
    validateAuthTokenIdentity: () =>
      Promise.resolve({ kind: "rejected" as const }),
    listRegisteredHosts: () =>
      Promise.resolve({ kind: "network-error" as const }),
    updateHostVersionPolicy: () =>
      Promise.resolve({ kind: "network-error" as const }),
    listUserSessions: () => Promise.resolve({ kind: "network-error" as const }),
    revokeUserSession: () =>
      Promise.resolve({ kind: "network-error" as const }),
    revokeAllSessions: () =>
      Promise.resolve({ kind: "network-error" as const }),
    mintHostCredential: () =>
      Promise.resolve({ kind: "network-error" as const }),
    requestStepUpChallenge: () =>
      Promise.resolve({ kind: "network-error" as const }),
    verifyStepUpChallenge: () =>
      Promise.resolve({ kind: "network-error" as const }),
    openExternalLink: () => Promise.resolve(),
    getRegisteredUrlSchemes: () => Promise.resolve([]),
    requestMicrophoneAccess: () => Promise.resolve("granted" as const),
    openMicrophoneSettings: () => Promise.resolve(),
    beginAuthAttempt: () => undefined,
    onAuthCallback: () => ({ dispose: () => undefined }),
    deviceFlow: { start: () => Promise.resolve(null) },
    secureStorage: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    notifications: {
      show: () => Promise.resolve(),
      onForegroundDisplay: () => ({ dispose: () => undefined }),
      onClick: () => ({ dispose: () => undefined }),
    },
    tray: {
      setEpics: () => Promise.resolve(),
      setIndicator: () => Promise.resolve(),
      onEpicSelected: () => ({ dispose: () => undefined }),
    },
    hostPicker: {
      get isOpen() {
        return false;
      },
      requestOpen: () => undefined,
      requestClose: () => undefined,
      onChange: () => ({ dispose: () => undefined }),
    },
    workspaceFolders: {
      pickFolders: () => Promise.resolve([]),
    },
    fileDrops: {
      resolveDroppedFilePaths: () => Promise.resolve([]),
      copyDroppedFilePaths: (paths) => Promise.resolve(paths),
      readNativeClipboardFilePaths: () => Promise.resolve([]),
    },
    tokenStore: {
      get: () => Promise.resolve(null),
      signIn: () => Promise.resolve(),
      rotate: () =>
        Promise.resolve({ outcome: "deleted" as const, pair: null }),
      delete: () => Promise.resolve(),
      subscribe: () => ({ dispose: () => undefined }),
      migrateLegacyCredentials: () =>
        Promise.resolve("identity-unknown" as const),
    },
    onLocalHostChange: () => ({ dispose: () => undefined }),
    onSystemResumed: () => ({ dispose: () => undefined }),
    requestHostRespawn: () => Promise.resolve({ kind: "restarted" as const }),
    getLastKnownLocalHostId: () => Promise.resolve(null),
    service: null,
    traycerCli: null,
    migration: null,
    hostManagement: null,
    hostTray: null,
    zoom: null,
  };
}

function createRunnerHost(
  harness: SupportBridgeHarness,
): IRunnerHost & { readonly support: DesktopSupportBridge } {
  return Object.assign(createBaseRunnerHost(), {
    openExternalLink: (url: string) => harness.openExternalLink(url),
    support: {
      getSnapshot: () => Promise.resolve(harness.snapshot),
      revealLog: (target: DesktopSupportLogTarget) =>
        Promise.resolve({ target, path: "" }),
      submitReport: (form: DesktopReportIssueForm) => {
        harness.submittedForms.push(form);
        return harness.submitReport(form);
      },
      tailLog: () => {
        harness.tailLogCalls += 1;
        return Promise.resolve({
          target: "desktop" as const,
          path: "",
          lines: [],
          truncated: false,
        });
      },
      freezeEvidence: () => Promise.resolve({ reportId: "rpt_frozen" }),
      discardFrozenEvidence: () => Promise.resolve(),
      readFrozenLogTail: (input: {
        readonly draftId: number;
        readonly target: DesktopSupportLogTarget;
      }) => {
        harness.frozenLogReads.push(input);
        const lines =
          input.target === "desktop"
            ? harness.frozenDesktopLines
            : harness.frozenHostLines;
        return Promise.resolve({
          target: input.target,
          path: `/tmp/frozen-${input.target}.log`,
          lines,
          truncated: false,
        });
      },
      saveDiagnosticBundle: () => Promise.resolve({ path: "/tmp/bundle.json" }),
      getFingerprintOccurrence: () => Promise.resolve(null),
      buildPublicDraft: (form: DesktopReportIssueForm) =>
        harness.buildPublicDraft(form),
    },
  });
}

function buildRouter(runnerHost: IRunnerHost) {
  const rootRoute = createRootRoute({
    component: () => (
      <RunnerHostProvider runnerHost={runnerHost}>
        <ReportIssueDialogHost />
      </RunnerHostProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function renderReportIssueDialog(runnerHost: IRunnerHost) {
  const router = buildRouter(runnerHost);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function flushDialogEffects(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

function resetStores(): void {
  useDesktopDialogStore.getState().close();
  useDesktopDialogStore.setState({
    reportIssueAvailable: false,
    reportIssueDraftId: 0,
    lastConfirmedReport: null,
    reportIssueDraftContext: null,
    reportIssueContext: null,
  });
  __resetSupportContextRegistryForTests();
}

function openManualReport(): void {
  useDesktopDialogStore.getState().openReportIssue();
}

function openErrorTriggeredReport(): void {
  const capture = captureReportIssueError({
    error: new Error("chat.subscribe timed out"),
    componentStack: "in ChatRuntime",
    errorCode: "RPC_ERROR",
    sourceAction: "chat.subscribe",
  });
  const draft = createReportIssueDraftContext({
    title: "Something went wrong",
    message: "The host returned an unexpected response.",
    code: "RPC_ERROR",
    source: "Epic canvas",
    capture,
  });
  useDesktopDialogStore.getState().openReportIssueDraft(draft);
}

function bugIntentField() {
  return screen.getByRole("textbox", {
    name: "What were you trying to do, and what went wrong?",
  });
}

function errorIntentField() {
  return screen.getByRole("textbox", {
    name: "What were you trying to do?",
  });
}

function ideaIntentField() {
  return screen.getByRole("textbox", {
    name: "What's your idea?",
  });
}

function otherIntentField() {
  return screen.getByRole("textbox", {
    name: "What's on your mind?",
  });
}

// VITE_TRAYCER_OSS_REPO is empty in unit tests, so buildGitHubIssueUrl returns
// a path-only string (`/issues/new?...`) that `new URL(url)` rejects. Parse
// the query string directly.
function paramsOfOpenedLink(url: string): URLSearchParams {
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return new URLSearchParams();
  return new URLSearchParams(url.slice(queryStart + 1));
}

function switchState(name: string): string | null {
  return screen.getByRole("switch", { name }).getAttribute("data-state");
}

async function submitSatisfiedManualBug(intent: string): Promise<void> {
  fireEvent.change(bugIntentField(), { target: { value: intent } });
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  expect(
    await screen.findByRole("heading", { name: "Report sent" }),
  ).not.toBeNull();
}

function lastSubmittedForm(
  harness: SupportBridgeHarness,
): DesktopReportIssueForm {
  const form = harness.submittedForms.at(-1);
  if (form === undefined) {
    throw new Error("Expected at least one submitted form.");
  }
  return form;
}

function lastToastErrorOptions(): {
  readonly description: string | undefined;
  readonly actionLabel: string | undefined;
} {
  const calls = vi.mocked(toast.error).mock.calls;
  if (calls.length === 0) {
    return { description: undefined, actionLabel: undefined };
  }
  const options = calls[calls.length - 1]?.[1];
  if (options === undefined) {
    return { description: undefined, actionLabel: undefined };
  }
  const description =
    typeof options.description === "string" ? options.description : undefined;
  const action = options.action;
  const actionLabel =
    action !== undefined &&
    action !== null &&
    typeof action === "object" &&
    "label" in action &&
    typeof action.label === "string"
      ? action.label
      : undefined;
  return { description, actionLabel };
}

describe("Report issue capture dialog (deep interactions)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStores();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
  });

  afterEach(() => {
    cleanup();
    resetStores();
    vi.restoreAllMocks();
  });

  describe("gate focus behavior (D7)", () => {
    it("blocks an empty manual bug submit, focuses intent, shows gate copy, and tracks report_issue_blocked", async () => {
      const track = vi.spyOn(Analytics.getInstance(), "track");
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.click(screen.getByRole("button", { name: "Send report" }));

      expect(
        await screen.findByText(
          "Add a sentence, a screenshot, or pick where it happened - we need at least one to act on the report.",
        ),
      ).not.toBeNull();
      await waitFor(() => {
        expect(document.activeElement).toBe(bugIntentField());
      });
      expect(harness.submittedForms).toEqual([]);
      expect(track).toHaveBeenCalledWith(AnalyticsEvent.ReportIssueBlocked, {
        report_type: "bug",
        blocked_action: "send",
      });
    });

    it("satisfies the gate by typing intent and successfully submits on resubmit", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      await screen.findByText(
        "Add a sentence, a screenshot, or pick where it happened - we need at least one to act on the report.",
      );

      fireEvent.change(bugIntentField(), {
        target: { value: "Sending a message hangs forever" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));

      expect(
        await screen.findByRole("heading", { name: "Report sent" }),
      ).not.toBeNull();
      expect(lastSubmittedForm(harness).intent).toBe(
        "Sending a message hangs forever",
      );
    });

    it("satisfies the gate for idea/other with an attached image and empty intent text", async () => {
      // Mirror the "satisfies the gate by typing intent" shape, but evidence
      // is a screenshot instead of typed text (ticket 08 / D7 hasImages).
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.click(screen.getByRole("radio", { name: "Idea" }));
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      await screen.findByText(
        "Add a sentence or a screenshot - we need at least one to act on the report.",
      );
      expect(harness.submittedForms).toEqual([]);

      await attachPngAndWaitForThumbnail("idea-shot.png");
      expect(
        await screen.findByRole("img", { name: "idea-shot.png" }),
      ).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Send report" }));

      expect(
        await screen.findByRole("heading", { name: "Report sent" }),
      ).not.toBeNull();
      expect(
        screen.queryByText(
          "Add a sentence or a screenshot - we need at least one to act on the report.",
        ),
      ).toBeNull();
      const form = lastSubmittedForm(harness);
      expect(form.type).toBe("idea");
      expect(form.intent).toBe("");
      expect(form.images).toHaveLength(1);
      expect(form.images[0]?.fileName).toBe("idea-shot.png");
      expect(form.images[0]?.mimeType).toBe("image/png");
      expect(form.images[0]?.bytes).toBeInstanceOf(ArrayBuffer);
      expect(form.images[0]?.bytes.byteLength).toBeGreaterThan(0);
    });

    it("satisfies the gate by actively changing the location selector (not the pre-filled current value)", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      // Pre-filled "current" location alone must not satisfy the gate.
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      await screen.findByText(
        "Add a sentence, a screenshot, or pick where it happened - we need at least one to act on the report.",
      );
      expect(harness.submittedForms).toEqual([]);

      fireEvent.click(screen.getByRole("combobox"));
      fireEvent.click(await screen.findByRole("option", { name: "Chat" }));
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));

      expect(
        await screen.findByRole("heading", { name: "Report sent" }),
      ).not.toBeNull();
      expect(lastSubmittedForm(harness).location).toBe("Chat");
      expect(lastSubmittedForm(harness).intent).toBe("");
    });

    it("gates idea/other on text only (no location channel) and tracks the selected type", async () => {
      const track = vi.spyOn(Analytics.getInstance(), "track");
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.click(screen.getByRole("radio", { name: "Idea" }));
      expect(screen.queryByText("Where did this happen?")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      expect(
        await screen.findByText(
          "Add a sentence or a screenshot - we need at least one to act on the report.",
        ),
      ).not.toBeNull();
      expect(track).toHaveBeenCalledWith(AnalyticsEvent.ReportIssueBlocked, {
        report_type: "idea",
        blocked_action: "send",
      });

      fireEvent.change(ideaIntentField(), {
        target: { value: "A keyboard shortcut for forking chats" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      expect(
        await screen.findByRole("heading", { name: "Report sent" }),
      ).not.toBeNull();
      expect(lastSubmittedForm(harness).type).toBe("idea");
    });

    it("never blocks an error-triggered open even with empty intent", async () => {
      const track = vi.spyOn(Analytics.getInstance(), "track");
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openErrorTriggeredReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      expect(errorIntentField()).not.toBeNull();
      expect((errorIntentField() as HTMLTextAreaElement).value).toBe("");
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));

      expect(
        await screen.findByRole("heading", { name: "Report sent" }),
      ).not.toBeNull();
      const blockedCalls = track.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.ReportIssueBlocked,
      );
      expect(blockedCalls).toEqual([]);
      expect(harness.submittedForms).toHaveLength(1);
    });

    it("shows the soft sub-20-char hint without blocking submit", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.change(bugIntentField(), { target: { value: "short text" } });
      expect(
        screen.getByText(
          "A little more detail helps - one short sentence is usually enough.",
        ),
      ).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      expect(
        await screen.findByRole("heading", { name: "Report sent" }),
      ).not.toBeNull();
      expect(
        screen.queryByText(
          "A little more detail helps - one short sentence is usually enough.",
        ),
      ).toBeNull();
    });

    it("hides the soft hint once intent is long enough", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.change(bugIntentField(), { target: { value: "short" } });
      expect(
        screen.getByText(
          "A little more detail helps - one short sentence is usually enough.",
        ),
      ).not.toBeNull();

      fireEvent.change(bugIntentField(), {
        target: { value: "This sentence is definitely longer than twenty." },
      });
      expect(
        screen.queryByText(
          "A little more detail helps - one short sentence is usually enough.",
        ),
      ).toBeNull();
    });
  });

  describe("consent toggles", () => {
    it("starts expanded for error-triggered opens and collapsed for manual opens", async () => {
      const errorHarness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openErrorTriggeredReport();
      renderReportIssueDialog(createRunnerHost(errorHarness));
      await flushDialogEffects();

      expect(switchState("Include App log tail")).toBe("checked");
      expect(switchState("Include Host log tail")).toBe("checked");
      expect(screen.queryByRole("button", { name: "details" })).toBeNull();

      cleanup();
      resetStores();

      const manualHarness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(manualHarness));
      await flushDialogEffects();

      expect(screen.getByRole("button", { name: "details" })).not.toBeNull();
      expect(
        screen.queryByRole("switch", { name: "Include App log tail" }),
      ).toBeNull();
      expect(screen.getByText(/log tails on/)).not.toBeNull();
    });

    it("defaults log toggles OFF for idea/other and back ON for bug unless the user already touched them (D8)", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.click(screen.getByRole("button", { name: "details" }));
      expect(switchState("Include App log tail")).toBe("checked");

      fireEvent.click(screen.getByRole("radio", { name: "Idea" }));
      expect(switchState("Include App log tail")).toBe("unchecked");
      expect(switchState("Include Host log tail")).toBe("unchecked");

      fireEvent.click(screen.getByRole("radio", { name: "Bug" }));
      expect(switchState("Include App log tail")).toBe("checked");
      expect(switchState("Include Host log tail")).toBe("checked");

      // User-touched toggle must not be clobbered by a later type switch.
      fireEvent.click(
        screen.getByRole("switch", { name: "Include App log tail" }),
      );
      expect(switchState("Include App log tail")).toBe("unchecked");
      fireEvent.click(screen.getByRole("radio", { name: "Idea" }));
      expect(switchState("Include App log tail")).toBe("unchecked");
      fireEvent.click(screen.getByRole("radio", { name: "Bug" }));
      expect(switchState("Include App log tail")).toBe("unchecked");
    });

    it("submits includeDesktopLog/includeHostLog:false when the user toggles logs off", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.click(screen.getByRole("button", { name: "details" }));
      fireEvent.click(
        screen.getByRole("switch", { name: "Include App log tail" }),
      );
      fireEvent.click(
        screen.getByRole("switch", { name: "Include Host log tail" }),
      );
      fireEvent.change(bugIntentField(), {
        target: { value: "Logs should be withheld from this report" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));

      await screen.findByRole("heading", { name: "Report sent" });
      const form = lastSubmittedForm(harness);
      expect(form.includeDesktopLog).toBe(false);
      expect(form.includeHostLog).toBe(false);
    });

    it("wires the diagnostics toggle and G1 contact checkbox into the submitted request", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openErrorTriggeredReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      expect(
        screen.getByText("You may contact me at test@example.com"),
      ).not.toBeNull();
      fireEvent.click(
        screen.getByRole("checkbox", {
          name: /You may contact me at test@example.com/,
        }),
      );
      // Diagnostics default on; toggle off so includeDiagnostics is false.
      // main is the sole authority on what that gates - the request still
      // carries privateDiagnostics regardless of the toggle.
      fireEvent.click(
        screen.getByRole("switch", {
          name: "Diagnostics (crash context, versions, provider info)",
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));

      await screen.findByRole("heading", { name: "Report sent" });
      const form = lastSubmittedForm(harness);
      expect(form.allowContact).toBe(true);
      expect(form.includeDiagnostics).toBe(false);
      expect(form.privateDiagnostics).toBeDefined();
    });

    it("hides the contact checkbox when the snapshot has no signed-in email (G1)", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: {
          ...baseSnapshot,
          user: {
            status: "signed-out",
            userName: null,
            email: null,
          },
        },
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.click(screen.getByRole("button", { name: "details" }));
      expect(screen.queryByText(/You may contact me at/)).toBeNull();
      expect(screen.queryByRole("checkbox")).toBeNull();
    });

    it("reads frozen log tails via support.readFrozenLogTail (not tailLog) and renders the lines", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: ["frozen desktop A", "frozen desktop B"],
        frozenHostLines: undefined,
      });
      openErrorTriggeredReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      // The view control sits next to each log switch; first is App log tail.
      const viewButtons = screen.getAllByRole("button", { name: "view" });
      fireEvent.click(viewButtons[0]);

      await waitFor(() => {
        expect(harness.frozenLogReads).toEqual([
          {
            draftId: useDesktopDialogStore.getState().reportIssueDraftId,
            target: "desktop",
          },
        ]);
      });
      expect(harness.tailLogCalls).toBe(0);
      expect(await screen.findByText(/frozen desktop A/)).not.toBeNull();
      expect(screen.getByText(/frozen desktop B/)).not.toBeNull();
    });
  });

  describe("type-chip routing", () => {
    it("updates the intent label and shows the location selector only for manual bug", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      expect(bugIntentField()).not.toBeNull();
      expect(screen.getByText("Where did this happen?")).not.toBeNull();
      // Manual opens never show frequency chips, even on bug.
      expect(screen.queryByText("How often?")).toBeNull();
      expect(screen.queryByRole("button", { name: "Once" })).toBeNull();

      fireEvent.click(screen.getByRole("radio", { name: "Idea" }));
      expect(ideaIntentField()).not.toBeNull();
      expect(screen.queryByText("Where did this happen?")).toBeNull();
      expect(screen.queryByText("How often?")).toBeNull();

      fireEvent.click(screen.getByRole("radio", { name: "Something else" }));
      expect(otherIntentField()).not.toBeNull();
      expect(screen.queryByText("Where did this happen?")).toBeNull();
    });

    it("submits the selected type field end-to-end", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.click(screen.getByRole("radio", { name: "Something else" }));
      fireEvent.change(otherIntentField(), {
        target: { value: "I am not sure how to categorize this" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      await screen.findByRole("heading", { name: "Report sent" });
      expect(lastSubmittedForm(harness).type).toBe("other");
    });

    it("shows frequency chips only for error-triggered opens (never for manual)", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openErrorTriggeredReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      expect(screen.getByText("How often?")).not.toBeNull();
      expect(screen.getByRole("button", { name: "Once" })).not.toBeNull();
      expect(screen.getByRole("button", { name: "Not sure" })).not.toBeNull();
      // Error-triggered opens have no type chips / location selector.
      expect(screen.queryByRole("radio", { name: "Bug" })).toBeNull();
      expect(screen.queryByText("Where did this happen?")).toBeNull();
    });
  });

  describe("route template labeling (KB3)", () => {
    it("shows a human label for the route template in the expanded evidence review, never the raw path", async () => {
      setSupportContextSnapshot({ routeTemplate: knownField("/") });
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openErrorTriggeredReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.click(screen.getByRole("button", { name: "Review" }));
      expect(screen.getByText("Where")).not.toBeNull();
      expect(screen.getByText("Start page")).not.toBeNull();
    });

    it("shows the typed label for the current route on a plain manual open, never 'Current location' (ADV-L6)", async () => {
      // The plain manual open never assembles a `draftContext` at all
      // (`openReportIssue()` sets it to null) - this is the actual repro:
      // the current-location option must still read the live registry.
      setSupportContextSnapshot({ routeTemplate: knownField("/") });
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.click(screen.getByRole("combobox"));
      expect(
        await screen.findByRole("option", { name: "Start page (current)" }),
      ).not.toBeNull();
      expect(
        screen.queryByRole("option", { name: "Current location (current)" }),
      ).toBeNull();
      expect(screen.queryByRole("option", { name: "/ (current)" })).toBeNull();
    });

    it("falls back to the shared generic label, never 'Current location', when the registry never observed a route", async () => {
      // `setSupportContextSnapshot` untouched this test - the registry stays
      // at its all-`unavailable` reset state.
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.click(screen.getByRole("combobox"));
      expect(
        await screen.findByRole("option", { name: "This screen (current)" }),
      ).not.toBeNull();
      expect(
        screen.queryByRole("option", { name: "Current location (current)" }),
      ).toBeNull();
    });
  });

  describe("delivery states", () => {
    it("renders the delivered confirmation with a copyable report id", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () =>
          Promise.resolve({ status: "delivered", reportId: "rpt_delivered" }),
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();
      await submitSatisfiedManualBug("delivered path works");

      expect(screen.getByText(/rpt_delivered/)).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Copy report ID" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Also post publicly on GitHub" }),
      ).not.toBeNull();
    });

    it("keeps the dialog open on unconfirmed with honest copy and a preview-gated GitHub fallback", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () =>
          Promise.resolve({
            status: "unconfirmed",
            reportId: "rpt_unconfirmed",
          }),
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.change(bugIntentField(), {
        target: { value: "Unconfirmed delivery should not claim failure" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(
        "We could not confirm your report was uploaded",
      );
      expect(useDesktopDialogStore.getState().activeDialog).toBe(
        "report-issue",
      );
      expect(
        screen.getByRole("button", { name: "Report on GitHub instead" }),
      ).not.toBeNull();
      expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();
      expect(harness.openedLinks).toEqual([]);

      // Fallback must go through the publish PREVIEW, never open immediately.
      fireEvent.click(
        screen.getByRole("button", { name: "Report on GitHub instead" }),
      );
      expect(
        await screen.findByRole("heading", {
          name: "Preview the public issue",
        }),
      ).not.toBeNull();
      expect(harness.openedLinks).toEqual([]);
    });

    it("retries an unconfirmed submit with Try again using the same form state", async () => {
      let calls = 0;
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () => {
          calls += 1;
          if (calls === 1) {
            return Promise.resolve({
              status: "unconfirmed",
              reportId: "rpt_unconfirmed",
            });
          }
          return Promise.resolve({
            status: "delivered",
            reportId: "rpt_unconfirmed",
          });
        },
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      const intent = "Retry keeps the typed intent";
      fireEvent.change(bugIntentField(), { target: { value: intent } });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      await screen.findByRole("alert");
      expect(screen.getByDisplayValue(intent)).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(
        await screen.findByRole("heading", { name: "Report sent" }),
      ).not.toBeNull();
      expect(calls).toBe(2);
      expect(harness.submittedForms).toHaveLength(2);
      expect(harness.submittedForms[0]?.intent).toBe(intent);
      expect(harness.submittedForms[1]?.intent).toBe(intent);
    });

    it("renders the failed delivery banner with the same retry/fallback shape", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () =>
          Promise.resolve({ status: "failed", reason: "error" }),
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.change(bugIntentField(), {
        target: { value: "Failed delivery should keep the form" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(
        "Your report could not be sent. Nothing was lost - it is still here.",
      );
      expect(
        screen.getByRole("button", { name: "Report on GitHub instead" }),
      ).not.toBeNull();
      expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();
      expect(
        screen.getByDisplayValue("Failed delivery should keep the form"),
      ).not.toBeNull();
      expect(harness.openedLinks).toEqual([]);

      fireEvent.click(
        screen.getByRole("button", { name: "Report on GitHub instead" }),
      );
      expect(
        await screen.findByRole("heading", {
          name: "Preview the public issue",
        }),
      ).not.toBeNull();
      expect(harness.openedLinks).toEqual([]);
    });

    it("maps a rejected submitReport promise to the same failed retry/fallback shape", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () => Promise.reject(new Error("IPC bridge exploded")),
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.change(bugIntentField(), {
        target: { value: "Rejected promise should not be a dead end" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(
        "Your report could not be sent. Nothing was lost - it is still here.",
      );
      expect(
        screen.getByRole("button", { name: "Report on GitHub instead" }),
      ).not.toBeNull();
      expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();
      expect(
        screen.getByDisplayValue("Rejected promise should not be a dead end"),
      ).not.toBeNull();
      expect(harness.openedLinks).toEqual([]);
    });

    it("states unavailable up front with no Send round-trip when privateDeliveryAvailable is false", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: { ...baseSnapshot, privateDeliveryAvailable: false },
        submitReport: () => {
          throw new Error("submitReport must not be called up front");
        },
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      expect(
        screen.getByText(
          "Private reporting is not available in this build. You can save a diagnostic bundle and open a GitHub issue instead.",
        ),
      ).not.toBeNull();
      expect(screen.queryByRole("button", { name: "Send report" })).toBeNull();
      expect(
        screen.getByRole("button", { name: "Save diagnostic bundle" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Open a GitHub issue" }),
      ).not.toBeNull();
      expect(harness.submittedForms).toEqual([]);
    });

    it("fails closed when the support snapshot cannot be loaded", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () => {
          throw new Error("submitReport must not be called without a snapshot");
        },
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      const runnerHost = createRunnerHost(harness);
      const support = runnerHost.support;
      openManualReport();
      renderReportIssueDialog(
        Object.assign(runnerHost, {
          support: {
            ...support,
            getSnapshot: () => Promise.reject(new Error("snapshot failed")),
          },
        }),
      );

      expect(
        await screen.findByText(
          "Private reporting is not available in this build. You can save a diagnostic bundle and open a GitHub issue instead.",
        ),
      ).not.toBeNull();
      expect(screen.queryByRole("button", { name: "Send report" })).toBeNull();
      expect(harness.submittedForms).toEqual([]);
    });

    it("fails closed to public and bundle fallbacks when evidence freezing fails", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () => {
          throw new Error("submitReport must not run without frozen evidence");
        },
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      const runnerHost = createRunnerHost(harness);
      const support = runnerHost.support;
      openManualReport();
      renderReportIssueDialog(
        Object.assign(runnerHost, {
          support: {
            ...support,
            freezeEvidence: () =>
              Promise.reject(new Error("could not freeze evidence")),
          },
        }),
      );

      expect(
        await screen.findByText(
          "We couldn't prepare private evidence for this report. Nothing was sent; you can still save a diagnostic bundle or open a GitHub issue.",
        ),
      ).not.toBeNull();
      expect(screen.queryByRole("button", { name: "Send report" })).toBeNull();
      expect(
        screen.getByRole("button", { name: "Save diagnostic bundle" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Open a GitHub issue" }),
      ).not.toBeNull();
      expect(harness.submittedForms).toEqual([]);
    });

    it("renders unavailable after a submit that returns status unavailable", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () => Promise.resolve({ status: "unavailable" }),
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.change(bugIntentField(), {
        target: { value: "Submit-time unavailable path" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(
        "Private reporting is not available in this build",
      );
      expect(
        screen.getByRole("button", { name: "Save diagnostic bundle" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Open a GitHub issue" }),
      ).not.toBeNull();
      expect(harness.submittedForms).toHaveLength(1);
    });

    it("blocks 'Open a GitHub issue' and 'Save diagnostic bundle' with no evidence, same as Send (N1)", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: { ...baseSnapshot, privateDeliveryAvailable: false },
        submitReport: undefined,
        buildPublicDraft: () => {
          throw new Error(
            "buildPublicDraft must not be called while the gate is unsatisfied",
          );
        },
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.click(
        screen.getByRole("button", { name: "Open a GitHub issue" }),
      );
      expect(
        await screen.findByText(
          "Add a sentence, a screenshot, or pick where it happened - we need at least one to act on the report.",
        ),
      ).not.toBeNull();
      expect(
        screen.getByRole("heading", { name: "Report an issue" }),
      ).not.toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: "Save diagnostic bundle" }),
      );
      expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
      expect(
        screen.getByRole("heading", { name: "Report an issue" }),
      ).not.toBeNull();
    });

    it("blocks 'Report on GitHub instead' if the user clears their text after a failed submit (N1)", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () =>
          Promise.resolve({ status: "failed", reason: "error" }),
        buildPublicDraft: () => {
          throw new Error(
            "buildPublicDraft must not be called while the gate is unsatisfied",
          );
        },
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.change(bugIntentField(), {
        target: { value: "Failed delivery, about to clear this" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      await screen.findByRole("alert");

      fireEvent.change(bugIntentField(), { target: { value: "" } });
      fireEvent.click(
        screen.getByRole("button", { name: "Report on GitHub instead" }),
      );

      expect(
        await screen.findByText(
          "Add a sentence, a screenshot, or pick where it happened - we need at least one to act on the report.",
        ),
      ).not.toBeNull();
      expect(
        screen.queryByRole("heading", { name: "Preview the public issue" }),
      ).toBeNull();
    });

    it("returns Back from the no-DSN preview to capture, not confirmed (KB1)", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: { ...baseSnapshot, privateDeliveryAvailable: false },
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.change(bugIntentField(), {
        target: { value: "No private channel in this build" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Open a GitHub issue" }),
      );
      expect(
        await screen.findByRole("heading", {
          name: "Preview the public issue",
        }),
      ).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      expect(
        await screen.findByRole("heading", { name: "Report an issue" }),
      ).not.toBeNull();
      expect(screen.queryByRole("heading", { name: "Report sent" })).toBeNull();
      expect(
        screen.getByDisplayValue("No private channel in this build"),
      ).not.toBeNull();
    });

    it("opens the honest 'GitHub draft opened' state on a no-DSN publish, never the private-send confirmation (KB1)", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: { ...baseSnapshot, privateDeliveryAvailable: false },
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.change(bugIntentField(), {
        target: { value: "No private channel, opening GitHub instead" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Open a GitHub issue" }),
      );
      await screen.findByRole("heading", { name: "Preview the public issue" });

      fireEvent.click(
        screen.getByRole("button", { name: "Open GitHub draft" }),
      );

      expect(
        await screen.findByRole("heading", { name: "GitHub draft opened" }),
      ).not.toBeNull();
      expect(
        screen.getByText("Nothing was sent from this app."),
      ).not.toBeNull();
      expect(screen.queryByRole("heading", { name: "Report sent" })).toBeNull();
      expect(
        screen.queryByText("Sent privately to the Traycer team."),
      ).toBeNull();
      expect(harness.openedLinks).toHaveLength(1);
    });

    it("opens the honest 'GitHub draft opened' state after a definite failed submit's GitHub fallback, never confirms (KB1)", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () =>
          Promise.resolve({ status: "failed", reason: "error" }),
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.change(bugIntentField(), {
        target: { value: "Failed delivery, falling back to GitHub" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      await screen.findByRole("alert");

      fireEvent.click(
        screen.getByRole("button", { name: "Report on GitHub instead" }),
      );
      await screen.findByRole("heading", { name: "Preview the public issue" });
      fireEvent.click(
        screen.getByRole("button", { name: "Open GitHub draft" }),
      );

      expect(
        await screen.findByRole("heading", { name: "GitHub draft opened" }),
      ).not.toBeNull();
      expect(screen.queryByRole("heading", { name: "Report sent" })).toBeNull();
    });

    it("still reaches the confirmed screen after an unconfirmed submit's GitHub fallback - a reportId exists, only the upload is unconfirmed (KB1)", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () =>
          Promise.resolve({
            status: "unconfirmed",
            reportId: "rpt_unconf_open",
          }),
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.change(bugIntentField(), {
        target: { value: "Unconfirmed delivery, also opening GitHub" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      await screen.findByRole("alert");

      fireEvent.click(
        screen.getByRole("button", { name: "Report on GitHub instead" }),
      );
      await screen.findByRole("heading", { name: "Preview the public issue" });
      fireEvent.click(
        screen.getByRole("button", { name: "Open GitHub draft" }),
      );

      expect(
        await screen.findByRole("heading", { name: "Report sent" }),
      ).not.toBeNull();
      expect(screen.getByText(/rpt_unconf_open/)).not.toBeNull();
    });
  });

  describe("confirmation persistence", () => {
    it("toasts the prior report id when a new report replaces a live confirmation (G2)", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () =>
          Promise.resolve({ status: "delivered", reportId: "rpt_prior" }),
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();
      await submitSatisfiedManualBug("first report");

      expect(screen.getByText(/rpt_prior/)).not.toBeNull();
      const priorDraftId = useDesktopDialogStore.getState().reportIssueDraftId;

      act(() => {
        useDesktopDialogStore.getState().openReportIssue();
      });
      await flushDialogEffects();

      expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
        "Your previous report is safe",
        { description: "Report ID rpt_prior" },
      );
      expect(useDesktopDialogStore.getState().reportIssueDraftId).not.toBe(
        priorDraftId,
      );
      // Replacement lands back on capture for a fresh draft.
      expect(
        screen.getByRole("heading", { name: "Report an issue" }),
      ).not.toBeNull();
    });

    it("does not toast when the confirmation is dismissed via Done before a later reopen", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () =>
          Promise.resolve({ status: "delivered", reportId: "rpt_done" }),
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();
      await submitSatisfiedManualBug("done path");

      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() => {
        expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
      });
      expect(useDesktopDialogStore.getState().lastConfirmedReport).toBeNull();
      vi.mocked(toast.info).mockClear();

      act(() => {
        useDesktopDialogStore.getState().openReportIssue();
      });
      await flushDialogEffects();

      expect(vi.mocked(toast.info)).not.toHaveBeenCalled();
      expect(
        screen.getByRole("heading", { name: "Report an issue" }),
      ).not.toBeNull();
    });

    it("keeps the confirmation when buildPublicDraft rejects from Also post publicly, with a retryable toast", async () => {
      let buildCalls = 0;
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () =>
          Promise.resolve({ status: "delivered", reportId: "rpt_keep" }),
        buildPublicDraft: () => {
          buildCalls += 1;
          return Promise.reject(new Error("draft build failed"));
        },
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();
      await submitSatisfiedManualBug("preview build failure must not wipe id");

      fireEvent.click(
        screen.getByRole("button", { name: "Also post publicly on GitHub" }),
      );

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
          "Could not load the GitHub preview",
          expect.anything(),
        );
      });
      const previewError = lastToastErrorOptions();
      expect(previewError.description).toBe(
        "Your report is safe - you can try again. draft build failed",
      );
      expect(previewError.actionLabel).toBe("Try again");
      expect(buildCalls).toBe(1);
      // Confirmation must still be showing with the report id.
      expect(
        screen.getByRole("heading", { name: "Report sent" }),
      ).not.toBeNull();
      expect(screen.getByText(/rpt_keep/)).not.toBeNull();
      expect(harness.openedLinks).toEqual([]);
    });
  });

  describe("preview flow", () => {
    async function reachConfirmedPreview(
      harness: SupportBridgeHarness,
      intent: string,
    ): Promise<void> {
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();
      await submitSatisfiedManualBug(intent);
      fireEvent.click(
        screen.getByRole("button", { name: "Also post publicly on GitHub" }),
      );
      expect(
        await screen.findByRole("heading", {
          name: "Preview the public issue",
        }),
      ).not.toBeNull();
    }

    it("shows the draft title, per-field body, GitHub-account notice, and Back without opening anything", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () =>
          Promise.resolve({ status: "delivered", reportId: "rpt_preview" }),
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      await reachConfirmedPreview(
        harness,
        "Preview body should list bug fields",
      );

      const titleInput = screen.getByLabelText("Title");
      if (!(titleInput instanceof HTMLInputElement)) {
        throw new Error("Expected the preview title input.");
      }
      expect(titleInput.value).toBe("Preview body should list bug fields");
      expect(screen.getByText("What happened")).not.toBeNull();
      expect(screen.getByText("Steps to reproduce")).not.toBeNull();
      expect(
        screen.getByText(/Publishing needs a GitHub account/),
      ).not.toBeNull();
      expect(harness.openedLinks).toEqual([]);

      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      expect(
        await screen.findByRole("heading", { name: "Report sent" }),
      ).not.toBeNull();
      expect(screen.getByText(/rpt_preview/)).not.toBeNull();
      expect(harness.openedLinks).toEqual([]);
    });

    it("feeds the edited title into the opened URL title query param", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () =>
          Promise.resolve({ status: "delivered", reportId: "rpt_title" }),
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      await reachConfirmedPreview(harness, "Original draft title");

      const titleInput = screen.getByLabelText("Title");
      fireEvent.change(titleInput, {
        target: { value: "Edited public title" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Open GitHub draft" }),
      );

      await waitFor(() => {
        expect(harness.openedLinks).toHaveLength(1);
      });
      const params = paramsOfOpenedLink(harness.openedLinks[0] ?? "");
      expect(params.get("title")).toBe("Edited public title");
      expect(params.get("template")).toBe("bug_report.yml");
      expect(
        await screen.findByRole("heading", { name: "Report sent" }),
      ).not.toBeNull();
    });

    it("keeps the preview on openExternalLink failure with a retryable toast", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () =>
          Promise.resolve({ status: "delivered", reportId: "rpt_openfail" }),
        buildPublicDraft: undefined,
        openExternalLink: () => Promise.reject(new Error("no browser")),
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      await reachConfirmedPreview(harness, "Open failure stays on preview");

      fireEvent.click(
        screen.getByRole("button", { name: "Open GitHub draft" }),
      );

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
          "Could not open the GitHub draft",
          expect.anything(),
        );
      });
      const openError = lastToastErrorOptions();
      expect(openError.description).toBe(
        "Your report is safe - you can try opening it again. no browser",
      );
      expect(openError.actionLabel).toBe("Try again");
      expect(
        screen.getByRole("heading", { name: "Preview the public issue" }),
      ).not.toBeNull();
      expect(harness.openedLinks).toEqual([]);
    });

    it("routes an idea-type report through feature_request.yml fields and template param", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () =>
          Promise.resolve({ status: "delivered", reportId: "rpt_idea" }),
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.click(screen.getByRole("radio", { name: "Idea" }));
      fireEvent.change(ideaIntentField(), {
        target: { value: "Fork chats from the palette" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      await screen.findByRole("heading", { name: "Report sent" });
      fireEvent.click(
        screen.getByRole("button", { name: "Also post publicly on GitHub" }),
      );
      await screen.findByRole("heading", { name: "Preview the public issue" });

      expect(screen.getByText("Problem / motivation")).not.toBeNull();
      expect(screen.getByText("Proposed solution")).not.toBeNull();
      expect(screen.getByText("Alternatives considered")).not.toBeNull();
      expect(screen.queryByText("What happened")).toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: "Open GitHub draft" }),
      );
      await waitFor(() => {
        expect(harness.openedLinks).toHaveLength(1);
      });
      const ideaParams = paramsOfOpenedLink(harness.openedLinks[0] ?? "");
      expect(ideaParams.get("template")).toBe("feature_request.yml");
      expect(ideaParams.get("title")).toBe("Fork chats from the palette");
    });

    it("routes an other-type report through general.yml fields and template param", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () =>
          Promise.resolve({ status: "delivered", reportId: "rpt_other" }),
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.click(screen.getByRole("radio", { name: "Something else" }));
      fireEvent.change(otherIntentField(), {
        target: { value: "General feedback about the dark theme" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      await screen.findByRole("heading", { name: "Report sent" });
      fireEvent.click(
        screen.getByRole("button", { name: "Also post publicly on GitHub" }),
      );
      await screen.findByRole("heading", { name: "Preview the public issue" });

      expect(screen.getByText("Details")).not.toBeNull();
      expect(screen.queryByText("What happened")).toBeNull();
      expect(screen.queryByText("Problem / motivation")).toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: "Open GitHub draft" }),
      );
      await waitFor(() => {
        expect(harness.openedLinks).toHaveLength(1);
      });
      const otherParams = paramsOfOpenedLink(harness.openedLinks[0] ?? "");
      expect(otherParams.get("template")).toBe("general.yml");
    });
  });

  describe("image attachments (ticket 08 / T5)", () => {
    beforeEach(() => {
      URL.createObjectURL = vi.fn(() => "blob:mock/report-shot");
      URL.revokeObjectURL = vi.fn();
    });

    it("attaches a File via the hidden file input and shows a thumbnail", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      await attachPngAndWaitForThumbnail("from-input.png");

      expect(
        await screen.findByRole("img", { name: "from-input.png" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Remove from-input.png" }),
      ).not.toBeNull();
    });

    it("attaches via drop on the attachment target", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      const target = screen.getByRole("button", { name: "Attach screenshots" });
      fireEvent.drop(target, {
        dataTransfer: makeFileTransfer([makePngFile("dropped.png")]),
      });

      expect(
        await screen.findByRole("img", { name: "dropped.png" }),
      ).not.toBeNull();
    });

    it("ignores drops while report submission disables attachments", async () => {
      let finishSubmit!: (result: DesktopSubmitReportResult) => void;
      const submitPending = new Promise<DesktopSubmitReportResult>(
        (resolve) => {
          finishSubmit = resolve;
        },
      );
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: () => submitPending,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();
      fireEvent.change(bugIntentField(), {
        target: { value: "Submitting while a screenshot is dropped" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send report" }));

      const target = screen.getByRole("button", { name: "Attach screenshots" });
      await waitFor(() => {
        expect(target.getAttribute("aria-disabled")).toBe("true");
      });
      fireEvent.drop(target, {
        dataTransfer: makeFileTransfer([makePngFile("ignored.png")]),
      });
      expect(screen.queryByRole("img", { name: "ignored.png" })).toBeNull();

      finishSubmit({ status: "delivered", reportId: "rpt_test" });
      expect(
        await screen.findByRole("heading", { name: "Report sent" }),
      ).not.toBeNull();
    });

    it("attaches via paste on the attachment target", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      const target = screen.getByRole("button", { name: "Attach screenshots" });
      fireEvent.paste(target, {
        clipboardData: makeFileTransfer([makePngFile("pasted.png")]),
      });

      expect(
        await screen.findByRole("img", { name: "pasted.png" }),
      ).not.toBeNull();
    });

    it("surfaces an attach-time count rejection before any submit attempt", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      await attachPngAndWaitForThumbnail("one.png");
      await attachPngAndWaitForThumbnail("two.png");
      await attachPngAndWaitForThumbnail("three.png");
      await screen.findByRole("img", { name: "three.png" });

      // 4th attach must show the count rejection inline, before Send.
      await attachPngViaFileInput("four.png", { expectThumbnail: false });
      expect(
        await screen.findByText("You can attach up to 3 screenshots."),
      ).not.toBeNull();
      expect(harness.submittedForms).toEqual([]);
      expect(screen.queryByRole("img", { name: "four.png" })).toBeNull();
    });

    it("removes a thumbnail when its remove button is pressed", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      await attachPngAndWaitForThumbnail("removable.png");
      expect(
        await screen.findByRole("img", { name: "removable.png" }),
      ).not.toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: "Remove removable.png" }),
      );

      await waitFor(() => {
        expect(screen.queryByRole("img", { name: "removable.png" })).toBeNull();
      });
    });

    it("shows the review-warning copy only after the first thumbnail exists", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      const warning =
        "Check images for anything you would not share - screens often show code.";
      expect(screen.queryByText(warning)).toBeNull();

      await attachPngAndWaitForThumbnail("warned.png");
      expect(await screen.findByText(warning)).not.toBeNull();
    });

    it("includes attached image fileName/mimeType/bytes on the submitted form", async () => {
      const track = vi.spyOn(Analytics.getInstance(), "track");
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.change(bugIntentField(), {
        target: { value: "Bug with a screenshot" },
      });
      await attachPngAndWaitForThumbnail("submit-me.png");
      await screen.findByRole("img", { name: "submit-me.png" });

      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      expect(
        await screen.findByRole("heading", { name: "Report sent" }),
      ).not.toBeNull();

      const form = lastSubmittedForm(harness);
      expect(form.images).toHaveLength(1);
      expect(form.images[0]?.fileName).toBe("submit-me.png");
      expect(form.images[0]?.mimeType).toBe("image/png");
      expect(form.images[0]?.bytes).toBeInstanceOf(ArrayBuffer);
      expect(form.images[0]?.bytes.byteLength).toBeGreaterThan(0);
      expect(track).toHaveBeenCalledWith(
        AnalyticsEvent.ReportIssuePrivateSubmit,
        {
          outcome: "confirmed",
          blocker: null,
          attachment_count: 1,
        },
      );
    });

    it("sends an image-only report end to end with no typed text (G15)", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      // The gate is satisfied by the image alone (tech-plan T4/T5's "text or
      // image, either satisfies") - Send must complete without ever typing
      // into the intent field.
      await attachPngAndWaitForThumbnail("image-only.png");
      await screen.findByRole("img", { name: "image-only.png" });
      const intentField = bugIntentField();
      if (!(intentField instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the intent textarea.");
      }
      expect(intentField.value).toBe("");

      fireEvent.click(screen.getByRole("button", { name: "Send report" }));
      expect(
        await screen.findByRole("heading", { name: "Report sent" }),
      ).not.toBeNull();

      const form = lastSubmittedForm(harness);
      expect(form.intent).toBe("");
      expect(form.images).toHaveLength(1);
      expect(form.images[0]?.fileName).toBe("image-only.png");
    });

    it("disables Send while an image is mid-ingest so a just-pasted screenshot cannot be silently omitted", async () => {
      const harness = createSupportBridgeHarness({
        snapshot: undefined,
        submitReport: undefined,
        buildPublicDraft: undefined,
        openExternalLink: undefined,
        frozenDesktopLines: undefined,
        frozenHostLines: undefined,
      });
      openManualReport();
      renderReportIssueDialog(createRunnerHost(harness));
      await flushDialogEffects();

      fireEvent.change(bugIntentField(), {
        target: { value: "Send must wait for the ingest to finish" },
      });

      const target = screen.getByRole("button", { name: "Attach screenshots" });
      fireEvent.paste(target, {
        clipboardData: makeFileTransfer([makePngFile("mid-flight.png")]),
      });

      // The file read is still in flight - Send must stay disabled and say why.
      const sendButton = screen.getByRole("button", { name: "Send report" });
      if (!(sendButton instanceof HTMLButtonElement)) {
        throw new Error("Expected the Send report button.");
      }
      expect(sendButton.disabled).toBe(true);
      expect(
        screen.getByText("Adding image... Send is disabled until it finishes."),
      ).not.toBeNull();
      fireEvent.click(sendButton);
      expect(harness.submittedForms).toEqual([]);

      await screen.findByRole("img", { name: "mid-flight.png" });
      await waitFor(() => {
        expect(sendButton.disabled).toBe(false);
      });

      fireEvent.click(sendButton);
      await screen.findByRole("heading", { name: "Report sent" });
      expect(lastSubmittedForm(harness).images).toHaveLength(1);
    });
  });
});

// --- image attachment helpers (ticket 08) ---------------------------------

function makePngFile(name: string): File {
  const bytes = new Uint8Array(32);
  bytes[0] = 0x89;
  bytes[1] = 0x50;
  bytes[2] = 0x4e;
  bytes[3] = 0x47;
  return new File([bytes], name, { type: "image/png" });
}

interface FileTransferLike {
  readonly files: ReadonlyArray<File>;
  readonly types: ReadonlyArray<string>;
  readonly items: ReadonlyArray<{
    readonly kind: string;
    readonly type: string;
    getAsFile: () => File | null;
  }>;
  getData: (type: string) => string;
}

function makeFileTransfer(files: ReadonlyArray<File>): FileTransferLike {
  return {
    files,
    types: files.length > 0 ? ["Files"] : [],
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
    })),
    getData: () => "",
  };
}

async function attachPngViaFileInput(
  fileName: string,
  options: { readonly expectThumbnail: boolean },
): Promise<void> {
  const input = document.querySelector(
    'input[type="file"][accept*="image/png"]',
  );
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Expected hidden image file input in the dialog");
  }
  const file = makePngFile(fileName);
  // jsdom does not let tests assign to input.files directly; fire change
  // with a FileList-shaped value via Object.defineProperty.
  Object.defineProperty(input, "files", {
    configurable: true,
    value: {
      0: file,
      length: 1,
      item: (index: number) => (index === 0 ? file : null),
      [Symbol.iterator]: function* () {
        yield file;
      },
    },
  });
  fireEvent.change(input);
  if (options.expectThumbnail) {
    await waitFor(() => {
      expect(screen.getByRole("img", { name: fileName })).not.toBeNull();
    });
  } else {
    // Let the async ingest loop settle without requiring a thumbnail.
    await act(async () => {
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
    });
  }
}

async function attachPngAndWaitForThumbnail(fileName: string): Promise<void> {
  await attachPngViaFileInput(fileName, { expectThumbnail: true });
}
