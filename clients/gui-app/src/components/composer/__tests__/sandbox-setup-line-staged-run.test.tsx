import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { SANDBOX_RATE_LIMIT_FIXTURE } from "@traycer/protocol/host/__tests__/sandbox-rate-limit-fixture";
import { sandboxSummarySchema } from "@traycer/protocol/host/sandbox-control";
import {
  runStagedSandbox,
  type StagedSandboxRunDeps,
} from "@/lib/sandboxes/staged-sandbox-run";
import {
  holdHandoffOwner,
  ownerGoneOnUnmount,
  readStagedSandbox,
  useStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import {
  SandboxSetupLine,
  type SandboxSetupLineActions,
  type SandboxSetupLineFacts,
} from "@/components/composer/sandbox-setup-line";
import {
  harness as baseHarness,
  listOf,
  PERSONAL_NEW,
  row,
  type ScriptedDirectory,
} from "@/lib/sandboxes/__tests__/staged-sandbox-run-harness";

/**
 * The one scenario the server's shared fixture and the GUI's rendering must
 * agree on end to end: a real `runStagedSandbox`, driving the real staged
 * sandbox store, with a real `SandboxSetupLine` subscribed to it and
 * rendering live — no handcrafted `rateLimit` prop, and the same
 * `SANDBOX_RATE_LIMIT_FIXTURE` the server's real-chain test asserts the
 * adapter persisted. A drift between what the server actually serializes and
 * what this component is built to read fails here, not only in a unit test
 * that already assumes they agree.
 */

vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://example.test/billing",
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

afterEach(cleanup);

const ACTIONS: SandboxSetupLineActions = {
  onKeepWaiting: () => undefined,
  onCancel: () => undefined,
  onChooseAnotherHost: null,
  chooseAnotherHostLabel: "Use This computer",
  onRetryCreation: () => undefined,
  onRetry: () => undefined,
  onSendAgain: () => undefined,
  onChangeShape: null,
  onRetryApplying: null,
  onRepairSetup: null,
  onStop: () => undefined,
  onOpenTerminal: null,
};

/** Never stoppable, never resting: the title order's queued branch decides. */
const FACTS: SandboxSetupLineFacts = {
  costLine: "",
  regionLabel: "US East",
  shapeLabel: "2 vCPU · 4 GB",
  smallerShapeAffordable: false,
  offeredAgents: null,
  sandboxAwake: null,
  sandboxStoppable: false,
  sandboxResting: false,
};

function RenderedSetupLine(props: { readonly surfaceKey: string }) {
  const stage = useStagedSandbox(props.surfaceKey);
  if (stage === null) return null;
  return (
    <SandboxSetupLine
      stage={stage}
      name="api-refactor"
      facts={FACTS}
      actions={ACTIONS}
    />
  );
}

let surfaceCount = 0;
let surfaceKey = "";
let directory: ScriptedDirectory | null = null;

beforeEach(() => {
  surfaceCount += 1;
  surfaceKey = `landing:setup-line-integration-${surfaceCount}`;
  useStagedSandboxStore.setState({ bySurface: {} });
  useSurfaceHostSelectionStore.setState({ selections: {} });
  useLandingPanelStore.getState().resetForTests();
});

afterEach(() => {
  directory?.dispose();
  directory = null;
});

describe("SandboxSetupLine, rendered live against a real runStagedSandbox", () => {
  it("shows Queued with the shared fixture's retry time while the real run is still waiting on the vendor's quota, well before the elapsed taking-longer threshold, then clears it once a fresh poll reports none", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    render(<RenderedSetupLine surfaceKey={surfaceKey} />);

    // Parsed through the real wire schema, not only TS-typed: a drift
    // between the fixture's shape and what the client actually accepts
    // off the wire fails this parse, not only the type checker.
    const queuedSummary = sandboxSummarySchema.parse(
      row({ state: "creating", ...SANDBOX_RATE_LIMIT_FIXTURE }),
    );
    const built = baseHarness(
      {
        createSandbox: () => ({
          kind: "ok",
          accepted: {
            sandboxId: "sbx_new",
            hostId: "host-new",
            sandbox: queuedSummary,
          },
        }),
        lists: [
          listOf(queuedSummary),
          listOf(row({ state: "awake", guestConfigured: true })),
        ],
      },
      true,
      // The component's elapsed counter reads real `Date.now()`: anchor the
      // stage's `startedAt` there too, so it reads as freshly started rather
      // than astronomically old against a fixed test epoch.
      Date.now(),
    );
    directory = built.directory;
    const sleep = built.deps.sleep;
    let observedQueued = false;
    const observing: StagedSandboxRunDeps = {
      ...built.deps,
      sleep: async (ms) => {
        // The run is about to poll again: the stage's `rateLimit` (the row's,
        // not a prop we set) is already on the store, so the rendered line
        // must already say so before this poll proceeds.
        await waitFor(() => {
          const line = screen.getByTestId("sandbox-setup-line");
          expect(line.textContent).toContain("Queued");
          expect(line.textContent).toContain("Retrying at");
        });
        observedQueued = true;
        return sleep(ms);
      },
    };

    useStagedSandboxStore.getState().report(surfaceKey, { sendTaken: true });
    onTestFinished(holdHandoffOwner(surfaceKey, null, ownerGoneOnUnmount));
    await act(async () => {
      await runStagedSandbox(
        surfaceKey,
        false,
        { taskId: null, resume: false },
        observing,
      );
    });

    expect(observedQueued).toBe(true);
    expect(readStagedSandbox(surfaceKey)?.phase).toBe("handoff");
    expect(readStagedSandbox(surfaceKey)?.rateLimit ?? null).toBeNull();
    await waitFor(() => {
      expect(
        screen.getByTestId("sandbox-setup-line").textContent,
      ).not.toContain("Queued");
    });
  });
});
