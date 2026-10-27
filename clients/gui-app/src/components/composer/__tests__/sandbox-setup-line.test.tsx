import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  SandboxSetupLine,
  type SandboxSetupLineActions,
  type SandboxSetupLineFacts,
} from "@/components/composer/sandbox-setup-line";
import type { StageConfiguration } from "@/lib/sandboxes/sandbox-stage-model";
import type {
  StagedSandbox,
  StagedSandboxFailure,
} from "@/stores/composer/staged-sandbox-store";

vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://example.test/billing",
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

afterEach(cleanup);

const ACTIONS: SandboxSetupLineActions = {
  onKeepWaiting: vi.fn(),
  onCancel: vi.fn(),
  onChooseAnotherHost: vi.fn(),
  onRetryCreation: vi.fn(),
  onRetry: vi.fn(),
  onSendAgain: vi.fn(),
  onChangeShape: vi.fn(),
  onRetryApplying: vi.fn(),
  onStop: vi.fn(),
  onOpenTerminal: null,
  onOpenProviders: null,
};

function facts(smallerShapeAffordable: boolean): SandboxSetupLineFacts {
  return {
    costLine: "",
    regionLabel: "US East",
    shapeLabel: "2 vCPU · 4 GB",
    smallerShapeAffordable,
  };
}

function refused(
  configuration: StageConfiguration,
  failure: StagedSandboxFailure,
): StagedSandbox {
  return {
    target: {
      kind: "new",
      configuration,
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
    phase: "creating",
    clientRequestId: "req-1",
    ownerId: null,
    createdSandboxId: null,
    createdHostId: null,
    startedAt: 1,
    step: "creating",
    stepAt: 1,
    failure,
    terminalLaunch: null,
    openTerminal: false,
    sendTaken: true,
  };
}

function created(): StagedSandbox {
  const now = Date.now();
  return {
    ...refused(
      { kind: "personal" },
      { kind: "failed", code: "create", step: "creating" },
    ),
    createdSandboxId: "sbx_made_1",
    createdHostId: "host-1",
    failure: null,
    startedAt: now,
    stepAt: now,
  };
}

function mountRefusal(
  configuration: StageConfiguration,
  failure: StagedSandboxFailure,
  smallerShapeAffordable: boolean,
): HTMLElement {
  render(
    <SandboxSetupLine
      stage={refused(configuration, failure)}
      name="api-refactor"
      facts={facts(smallerShapeAffordable)}
      actions={ACTIONS}
    />,
  );
  return screen.getByTestId("sandbox-refusal-line");
}

function buttonLabels(line: HTMLElement): string[] {
  return within(line)
    .getAllByRole("button")
    .map((button) => button.textContent);
}

describe("SandboxSetupLine's refusal for credits", () => {
  it("offers exactly Add credits and Choose another host on Personal", () => {
    const line = mountRefusal(
      { kind: "personal" },
      { kind: "credits", shortfallMc: 120 },
      false,
    );

    expect(line.textContent).toContain("Not enough credits.");
    expect(buttonLabels(line)).toEqual([
      "Add credits ↗",
      "Choose another host",
    ]);
  });

  it("offers exactly Add credits and Choose another host on a team's allowance", () => {
    const line = mountRefusal(
      { kind: "team", teamId: "team-1", teamName: "acme" },
      { kind: "credits", shortfallMc: 120 },
      false,
    );

    expect(line.textContent).toContain("Your acme allowance is short");
    expect(buttonLabels(line)).toEqual([
      "Add credits ↗",
      "Choose another host",
    ]);
  });

  it("offers Choose a smaller shape only when a smaller shape is affordable", () => {
    const line = mountRefusal(
      { kind: "personal" },
      { kind: "credits", shortfallMc: 120 },
      true,
    );

    expect(buttonLabels(line)).toEqual([
      "Add credits ↗",
      "Choose another host",
      "Choose a smaller shape",
    ]);
  });
});

describe("SandboxSetupLine's refusal whose answer never came", () => {
  it("keeps Retry beside Choose another host", () => {
    const line = mountRefusal(
      { kind: "personal" },
      { kind: "unverified" },
      false,
    );

    expect(line.textContent).toContain("Couldn't verify your balance.");
    expect(buttonLabels(line)).toEqual(["Retry", "Choose another host"]);
  });
});

describe("SandboxSetupLine's failed start", () => {
  const RAW_CODE = "create:kube-create-service-account";

  function mountFailed(): void {
    render(
      <SandboxSetupLine
        stage={{
          ...refused(
            { kind: "personal" },
            { kind: "failed", code: RAW_CODE, step: "creating" },
          ),
          createdSandboxId: "sbx_made_1",
        }}
        name="api-refactor"
        facts={facts(false)}
        actions={ACTIONS}
      />,
    );
  }

  it("titles the failure with its support reference, never the raw code", () => {
    mountFailed();

    const line = screen.getByTestId("sandbox-setup-line");
    expect(line.textContent).toContain("SBX-0412");
    expect(line.textContent).not.toContain(RAW_CODE);
  });

  it("copies the support reference with the created sandbox's id", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mountFailed();

    fireEvent.click(await screen.findByTestId("sandbox-setup-copy-reference"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("SBX-0412 · sbx_made_1");
    });
  });
});

describe("SandboxSetupLine's Stop action", () => {
  it("stays available while the created sandbox's line is collapsed or expanded", () => {
    vi.mocked(ACTIONS.onStop).mockClear();
    render(
      <SandboxSetupLine
        stage={created()}
        name="api-refactor"
        facts={facts(false)}
        actions={ACTIONS}
      />,
    );

    const line = screen.getByTestId("sandbox-setup-line");
    expect(
      within(line).getByRole("button", { name: "Stop" }),
    ).toBeDefined();

    fireEvent.click(screen.getByTestId("sandbox-setup-line-toggle"));

    expect(screen.getByTestId("sandbox-setup-line-detail")).toBeDefined();
    const stop = within(line).getByRole("button", { name: "Stop" });
    fireEvent.click(stop);
    expect(ACTIONS.onStop).toHaveBeenCalledTimes(1);
  });

  it("hides Stop in both line states when withdrawal is unavailable", () => {
    render(
      <SandboxSetupLine
        stage={created()}
        name="api-refactor"
        facts={facts(false)}
        actions={ACTIONS}
        withdrawalAllowed={false}
      />,
    );

    expect(screen.queryByTestId("sandbox-setup-stop")).toBeNull();
    fireEvent.click(screen.getByTestId("sandbox-setup-line-toggle"));
    expect(screen.queryByTestId("sandbox-setup-stop")).toBeNull();
  });
});
