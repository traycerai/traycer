/**
 * The Memory act's saves: what Continue writes, the order, a failed write and a queued one. The faked host and the helpers are in `onboarding-memory-act-fixture.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  ENVIRONMENT_ID,
  cleanupMemoryActFixture,
  resetMemoryActFixture,
  chooseTraycer,
  continueFromMemory,
  currentStepId,
  defaultProviders,
  expectOnStep,
  hostCalls,
  isOn,
  methodsInOrder,
  openMemoryAct,
  paramsOf,
  providerSwitch,
  settled,
  switchOf,
  world,
} from "@/components/onboarding/__tests__/onboarding-memory-act-fixture";

vi.mock("@/components/auth/cinematic-backdrop", () => ({
  BrandMark: () => <span aria-hidden="true" />,
}));
vi.mock("@/components/onboarding/onboarding-workspace-illustration", () => ({
  OnboardingWorkspaceIllustration: () => (
    <div data-testid="workspace-illustration" />
  ),
}));
vi.mock("@/components/onboarding/onboarding-provider-discovery", () => ({
  OnboardingProviderPrefetch: () => null,
}));
vi.mock("@/components/onboarding/onboarding-detected-agents", () => ({
  OnboardingDetectedAgents: () => <div data-testid="detected-agents-stub" />,
}));
vi.mock("@/components/session-import/session-import-wizard", () => ({
  SessionImportWizard: () => <div data-testid="session-import-wizard" />,
}));
vi.mock("@/components/session-import/use-session-import-scan", () => ({
  useSessionImportScan: () => ({
    state: { kind: "scan-stub" },
    dispatch: () => undefined,
  }),
}));
const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigateMock,
}));

beforeEach(resetMemoryActFixture);
afterEach(cleanupMemoryActFixture);

describe("the Memory act: what Continue writes", () => {
  it("writes Traycer first, then only the rows that differ from the host", async () => {
    world.providers = [
      // Chosen on, host already on: no write.
      { ...defaultProviders()[0], nativeMemory: true },
      // Left off, host already off: no write.
      { ...defaultProviders()[1], nativeMemory: false },
      // Left off, host on: written.
      {
        providerId: "cursor",
        enabled: true,
        supported: true,
        nativeMemory: true,
      },
    ];
    await openMemoryAct();
    await chooseTraycer();
    fireEvent.click(await providerSwitch("claude-code"));
    await providerSwitch("cursor");

    await continueFromMemory();
    await expectOnStep("session-import");

    expect(paramsOf("config.agentMemories.set")).toEqual([{ enabled: true }]);
    expect(paramsOf("providers.setNativeMemory")).toEqual([
      { harnessId: "cursor", nativeMemory: false },
    ]);
    const order = methodsInOrder();
    expect(order.indexOf("config.agentMemories.set")).toBeLessThan(
      order.indexOf("providers.setNativeMemory"),
    );
  });

  it("does not write Traycer when the host already has it on, and locks its switch", async () => {
    world.memoriesOn = true;
    await openMemoryAct();
    await screen.findByText(/Traycer memories stay on/);
    expect(screen.getByTestId("onboarding-memory-use").textContent).toBe(
      "Set up provider memories",
    );

    await chooseTraycer();
    const traycer = switchOf("onboarding-memory-traycer");
    expect(isOn(traycer)).toBe(true);
    expect(traycer.hasAttribute("disabled")).toBe(true);

    await continueFromMemory();
    await expectOnStep("session-import");
    expect(paramsOf("config.agentMemories.set")).toEqual([]);
    expect(paramsOf("providers.setNativeMemory")).toEqual([
      { harnessId: "claude", nativeMemory: false },
      { harnessId: "codex", nativeMemory: false },
    ]);
  });

  it("drops the provider choices when the Traycer switch is turned off", async () => {
    await openMemoryAct();
    await chooseTraycer();
    fireEvent.click(await providerSwitch("codex"));

    fireEvent.click(switchOf("onboarding-memory-traycer"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("onboarding-memory-provider-codex"),
      ).toBeNull(),
    );
    await continueFromMemory();
    await expectOnStep("session-import");
    expect(paramsOf("config.agentMemories.set")).toEqual([]);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);
  });

  it("starts the providers over when Traycer is turned back on", async () => {
    await openMemoryAct();
    await chooseTraycer();
    fireEvent.click(await providerSwitch("codex"));
    fireEvent.click(switchOf("onboarding-memory-traycer"));
    fireEvent.click(switchOf("onboarding-memory-traycer"));

    expect(isOn(await providerSwitch("codex"))).toBe(false);
  });
});

describe("the Memory act: order and failure", () => {
  it.each(["fail", "queued"] as const)(
    "sends no provider write when Traycer's set is %s",
    async (answer) => {
      world.setAnswers = [answer];
      await openMemoryAct();
      await chooseTraycer();
      await providerSwitch("codex");

      await continueFromMemory();
      await screen.findByTestId("onboarding-memory-save-report");

      expect(currentStepId()).toBe("agent-memories");
      expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
      expect(paramsOf("providers.setNativeMemory")).toEqual([]);
    },
  );

  it("names the provider that failed and retries only that one", async () => {
    world.nativeFailures.set("codex", 1);
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");

    await continueFromMemory();
    const report = await screen.findByTestId("onboarding-memory-save-report");
    expect(report.textContent).toContain("Couldn't change Codex memories.");
    expect(report.textContent).toContain("Claude Code memories are now off.");
    expect(currentStepId()).toBe("agent-memories");
    expect(screen.getByTestId("onboarding-advance").textContent).toContain(
      "Try again",
    );
    const sentBefore = hostCalls().length;

    await continueFromMemory();
    await expectOnStep("session-import");

    const retry = hostCalls().slice(sentBefore);
    expect(retry.filter((call) => call.method.endsWith("set"))).toEqual([]);
    expect(
      retry
        .filter((call) => call.method === "providers.setNativeMemory")
        .map((call) => call.params),
    ).toEqual([{ harnessId: "codex", nativeMemory: false }]);
  });

  it("Skip for now advances from a failed state and sends nothing more", async () => {
    world.setAnswers = ["fail"];
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();
    await screen.findByTestId("onboarding-memory-save-report");
    const sentBefore = hostCalls().length;

    fireEvent.click(screen.getByTestId("onboarding-memory-skip"));
    await expectOnStep("session-import");
    await settled();

    expect(hostCalls().slice(sentBefore)).toEqual([]);
  });
});

describe("the Memory act: a queued Traycer write", () => {
  it("is never re-sent, and moves on once the receipt names it", async () => {
    world.setAnswers = ["queued"];
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");
    await continueFromMemory();
    await screen.findByTestId("onboarding-memory-save-report");

    // No word either way yet: still held, nothing sent.
    await continueFromMemory();
    await settled();
    expect(paramsOf("environment.status").length).toBeGreaterThan(0);
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);
    expect(currentStepId()).toBe("agent-memories");

    world.accepted = [{ uploadId: "upload-1", environmentId: ENVIRONMENT_ID }];
    await continueFromMemory();
    await expectOnStep("session-import");

    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toEqual([
      { harnessId: "claude", nativeMemory: false },
      { harnessId: "codex", nativeMemory: false },
    ]);
  });

  it("sends a fresh set only on the retry after the configuration refused it", async () => {
    world.setAnswers = ["queued", "applied"];
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();
    await screen.findByTestId("onboarding-memory-save-report");

    world.refused = ["upload-1"];
    await continueFromMemory();
    await waitFor(() =>
      expect(
        screen.getByTestId("onboarding-memory-save-report").textContent,
      ).toContain("turned this change away"),
    );
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);

    await continueFromMemory();
    await expectOnStep("session-import");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(2);
  });
});

describe("the Memory act: the report and the switch after a save", () => {
  it("locks the Traycer switch while its write is held", async () => {
    world.setAnswers = ["queued"];
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();
    await screen.findByTestId("onboarding-memory-save-report");

    const row = screen.getByTestId("onboarding-memory-traycer");
    const traycer = switchOf("onboarding-memory-traycer");
    expect(isOn(traycer)).toBe(true);
    expect(traycer.hasAttribute("disabled")).toBe(true);
    expect(row.textContent).toContain(
      "Waiting for your configuration. Change this later in Settings → Agent memories.",
    );
  });

  it("says a provider switched back on is no longer turned off by Traycer", async () => {
    world.providers = [
      { ...defaultProviders()[0], nativeMemory: false },
      defaultProviders()[1],
    ];
    world.nativeFailures.set("codex", 1);
    await openMemoryAct();
    await chooseTraycer();
    fireEvent.click(await providerSwitch("claude-code"));
    await providerSwitch("codex");

    await continueFromMemory();
    const report = await screen.findByTestId("onboarding-memory-save-report");

    expect(report.textContent).toContain(
      "Traycer no longer turns off Claude Code memories.",
    );
    expect(report.textContent).toContain("Couldn't change Codex memories.");
    expect(report.textContent).not.toContain("now on");
  });
});
