import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TerminalLaunchTarget } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { useStagedSandboxSend } from "@/components/composer/use-staged-sandbox-send";
import {
  useStagedSandboxStore,
  type StagedSandboxFailure,
  type StagedSandboxStep,
} from "@/stores/composer/staged-sandbox-store";

const mocks = vi.hoisted(() => ({
  runStagedSandbox: vi.fn(() => Promise.resolve()),
  repairHostIds: [] as string[],
  repairMutate: vi.fn(
    (_variables: object, options: { readonly onSuccess: () => void }) => {
      options.onSuccess();
    },
  ),
}));

vi.mock("@/lib/sandboxes/staged-sandbox-run", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/sandboxes/staged-sandbox-run")
  >()),
  runStagedSandbox: mocks.runStagedSandbox,
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({
    useSandboxRepairGuestConfigurationOnHost: (hostId: string) => {
      mocks.repairHostIds.push(hostId);
      return { mutate: mocks.repairMutate };
    },
  }),
);
// The new host answers with its default cwd as soon as it is named.
vi.mock(
  "@/components/epic-canvas/sidebar/use-folderless-terminal-target",
  () => ({
    useFolderlessTerminalTarget: (_epicId: string, hostId: string | null) =>
      hostId === null ? null : { hostId, cwd: "/home/sandbox" },
  }),
);
vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({ auth: {}, directory: {} }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-verb-mutation", () => ({
  useSandboxVerb: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://example.test/billing",
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

const SURFACE = "tab:epic-1";
const NEW_HOST = "sbx-host";

function stageCreated(
  step: StagedSandboxStep,
  failure: StagedSandboxFailure | null,
): void {
  const store = useStagedSandboxStore.getState();
  store.stage(SURFACE, {
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
  });
  store.begin(SURFACE, false, Date.now());
  store.report(SURFACE, {
    createdSandboxId: "sbx-1",
    createdHostId: NEW_HOST,
    step,
    stepAt: Date.now(),
    failure,
  });
}

function Harness(props: {
  readonly openTerminal: (target: TerminalLaunchTarget) => void;
}) {
  const send = useStagedSandboxSend({
    surfaceKey: SURFACE,
    resolvedHostId: "laptop",
    canSubmit: false,
    submit: () => false,
    prepareHandoff: () => undefined,
    terminal: { epicId: "epic-1", open: props.openTerminal },
  });
  return <>{send.line}</>;
}

function mount(openTerminal: (target: TerminalLaunchTarget) => void): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness openTerminal={openTerminal} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useStagedSandboxStore.setState({ bySurface: {} });
  mocks.runStagedSandbox.mockClear();
  mocks.repairMutate.mockClear();
  mocks.repairHostIds.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("useStagedSandboxSend's setup line", () => {
  it("opens a folderless terminal on the new host from the Booting step", () => {
    stageCreated("booting", null);
    const openTerminal = vi.fn<(target: TerminalLaunchTarget) => void>();
    mount(openTerminal);

    fireEvent.click(screen.getByTestId("sandbox-setup-line-toggle"));
    fireEvent.click(screen.getByTestId("sandbox-setup-booting-open-terminal"));

    expect(openTerminal).toHaveBeenCalledWith({
      hostId: NEW_HOST,
      cwd: "/home/sandbox",
    });
  });

  it("repairs the settings on the new host, then resumes the wait", () => {
    stageCreated("applying", { kind: "settings", code: "SBX-0520" });
    mount(vi.fn());

    fireEvent.click(screen.getByTestId("sandbox-setup-retry-applying"));

    expect(mocks.repairHostIds).toContain(NEW_HOST);
    expect(mocks.repairMutate).toHaveBeenCalledTimes(1);
    expect(mocks.runStagedSandbox).toHaveBeenCalledWith(
      SURFACE,
      false,
      expect.any(String),
      expect.any(Object),
    );
  });
});
