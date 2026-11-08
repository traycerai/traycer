import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import {
  SandboxSetupLine,
  type SandboxSetupLineActions,
} from "@/components/composer/sandbox-setup-line";
import { useSetupLineFacts } from "@/components/composer/use-staged-sandbox-send";
import { sandboxReadinessLine } from "@/lib/sandboxes/sandbox-readiness";
import {
  durationSentence,
  READY_SENTENCE,
  readinessCatalogue,
  servedMinutes,
} from "@/lib/sandboxes/__tests__/sandbox-catalogue-fixture";
import type { StagedSandbox } from "@/stores/composer/staged-sandbox-store";

let catalogueInUse: SandboxCatalogue | null = null;
const SETTLED = { isSuccess: true, isFetching: false };
let readinessState = SETTLED;

vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: catalogueInUse }),
}));
// The query hook has its own test. Its state is a case's to set, and its data
// is the sentence the served catalogue reads as through the same formatter its
// select calls; the staged line's own guard on that state is what each case
// observes.
vi.mock("@/hooks/sandboxes/use-sandbox-get-readiness-query", () => ({
  useSandboxGetReadiness: (
    _configuration: unknown,
    shape: Parameters<typeof sandboxReadinessLine>[1],
  ) => ({
    isSuccess: readinessState.isSuccess,
    isFetching: readinessState.isFetching,
    data:
      catalogueInUse === null
        ? null
        : sandboxReadinessLine(catalogueInUse, shape),
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: undefined, dataUpdatedAt: 0 }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-operation", () => ({
  useSandboxOperation: () => null,
}));
vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://example.test/billing",
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

afterEach(() => {
  cleanup();
  catalogueInUse = null;
  readinessState = SETTLED;
});

const ACTIONS: SandboxSetupLineActions = {
  onKeepWaiting: vi.fn(),
  onCancel: vi.fn(),
  onChooseAnotherHost: vi.fn(),
  chooseAnotherHostLabel: "Use This computer",
  onRetryCreation: vi.fn(),
  onRetry: vi.fn(),
  onSendAgain: vi.fn(),
  onChangeShape: vi.fn(),
  onRetryApplying: vi.fn(),
  onRepairSetup: null,
  onStop: vi.fn(),
  onOpenTerminal: null,
};

const STAGED_NEW: StagedSandbox = {
  target: {
    kind: "new",
    configuration: { kind: "personal" },
    shape: {
      os: "linux",
      cpus: 2,
      memoryMb: 4096,
      diskMb: null,
      region: "us-east",
      idleMinutes: 30,
      destroyAfterRestingMinutes: 10_080,
    },
    name: "api-refactor",
    wakeString: null,
  },
  phase: "staged",
  clientRequestId: "req-1",
  ownerId: null,
  createdSandboxId: null,
  createdHostId: null,
  startedAt: null,
  step: "creating",
  stepAt: 1,
  failure: null,
  terminalLaunch: null,
  openTerminal: false,
  sendTaken: false,
};

function StagedLine() {
  const facts = useSetupLineFacts(STAGED_NEW);
  return facts === null ? null : (
    <SandboxSetupLine
      stage={STAGED_NEW}
      name="api-refactor"
      facts={facts}
      actions={ACTIONS}
    />
  );
}

const SERVED_MS = servedMinutes(7);

describe("the staged New setup line's readiness", () => {
  it.each([
    { warm: 2, measured: SERVED_MS, text: READY_SENTENCE },
    { warm: 0, measured: SERVED_MS, text: durationSentence(SERVED_MS) },
    { warm: null, measured: SERVED_MS, text: durationSentence(SERVED_MS) },
    { warm: 0, measured: null, text: null },
    { warm: 0, measured: undefined, text: null },
  ])(
    "reads a served warm count $warm and duration $measured through the facts into $text",
    ({ warm, measured, text }) => {
      catalogueInUse = readinessCatalogue({
        warm,
        coldCreateMeasuredMs: measured,
      });
      render(<StagedLine />);
      const line = screen.queryByTestId("sandbox-staged-readiness");
      if (text === null) expect(line).toBeNull();
      else expect(line?.textContent).toBe(text);
    },
  );

  it.each([
    { name: "refetching", state: { isSuccess: true, isFetching: true } },
    {
      name: "errored on its last read",
      state: { isSuccess: false, isFetching: false },
    },
  ])(
    "draws no readiness line while the query is $name, though it still holds a sentence",
    ({ state }) => {
      catalogueInUse = readinessCatalogue({
        warm: 2,
        coldCreateMeasuredMs: SERVED_MS,
      });
      readinessState = state;
      render(<StagedLine />);
      expect(screen.queryByTestId("sandbox-staged-readiness")).toBeNull();
    },
  );
});
