/**
 * The Memory act's saves: what Continue writes, the order, a failed write and a queued one. The faked host and the helpers are in `onboarding-memory-act-fixture.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  ENVIRONMENT_ID,
  HOST_ID,
  acceptHeldWrite,
  deliverAcceptedWrites,
  deliverSavedWrite,
  entryReaderAnswer,
  enterTour,
  expectSettingsReaderIsCurrent,
  mountEntryReader,
  unmountEntryReader,
  deferred,
  walkToMemoryAct,
  writesAnswered,
  overturnWrite,
  cleanupMemoryActFixture,
  resetMemoryActFixture,
  chooseTraycer,
  continueFromMemory,
  currentStepId,
  defaultProviders,
  expectOnStep,
  invalidateAllQueries,
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
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";

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

    acceptHeldWrite("upload-1", ENVIRONMENT_ID);
    deliverAcceptedWrites();
    await continueFromMemory();
    await expectOnStep("session-import");

    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toEqual([
      { harnessId: "claude", nativeMemory: false },
      { harnessId: "codex", nativeMemory: false },
    ]);
  });

  it("sends a fresh set once the configuration refused the held one, and only then", async () => {
    world.setAnswers = ["queued", "applied"];
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();
    await screen.findByTestId("onboarding-memory-save-report");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);

    world.refused = ["upload-1"];
    await continueFromMemory();
    await expectOnStep("session-import");

    expect(paramsOf("config.agentMemories.set")).toHaveLength(2);
    const order = methodsInOrder();
    expect(order.indexOf("environment.status")).toBeLessThan(
      order.lastIndexOf("config.agentMemories.set"),
    );
  });

  it("does not take an on read for the held write while the receipt is missing", async () => {
    world.setAnswers = ["queued"];
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();
    await screen.findByTestId("onboarding-memory-save-report");

    // Another revision reads as on; nothing says this write was taken.
    world.memoriesOn = true;
    await continueFromMemory();
    await settled();

    expect(paramsOf("providers.setNativeMemory")).toEqual([]);
    expect(
      screen.getByTestId("onboarding-memory-save-report").textContent,
    ).toContain("waiting to reach your configuration");
    expect(currentStepId()).toBe("agent-memories");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
  });

  it("starts over, not on the old receipt, once the host serves another configuration", async () => {
    world.setAnswers = ["queued", "applied"];
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();
    await screen.findByTestId("onboarding-memory-save-report");

    // Rebound: the receipt belongs to the configuration the host left.
    world.environmentId = "env-rebound";
    acceptHeldWrite("upload-1", ENVIRONMENT_ID);
    await continueFromMemory();
    await expectOnStep("session-import");

    expect(paramsOf("config.agentMemories.set")).toHaveLength(2);
    const order = methodsInOrder();
    expect(order.indexOf("providers.setNativeMemory")).toBeGreaterThan(
      order.lastIndexOf("config.agentMemories.set"),
    );
  });

  it("takes an on read as saved once the host serves another configuration", async () => {
    world.setAnswers = ["queued"];
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();
    await screen.findByTestId("onboarding-memory-save-report");

    world.environmentId = "env-rebound";
    world.memoriesOn = true;
    await continueFromMemory();
    await expectOnStep("session-import");

    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toHaveLength(2);
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

describe("the Memory act: what a retry trusts after the host moves", () => {
  it("reads the configuration the host serves now before it writes any provider", async () => {
    world.nativeFailures.set("claude", 1);
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();
    await screen.findByTestId("onboarding-memory-save-report");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);

    // The host is rebound to a configuration where Traycer memories are off.
    world.environmentId = "env-rebound";
    world.memoriesOn = false;
    await continueFromMemory();
    await expectOnStep("session-import");

    expect(paramsOf("config.agentMemories.set")).toHaveLength(2);
    const order = methodsInOrder();
    expect(order.lastIndexOf("providers.setNativeMemory")).toBeGreaterThan(
      order.lastIndexOf("config.agentMemories.set"),
    );
  });

  it("shows the state of the configuration its last read named, not the one it saved to", async () => {
    world.nativeFailures.set("claude", 1);
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();
    const report = await screen.findByTestId("onboarding-memory-save-report");
    expect(report.textContent).toContain("Traycer memories are on.");

    world.environmentId = "env-rebound";
    world.memoriesOn = false;
    await act(() => invalidateAllQueries());

    // Nothing of the act's is written in the configuration the read names.
    await waitFor(() =>
      expect(screen.queryByTestId("onboarding-memory-save-report")).toBeNull(),
    );
    expect(switchOf("onboarding-memory-traycer").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("does not send a second set to a configuration whose held write is still pending", async () => {
    world.setAnswers = ["queued"];
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();
    await screen.findByTestId("onboarding-memory-save-report");

    world.environmentId = "env-rebound";
    await continueFromMemory();
    await settled();
    expect(paramsOf("config.agentMemories.set")).toHaveLength(2);

    world.environmentId = ENVIRONMENT_ID;
    await continueFromMemory();
    await settled();

    expect(paramsOf("config.agentMemories.set")).toHaveLength(2);
    expect(currentStepId()).toBe("agent-memories");
  });
});

describe("the Memory act: a write the host has not read back, and one overturned", () => {
  it("holds the providers while a saved write has not reached this computer, then finishes once it has", async () => {
    world.setAnswers = ["saved"];
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();

    const report = await screen.findByTestId("onboarding-memory-save-report");
    expect(report.textContent).toContain(
      "Traycer memories are saved to your configuration but haven't reached this computer yet.",
    );
    expect(report.textContent).toContain(
      "Your providers' memories weren't changed.",
    );
    expect(
      screen.getByTestId("onboarding-memory-traycer").textContent,
    ).toContain(
      "Waiting for your configuration. Change this later in Settings → Agent memories.",
    );
    expect(switchOf("onboarding-memory-traycer").hasAttribute("disabled")).toBe(
      true,
    );
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);

    // Retrying before it arrives sends nothing new.
    await continueFromMemory();
    await settled();
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);

    deliverSavedWrite();
    await continueFromMemory();
    await expectOnStep("session-import");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toHaveLength(2);
  });

  it("stops on a write a later revision turned off, never sends it again, and lets the person move on", async () => {
    world.nativeFailures.set("claude", 1);
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();
    await screen.findByTestId("onboarding-memory-save-report");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    const providerWrites = paramsOf("providers.setNativeMemory").length;

    overturnWrite();
    await continueFromMemory();
    await settled();
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(
      screen.queryByTestId("onboarding-memory-save-report")?.textContent,
    ).toContain("Couldn't turn on Traycer memories.");
    expect(paramsOf("providers.setNativeMemory")).toHaveLength(providerWrites);
    expect(switchOf("onboarding-memory-traycer").hasAttribute("disabled")).toBe(
      false,
    );

    // Turned off, Continue has nothing to write and moves on.
    fireEvent.click(switchOf("onboarding-memory-traycer"));
    await continueFromMemory();
    await expectOnStep("session-import");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toHaveLength(providerWrites);
  });
});

describe("the Memory act: a read is only as fresh as when it was taken", () => {
  it.each([
    ["the host is rebound to an off configuration", "rebind"],
    ["the setting is turned off by a later revision", "overturn"],
  ] as const)(
    "accepts that %s right after the final read, and moves on without reading again",
    async (_name, overtakenBy) => {
      world.rebindAfterNativeWrites = 2;
      world.overtakenBy = overtakenBy;
      await openMemoryAct();
      await chooseTraycer();
      await continueFromMemory();
      await expectOnStep("session-import");
      const callsWhenFinished = hostCalls().length;
      await settled();

      // Both providers were written off on the strength of the read before.
      expect(world.memoriesOn).toBe(false);
      expect(paramsOf("providers.setNativeMemory")).toEqual([
        { harnessId: "claude", nativeMemory: false },
        { harnessId: "codex", nativeMemory: false },
      ]);
      expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
      expect(hostCalls()).toHaveLength(callsWhenFinished);
    },
  );
});

describe("the Memory act: Settings reads the host after any way out", () => {
  // Each case leaves the act a different way; Settings' own reader must then
  // send its own `get` and show what the host answers, never the act's read.
  const ways: ReadonlyArray<readonly [string, () => Promise<void>]> = [
    [
      "done on a read that a rebind then overtook",
      async () => {
        world.rebindAfterNativeWrites = 2;
        world.overtakenBy = "rebind";
        await openMemoryAct();
        await chooseTraycer();
        await continueFromMemory();
        await expectOnStep("session-import");
      },
    ],
    [
      "done on a read that an overturn then overtook",
      async () => {
        world.rebindAfterNativeWrites = 2;
        world.overtakenBy = "overturn";
        await openMemoryAct();
        await chooseTraycer();
        await continueFromMemory();
        await expectOnStep("session-import");
      },
    ],
    [
      "Not now",
      async () => {
        await openMemoryAct();
        fireEvent.click(await screen.findByTestId("onboarding-memory-not-now"));
        await expectOnStep("session-import");
      },
    ],
    [
      "an overturn, then Traycer switched off and Continue",
      async () => {
        world.nativeFailures.set("claude", 1);
        await openMemoryAct();
        await chooseTraycer();
        await continueFromMemory();
        await screen.findByTestId("onboarding-memory-save-report");
        overturnWrite();
        await continueFromMemory();
        await settled();
        fireEvent.click(switchOf("onboarding-memory-traycer"));
        await continueFromMemory();
        await expectOnStep("session-import");
      },
    ],
    [
      "Back while a save is running",
      async () => {
        world.setGate = deferred();
        await walkToMemoryAct();
        await chooseTraycer();
        await continueFromMemory();
        await waitFor(() =>
          expect(paramsOf("config.agentMemories.set")).toHaveLength(1),
        );
        fireEvent.click(screen.getByTestId("onboarding-back"));
        await expectOnStep("providers");
        act(() => world.setGate?.resolve());
        await writesAnswered();
      },
    ],
    [
      "a read still in flight as the act is left",
      async () => {
        world.getGate = deferred();
        await openMemoryAct();
        fireEvent.click(await screen.findByTestId("onboarding-memory-not-now"));
        await expectOnStep("session-import");
        act(() => world.getGate?.resolve());
      },
    ],
  ];
  it.each(ways)("after %s", async (_name, leave) => {
    await leave();
    await settled();
    await expectSettingsReaderIsCurrent(HOST_ID);
  });

  it("sees the write the act made, though it held an answer from before", async () => {
    await enterTour();
    mountEntryReader(HOST_ID);
    await waitFor(() =>
      expect(entryReaderAnswer()).toMatchObject({ enabled: false }),
    );
    unmountEntryReader();
    const readsBefore = paramsOf("config.agentMemories.get").length;

    act(() => useOnboardingStore.getState().reseat(2));
    await screen.findByTestId("onboarding-memory-stage");
    await chooseTraycer();
    await continueFromMemory();
    await expectOnStep("session-import");
    await settled();
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    const readsAfterSave = paramsOf("config.agentMemories.get").length;
    expect(readsAfterSave).toBeGreaterThan(readsBefore);

    // Settings opens: the write swept its entry, so it asks again.
    mountEntryReader(HOST_ID);
    await waitFor(() =>
      expect(entryReaderAnswer()).toMatchObject({ enabled: true }),
    );
    expect(paramsOf("config.agentMemories.get").length).toBeGreaterThan(
      readsAfterSave,
    );
  });
});
