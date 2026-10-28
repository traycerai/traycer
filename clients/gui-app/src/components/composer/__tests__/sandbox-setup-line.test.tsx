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
import { sandboxSettingsStepsLine } from "@traycer/protocol/host/sandbox-settings";
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

const onStop = vi.fn();

const ACTIONS: SandboxSetupLineActions = {
  onKeepWaiting: vi.fn(),
  onCancel: vi.fn(),
  onChooseAnotherHost: vi.fn(),
  onRetryCreation: vi.fn(),
  onRetry: vi.fn(),
  onSendAgain: vi.fn(),
  onChangeShape: vi.fn(),
  onRetryApplying: vi.fn(),
  onRepairSetup: null,
  onStop,
  onOpenTerminal: null,
  onOpenProviders: null,
};

function facts(smallerShapeAffordable: boolean): SandboxSetupLineFacts {
  return {
    costLine: "",
    regionLabel: "US East",
    shapeLabel: "2 vCPU · 4 GB",
    smallerShapeAffordable,
    offeredAgents: null,
    sandboxAwake: null,
    sandboxStoppable: true,
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
  actions: SandboxSetupLineActions,
): HTMLElement {
  render(
    <SandboxSetupLine
      stage={refused(configuration, failure)}
      name="api-refactor"
      facts={facts(smallerShapeAffordable)}
      actions={actions}
    />,
  );
  return screen.getByTestId("sandbox-refusal-line");
}

function buttonLabels(line: HTMLElement): string[] {
  return within(line)
    .getAllByRole("button")
    .map((button) => button.textContent);
}

describe("withdrawing a message from every refusal or failure", () => {
  const failures: readonly StagedSandboxFailure[] = [
    { kind: "credits", shortfallMc: 120 },
    { kind: "unverified" },
    { kind: "shape" },
    { kind: "unavailable" },
    { kind: "refused", message: "Try another region" },
    { kind: "no-provider" },
    { kind: "agent-not-offered", harnessId: "codex" },
    { kind: "agent-setup-failed", detail: "Install failed" },
    { kind: "not-sent" },
    { kind: "settings", code: "settings" },
    { kind: "failed", code: "create", step: "creating" },
    { kind: "timed-out", step: "booting" },
  ];
  it.each(
    failures.flatMap((failure) =>
      [false, true].map((resuming) => ({ failure, resuming })),
    ),
  )(
    "$failure.kind with resuming=$resuming keeps Cancel between host choice and Details",
    ({ failure, resuming }) => {
      const stage = created();
      const onCancel = vi.fn();
      const onOpenTerminal = vi.fn();
      render(
        <SandboxSetupLine
          stage={{
            ...stage,
            failure,
            target: resuming
              ? {
                  kind: "existing",
                  configuration: { kind: "personal" },
                  name: "api-refactor",
                  sandboxId: "sbx_made_1",
                  hostId: "host-1",
                  verb: "resume",
                }
              : stage.target,
          }}
          name="api-refactor"
          facts={facts(false)}
          actions={{
            ...ACTIONS,
            onCancel,
            onOpenTerminal,
            onOpenProviders: vi.fn(),
            onChooseModel: vi.fn(),
          }}
          withdrawalAllowed
        />,
      );
      const line =
        screen.queryByTestId("sandbox-refusal-line") ??
        screen.getByTestId("sandbox-setup-line-detail");
      const labels = buttonLabels(line);
      // A settings failure's terminal action reads plain "Open terminal".
      const exits = [
        ...(failure.kind === "credits"
          ? []
          : [
              failure.kind === "settings"
                ? "Open terminal"
                : "Open terminal instead",
            ]),
        "Choose another host",
        "Cancel the message",
        "Details",
      ];
      expect(labels.filter((label) => exits.includes(label))).toEqual(exits);
      fireEvent.click(
        within(line).getByRole("button", { name: "Cancel the message" }),
      );
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onOpenTerminal).not.toHaveBeenCalled();
    },
  );
});

describe("SandboxSetupLine's refusal for credits", () => {
  it.each<{
    creditSource: "personal" | "team-allowance" | "team" | null;
    shortfallMc: number | null;
    expected: string;
  }>([
    {
      creditSource: null,
      shortfallMc: null,
      expected: "Not enough credits to wake this sandbox for an hour.",
    },
    {
      creditSource: null,
      shortfallMc: 120,
      expected: "Not enough credits. $0.12 more wakes it for an hour.",
    },
    {
      creditSource: "personal",
      shortfallMc: null,
      expected: "Your credits don't cover an hour of this sandbox.",
    },
    {
      creditSource: "personal",
      shortfallMc: 120,
      expected:
        "Your credits are short $0.12. $0.12 more wakes it for an hour.",
    },
    {
      creditSource: "team-allowance",
      shortfallMc: null,
      expected: "Your acme allowance doesn't cover an hour of this sandbox.",
    },
    {
      creditSource: "team-allowance",
      shortfallMc: 120,
      expected:
        "Your acme allowance is short $0.12. $0.12 more wakes it for an hour.",
    },
    {
      creditSource: "team",
      shortfallMc: null,
      expected: "Your acme credits don't cover an hour of this sandbox.",
    },
    {
      creditSource: "team",
      shortfallMc: 120,
      expected:
        "Your acme credits are short $0.12. $0.12 more wakes it for an hour.",
    },
  ])(
    "capitalizes a resumed sandbox's $creditSource refusal with shortfall $shortfallMc",
    ({ creditSource, shortfallMc, expected }) => {
      const configuration: StageConfiguration = {
        kind: "team",
        teamId: "team-1",
        teamName: "acme",
      };
      render(
        <SandboxSetupLine
          stage={{
            ...refused(configuration, {
              kind: "credits",
              creditSource,
              shortfallMc,
            }),
            target: {
              kind: "existing",
              configuration,
              name: "api-refactor",
              sandboxId: "sbx_made_1",
              hostId: "host-1",
              verb: "resume",
            },
          }}
          name="api-refactor"
          facts={facts(false)}
          actions={ACTIONS}
        />,
      );

      const line = screen.getByRole("alert");
      expect(within(line).getByText(expected)).toBeDefined();
    },
  );

  it("offers Add credits, host choice and Cancel on Personal", () => {
    const line = mountRefusal(
      { kind: "personal" },
      { kind: "credits", shortfallMc: 120 },
      false,
      ACTIONS,
    );

    expect(line.textContent).toContain("Not enough credits.");
    expect(buttonLabels(line)).toEqual([
      "Add credits ↗",
      "Choose another host",
      "Cancel the message",
    ]);
  });

  it("offers Add credits, host choice and Cancel on a team's allowance", () => {
    const line = mountRefusal(
      { kind: "team", teamId: "team-1", teamName: "acme" },
      { kind: "credits", creditSource: "team-allowance", shortfallMc: 120 },
      false,
      ACTIONS,
    );

    expect(
      within(line).getByText(
        "Your acme allowance is short $0.12. $0.12 more starts this sandbox for an hour.",
      ),
    ).toBeDefined();
    expect(buttonLabels(line)).toEqual([
      "Add credits ↗",
      "Choose another host",
      "Cancel the message",
    ]);
  });

  it("offers Choose a smaller shape only when a smaller shape is affordable", () => {
    const line = mountRefusal(
      { kind: "personal" },
      { kind: "credits", shortfallMc: 120 },
      true,
      ACTIONS,
    );

    expect(buttonLabels(line)).toEqual([
      "Add credits ↗",
      "Choose a smaller shape",
      "Choose another host",
      "Cancel the message",
    ]);
  });
});

describe("SandboxSetupLine's refusal whose answer never came", () => {
  it("keeps Retry beside Choose another host", () => {
    const line = mountRefusal(
      { kind: "personal" },
      { kind: "unverified" },
      false,
      ACTIONS,
    );

    expect(line.textContent).toContain("Couldn't verify your balance.");
    expect(buttonLabels(line)).toEqual([
      "Retry",
      "Choose another host",
      "Cancel the message",
    ]);
  });
});

describe("SandboxSetupLine's agent refusals", () => {
  it("names an unoffered agent and offers model, terminal, and host remedies", () => {
    const onChooseModel = vi.fn();
    const onOpenTerminal = vi.fn();
    const onChooseAnotherHost = vi.fn();
    const line = mountRefusal(
      { kind: "personal" },
      { kind: "agent-not-offered", harnessId: "codex" },
      false,
      {
        ...ACTIONS,
        onChooseModel,
        onOpenTerminal,
        onChooseAnotherHost,
      },
    );

    expect(line.textContent).toContain(
      "Codex doesn't run on sandboxes. Choose a Traycer model to run agents here.",
    );
    expect(buttonLabels(line)).toEqual([
      "Choose a model",
      "Open terminal instead",
      "Choose another host",
      "Cancel the message",
    ]);
    fireEvent.click(
      within(line).getByRole("button", { name: "Choose a model" }),
    );
    expect(onChooseModel).toHaveBeenCalledOnce();
  });

  it("uses Traycer Inference setup copy and keeps Personal's Providers available", () => {
    const onOpenProviders = vi.fn();
    const line = mountRefusal(
      { kind: "personal" },
      { kind: "no-provider" },
      false,
      { ...ACTIONS, onOpenProviders, onOpenTerminal: vi.fn() },
    );

    expect(line.textContent).toContain(
      "Turn on Traycer Inference in Personal's Providers to run agents on sandboxes.",
    );
    expect(buttonLabels(line)).toEqual([
      "Open Personal's Providers",
      "Open terminal instead",
      "Choose another host",
      "Cancel the message",
    ]);
    fireEvent.click(
      within(line).getByRole("button", { name: "Open Personal's Providers" }),
    );
    expect(onOpenProviders).toHaveBeenCalledOnce();
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
    onStop.mockClear();
    render(
      <SandboxSetupLine
        stage={created()}
        name="api-refactor"
        facts={facts(false)}
        actions={ACTIONS}
      />,
    );

    const line = screen.getByTestId("sandbox-setup-line");
    expect(within(line).getByRole("button", { name: "Stop" })).toBeDefined();

    fireEvent.click(screen.getByTestId("sandbox-setup-line-toggle"));

    expect(screen.getByTestId("sandbox-setup-line-detail")).toBeDefined();
    const stop = within(line).getByRole("button", { name: "Stop" });
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
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

describe("SandboxSetupLine when the settings did not apply", () => {
  const STEPS = { applied: ["Secrets"], notApplied: ["Providers"] };

  function mountSettings(sendTaken: boolean, actions: SandboxSetupLineActions) {
    render(
      <SandboxSetupLine
        stage={{
          ...created(),
          sendTaken,
          failure: {
            kind: "settings",
            code: "envelope-delivery:x",
            steps: STEPS,
          },
        }}
        name="api-refactor"
        facts={facts(false)}
        actions={actions}
      />,
    );
    return screen.getByTestId("sandbox-setup-line-detail");
  }

  it("says the one shared sentence, then compute first and one step line, never a raw key or code", () => {
    const detail = mountSettings(false, ACTIONS);

    expect(
      screen.getByText(
        "api-refactor is awake, but Personal's settings didn't apply · SBX-0520",
      ),
    ).toBeTruthy();
    const lines = within(detail)
      .getAllByText(/./, { selector: "p" })
      .map((line) => line.textContent);
    expect(lines[0]).toBe("Compute is charged while it is awake.");
    expect(lines).toContain(sandboxSettingsStepsLine(STEPS));
    expect(detail.textContent).not.toMatch(
      /permission_denied|ANTHROPIC_API_KEY|envelope-delivery/,
    );
  });

  it("says the message waits only when the send was taken", () => {
    const waiting = mountSettings(true, ACTIONS);
    expect(waiting.textContent).toContain(
      "Your message waits until they apply.",
    );
    cleanup();

    const idle = mountSettings(false, ACTIONS);
    expect(idle.textContent).not.toContain("waits until they apply");
  });

  it("offers Retry applying, Open terminal, Stop, Choose another host and Details", () => {
    const detail = mountSettings(true, {
      ...ACTIONS,
      onOpenTerminal: vi.fn(),
    });

    const labels = buttonLabels(detail);
    for (const label of [
      "Retry applying",
      "Open terminal",
      "Stop",
      "Choose another host",
      "Details",
    ]) {
      expect(labels).toContain(label);
    }
  });

  it("hides Retry applying when the host offers no combined retry", () => {
    const detail = mountSettings(true, { ...ACTIONS, onRetryApplying: null });

    expect(
      within(detail).queryByTestId("sandbox-setup-retry-applying"),
    ).toBeNull();
    expect(within(detail).getByTestId("sandbox-setup-stop")).toBeTruthy();
  });

  it("offers Repair setup instead of Retry applying when only the guest-only repair is available", () => {
    const onRepairSetup = vi.fn();
    const detail = mountSettings(true, {
      ...ACTIONS,
      onRetryApplying: null,
      onRepairSetup,
    });

    fireEvent.click(within(detail).getByTestId("sandbox-setup-repair-setup"));

    expect(onRepairSetup).toHaveBeenCalledTimes(1);
    expect(
      within(detail).queryByTestId("sandbox-setup-retry-applying"),
    ).toBeNull();
  });

  it("disables Retry applying while a retry is pending", () => {
    const detail = mountSettings(true, { ...ACTIONS, applyingPending: true });

    const retry = within(detail).getByTestId("sandbox-setup-retry-applying");
    expect(retry.hasAttribute("disabled")).toBe(true);
  });
});
