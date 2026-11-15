/**
 * The Memory act's saves: what Continue writes, the order, a failed write and a queued one. The faked host and the helpers are in `onboarding-memory-act-fixture.tsx`.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  ENVIRONMENT_ID,
  HOST_ID,
  acceptHeldWrite,
  deliverAcceptedWrites,
  deliverSavedWrite,
  enterTour,
  expectSettingsIsCurrent,
  closeSettings,
  getsSentTo,
  openSettings,
  settingsSwitchOn,
  deferred,
  walkToMemoryAct,
  writesAnswered,
  overturnWrite,
  cleanupMemoryActFixture,
  resetMemoryActFixture,
  chooseTraycer,
  clickAdvance,
  currentStepId,
  defaultProviders,
  expectOnStep,
  leaveTour,
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
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
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
// The wizard is its Open task button for one imported chat: the button, its
// mutation and the page's `onBeforeTaskOpen` are the consumers under test.
vi.mock("@/components/session-import/session-import-wizard", async () => {
  const { SessionImportOpenTaskButton } =
    await import("@/components/session-import/session-import-open-task-button");
  return {
    SessionImportWizard: (props: {
      readonly onBeforeTaskOpen: (() => Promise<boolean>) | null;
      readonly onTaskOpened: () => void;
    }) => (
      <div data-testid="session-import-wizard">
        <SessionImportOpenTaskButton
          target={{
            kind: "already_in_traycer",
            epicId: "epic-1",
            chatId: "chat-1",
          }}
          title="Imported task"
          targetHostId={null}
          presentation="icon"
          onTaskOpened={props.onTaskOpened}
          onBeforeTaskOpen={props.onBeforeTaskOpen}
        />
      </div>
    ),
  };
});
const tabIntents = vi.hoisted(() => [] as unknown[]);
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  // A task tab is requested by an intent: record it and let the navigation run.
  activateTabIntent: (
    navigate: (options: Record<string, unknown>) => Promise<void>,
    intent: unknown,
  ) => {
    tabIntents.push(intent);
    void navigate({ to: "/imported-task" });
    return true;
  },
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
      defaultProviders()[0],
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

    await clickAdvance();
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

    await clickAdvance();
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
    await clickAdvance();
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

      await clickAdvance();
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

    await clickAdvance();
    const report = await screen.findByTestId("onboarding-memory-save-report");
    expect(report.textContent).toContain("Couldn't change Codex memories.");
    expect(report.textContent).toContain("Claude Code memories are now off.");
    expect(currentStepId()).toBe("agent-memories");
    expect(screen.getByTestId("onboarding-advance").textContent).toContain(
      "Try again",
    );
    const sentBefore = hostCalls().length;

    await clickAdvance();
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
    await clickAdvance();
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
    await clickAdvance();
    await screen.findByTestId("onboarding-memory-save-report");

    // No word either way yet: still held, nothing sent.
    await clickAdvance();
    await settled();
    expect(paramsOf("environment.status").length).toBeGreaterThan(0);
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);
    expect(currentStepId()).toBe("agent-memories");

    acceptHeldWrite("upload-1", ENVIRONMENT_ID);
    deliverAcceptedWrites();
    await clickAdvance();
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
    await clickAdvance();
    await screen.findByTestId("onboarding-memory-save-report");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);

    world.refused = ["upload-1"];
    await clickAdvance();
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
    await clickAdvance();
    await screen.findByTestId("onboarding-memory-save-report");

    // Another revision reads as on; nothing says this write was taken.
    world.memoriesOn = true;
    await clickAdvance();
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
    await clickAdvance();
    await screen.findByTestId("onboarding-memory-save-report");

    // Rebound: the receipt belongs to the configuration the host left.
    world.environmentId = "env-rebound";
    acceptHeldWrite("upload-1", ENVIRONMENT_ID);
    await clickAdvance();
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
    await clickAdvance();
    await screen.findByTestId("onboarding-memory-save-report");

    world.environmentId = "env-rebound";
    world.memoriesOn = true;
    await clickAdvance();
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
    await clickAdvance();
    await screen.findByTestId("onboarding-memory-save-report");

    const row = screen.getByTestId("onboarding-memory-traycer");
    const traycer = switchOf("onboarding-memory-traycer");
    expect(isOn(traycer)).toBe(true);
    expect(traycer.hasAttribute("disabled")).toBe(true);
    expect(row.textContent).toContain(
      "Waiting for your configuration. Change this later in Settings → Memories.",
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

    await clickAdvance();
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
    await clickAdvance();
    await screen.findByTestId("onboarding-memory-save-report");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);

    // The host is rebound to a configuration where Traycer memories are off.
    world.environmentId = "env-rebound";
    world.memoriesOn = false;
    await clickAdvance();
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
    await clickAdvance();
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
    await clickAdvance();
    await screen.findByTestId("onboarding-memory-save-report");

    world.environmentId = "env-rebound";
    await clickAdvance();
    await settled();
    expect(paramsOf("config.agentMemories.set")).toHaveLength(2);

    world.environmentId = ENVIRONMENT_ID;
    await clickAdvance();
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
    await clickAdvance();

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
      "Waiting for your configuration. Change this later in Settings → Memories.",
    );
    expect(switchOf("onboarding-memory-traycer").hasAttribute("disabled")).toBe(
      true,
    );
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);

    // Retrying before it arrives sends nothing new.
    await clickAdvance();
    await settled();
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);

    deliverSavedWrite();
    await clickAdvance();
    await expectOnStep("session-import");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toHaveLength(2);
  });

  it("stops on a write a later revision turned off, never sends it again, and lets the person move on", async () => {
    world.nativeFailures.set("claude", 1);
    await openMemoryAct();
    await chooseTraycer();
    await clickAdvance();
    await screen.findByTestId("onboarding-memory-save-report");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    const providerWrites = paramsOf("providers.setNativeMemory").length;

    overturnWrite();
    await clickAdvance();
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
    await clickAdvance();
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
      await clickAdvance();
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
        await clickAdvance();
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
        await clickAdvance();
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
        await clickAdvance();
        await screen.findByTestId("onboarding-memory-save-report");
        overturnWrite();
        await clickAdvance();
        await settled();
        fireEvent.click(switchOf("onboarding-memory-traycer"));
        await clickAdvance();
        await expectOnStep("session-import");
      },
    ],
    [
      "Back while a save is running",
      async () => {
        world.setGate = deferred();
        await walkToMemoryAct();
        await chooseTraycer();
        await clickAdvance();
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
    await expectSettingsIsCurrent(HOST_ID);
  });

  it("asks for its own answer when the act's read is still in flight as Settings opens", async () => {
    world.getGate = deferred();
    await openMemoryAct();
    fireEvent.click(await screen.findByTestId("onboarding-memory-not-now"));
    await expectOnStep("session-import");

    // The act's read was taken off; the host reads on by the time Settings
    // opens. The host takes Settings' read after the act's, so it is its own.
    world.memoriesOn = true;
    world.revision += 1;
    const before = getsSentTo(HOST_ID);
    openSettings(HOST_ID);
    act(() => world.getGate?.resolve());
    await waitFor(async () => expect(await settingsSwitchOn()).toBe(true));
    expect(getsSentTo(HOST_ID)).toBe(before + 1);
  });

  it("sees the write the act made, though it held an answer from before", async () => {
    await enterTour();
    openSettings(HOST_ID);
    await settled();
    expect(await settingsSwitchOn()).toBe(false);
    closeSettings();
    const readsBefore = paramsOf("config.agentMemories.get").length;

    act(() => useOnboardingStore.getState().reseat(2));
    await screen.findByTestId("onboarding-memory-stage");
    await chooseTraycer();
    await clickAdvance();
    await expectOnStep("session-import");
    await settled();
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    const readsAfterSave = paramsOf("config.agentMemories.get").length;
    expect(readsAfterSave).toBeGreaterThan(readsBefore);

    openSettings(HOST_ID);
    await waitFor(async () => expect(await settingsSwitchOn()).toBe(true));
    expect(paramsOf("config.agentMemories.get").length).toBeGreaterThan(
      readsAfterSave,
    );
  });

  it("shows the host's answer, not the one Settings read earlier, when the setting was already on and the act sent no set", async () => {
    world.memoriesOn = true;
    await enterTour();
    openSettings(HOST_ID);
    await settled();
    expect(await settingsSwitchOn()).toBe(true);
    closeSettings();

    // The setting is on already: the act writes only the provider switches,
    // and its last read is overtaken by a rebind to an off configuration.
    world.rebindAfterNativeWrites = 2;
    world.overtakenBy = "rebind";
    act(() => useOnboardingStore.getState().reseat(2));
    await screen.findByTestId("onboarding-memory-stage");
    fireEvent.click(await screen.findByTestId("onboarding-memory-use"));
    await clickAdvance();
    await expectOnStep("session-import");
    await settled();
    expect(paramsOf("config.agentMemories.set")).toEqual([]);
    expect(paramsOf("providers.setNativeMemory")).toHaveLength(2);
    expect(world.memoriesOn).toBe(false);

    const before = getsSentTo(HOST_ID);
    openSettings(HOST_ID);
    await waitFor(async () => expect(await settingsSwitchOn()).toBe(false));
    expect(getsSentTo(HOST_ID)).toBeGreaterThan(before);
  });
});

describe("the Memory act: Continue and the host's providers", () => {
  const advance = (): HTMLElement => screen.getByTestId("onboarding-advance");

  it("waits while the providers are being read, and writes them once they are", async () => {
    world.providersGate = deferred();
    await openMemoryAct();
    await chooseTraycer();
    await screen.findByText("Checking your providers");
    expect(advance().hasAttribute("disabled")).toBe(true);
    expect(advance().textContent).toContain("Continue");

    // Enter reaches the same save; with the providers unknown it sends nothing.
    fireEvent.keyDown(document.body, { key: "Enter" });
    // The list is still held, so only writes can be waited out.
    await writesAnswered();
    expect(paramsOf("config.agentMemories.set")).toEqual([]);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);
    expect(currentStepId()).toBe("agent-memories");

    act(() => world.providersGate?.resolve());
    await providerSwitch("codex");
    await waitFor(() => expect(advance().hasAttribute("disabled")).toBe(false));
    await clickAdvance();
    await expectOnStep("session-import");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toEqual([
      { harnessId: "claude", nativeMemory: false },
      { harnessId: "codex", nativeMemory: false },
    ]);
  });

  it("goes on with Traycer memories alone when the providers could not be read", async () => {
    world.providersFail = true;
    await openMemoryAct();
    await chooseTraycer();
    await screen.findByText(/Couldn.t read your providers/);
    expect(advance().hasAttribute("disabled")).toBe(false);

    await clickAdvance();
    await expectOnStep("session-import");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);
  });

  it("goes on with Traycer memories alone when no provider can be switched", async () => {
    world.providers = defaultProviders().map((provider) => ({
      ...provider,
      supported: false,
    }));
    await openMemoryAct();
    await chooseTraycer();
    await screen.findByTestId("onboarding-memory-without-switch");
    expect(advance().hasAttribute("disabled")).toBe(false);

    await clickAdvance();
    await expectOnStep("session-import");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);
  });
});

describe("the Memory act: its own provider writes outrank the list read", () => {
  const nativeWrites = (): unknown[] => paramsOf("providers.setNativeMemory");

  it.each(["pending", "failing"] as const)(
    "writes a provider the person switched back on after the act turned it off, while the list refetch is %s",
    async (refetch) => {
      world.applyNativeWrites = true;
      world.nativeFailures.set("codex", 1);
      await openMemoryAct();
      await chooseTraycer();
      await providerSwitch("codex");
      // The list the act read is from before its own writes; the read they
      // ask for is held or fails.
      if (refetch === "pending") world.providersGate = deferred();
      else world.providersFail = true;

      await clickAdvance();
      const report = await screen.findByTestId("onboarding-memory-save-report");
      expect(report.textContent).toContain("Couldn't change Codex memories.");
      expect(nativeWrites()).toEqual([
        { harnessId: "claude", nativeMemory: false },
        { harnessId: "codex", nativeMemory: false },
      ]);

      fireEvent.click(await providerSwitch("claude-code"));
      await clickAdvance();
      await expectOnStep("session-import");

      expect(nativeWrites().slice(2)).toEqual([
        { harnessId: "claude", nativeMemory: true },
        { harnessId: "codex", nativeMemory: false },
      ]);
      expect(
        world.providers.map((provider) => [
          provider.providerId,
          provider.nativeMemory,
        ]),
      ).toEqual([
        ["claude-code", true],
        ["codex", false],
      ]);
    },
  );

  it("sends a provider again after its write failed, whatever the list says next", async () => {
    world.nativeFailures.set("claude", 1);
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");

    await clickAdvance();
    const report = await screen.findByTestId("onboarding-memory-save-report");
    expect(report.textContent).toContain(
      "Couldn't change Claude Code memories.",
    );

    // The host did take it, and says so; the act cannot know that the write
    // it lost is the reason.
    world.providers = world.providers.map((provider) => ({
      ...provider,
      nativeMemory:
        provider.providerId === "claude-code" ? false : provider.nativeMemory,
    }));
    await invalidateAllQueries();
    await settled();

    await clickAdvance();
    await expectOnStep("session-import");
    expect(
      nativeWrites().filter(
        (p) => (p as { harnessId: string }).harnessId === "claude",
      ),
    ).toEqual([
      { harnessId: "claude", nativeMemory: false },
      { harnessId: "claude", nativeMemory: false },
    ]);
  });

  it("keeps what it wrote when Traycer is turned off and on again", async () => {
    world.applyNativeWrites = true;
    world.nativeFailures.set("codex", 1);
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");
    await clickAdvance();
    await screen.findByTestId("onboarding-memory-save-report");
    expect(nativeWrites()).toEqual([
      { harnessId: "claude", nativeMemory: false },
      { harnessId: "codex", nativeMemory: false },
    ]);

    // A later revision turns Traycer off; the switch is then the person's.
    overturnWrite();
    await invalidateAllQueries();
    await settled();
    fireEvent.click(switchOf("onboarding-memory-traycer"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("onboarding-memory-provider-claude-code"),
      ).toBeNull(),
    );
    fireEvent.click(switchOf("onboarding-memory-traycer"));
    expect(isOn(await providerSwitch("claude-code"))).toBe(false);

    // Claude is off on the host and the act wrote it: nothing to send for it.
    await clickAdvance();
    await settled();
    expect(
      nativeWrites().filter(
        (call) => (call as { harnessId: string }).harnessId === "claude",
      ),
    ).toEqual([{ harnessId: "claude", nativeMemory: false }]);
  });

  it("disables every switch while a save runs, and gives them back after", async () => {
    world.setGate = deferred();
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");
    const traycer = switchOf("onboarding-memory-traycer");
    expect(traycer.hasAttribute("disabled")).toBe(false);

    await clickAdvance();
    await waitFor(() => expect(traycer.hasAttribute("disabled")).toBe(true));
    for (const id of ["claude-code", "codex"])
      expect((await providerSwitch(id)).hasAttribute("disabled")).toBe(true);

    world.nativeFailures.set("codex", 1);
    act(() => world.setGate?.resolve());
    await screen.findByTestId("onboarding-memory-save-report");
    for (const id of ["claude-code", "codex"])
      expect((await providerSwitch(id)).hasAttribute("disabled")).toBe(false);
  });
});

describe("the Memory act: work that outlives the tour", () => {
  // With no session import, Memory is the last act, so a save that lands is
  // the one that would finish the tour.
  let tracked: MockInstance<Analytics["track"]>;
  const completions = (): number =>
    tracked.mock.calls.filter(
      ([event]) => event === AnalyticsEvent.OnboardingCompleted,
    ).length;

  beforeEach(() => {
    world.sessionImport = false;
    navigateMock.mockClear();
    useFirstTaskGuideStore.setState({ status: "inactive" });
    tracked = vi.spyOn(Analytics.getInstance(), "track");
  });
  afterEach(() => {
    tracked.mockRestore();
  });

  async function continueWithSaveHeld(): Promise<void> {
    world.setGate = deferred();
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");
    await clickAdvance();
    await waitFor(() =>
      expect(paramsOf("config.agentMemories.set")).toHaveLength(1),
    );
  }

  it("does not finish the tour a second time when it was skipped while the save ran", async () => {
    await continueWithSaveHeld();
    fireEvent.click(screen.getByTestId("onboarding-skip"));
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");

    act(() => world.setGate?.resolve());
    await writesAnswered();

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
    expect(completions()).toBe(0);
  });

  it("finishes nothing when the page was left while the save ran", async () => {
    await continueWithSaveHeld();
    leaveTour();

    act(() => world.setGate?.resolve());
    await writesAnswered();

    expect(navigateMock).not.toHaveBeenCalled();
    expect(useFirstTaskGuideStore.getState().status).toBe("inactive");
    expect(completions()).toBe(0);
  });

  it("still finishes the tour when nothing was left", async () => {
    await continueWithSaveHeld();
    act(() => world.setGate?.resolve());

    await waitFor(() => expect(navigateMock).toHaveBeenCalledTimes(1));
    expect(useFirstTaskGuideStore.getState().status).toBe("active");
    expect(completions()).toBe(1);
  });
});

describe("the Import act: an open task that outlives the tour", () => {
  let tracked: MockInstance<Analytics["track"]>;
  const completions = (): number =>
    tracked.mock.calls.filter(
      ([event]) => event === AnalyticsEvent.OnboardingCompleted,
    ).length;

  beforeEach(() => {
    navigateMock.mockClear();
    tabIntents.length = 0;
    useFirstTaskGuideStore.setState({ status: "inactive" });
    tracked = vi.spyOn(Analytics.getInstance(), "track");
  });
  afterEach(() => {
    tracked.mockRestore();
  });

  async function openTaskWithReadHeld(): Promise<void> {
    world.chatSettingsGate = deferred();
    await enterTour();
    act(() => useOnboardingStore.getState().reseat(3));
    fireEvent.click(await screen.findByLabelText("Open task: Imported task"));
    await waitFor(() =>
      expect(hostCalls().map((call) => call.method)).toContain(
        "epic.getChatRunSettings",
      ),
    );
  }

  it("opens no task once the tour was skipped while the read ran", async () => {
    await openTaskWithReadHeld();
    fireEvent.click(screen.getByTestId("onboarding-skip"));
    expect(navigateMock).toHaveBeenCalledTimes(1);

    act(() => world.chatSettingsGate?.resolve());
    await settled();

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(tabIntents).toEqual([]);
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
    expect(completions()).toBe(0);
  });

  it("opens no task once the page was left while the read ran", async () => {
    await openTaskWithReadHeld();
    leaveTour();

    act(() => world.chatSettingsGate?.resolve());
    await settled();

    expect(navigateMock).not.toHaveBeenCalled();
    expect(tabIntents).toEqual([]);
    expect(useFirstTaskGuideStore.getState().status).toBe("inactive");
    expect(completions()).toBe(0);
  });

  it("completes the tour and opens the task when nothing was left", async () => {
    await openTaskWithReadHeld();
    act(() => world.chatSettingsGate?.resolve());

    await waitFor(() => expect(tabIntents).toHaveLength(1));
    expect(navigateMock).toHaveBeenCalledWith({ to: "/imported-task" });
    expect(useFirstTaskGuideStore.getState().status).toBe("active");
    expect(completions()).toBe(1);
  });
});

describe("the Memory act: a save that lands after Skip with another act after it", () => {
  let tracked: MockInstance<Analytics["track"]>;
  beforeEach(() => {
    tracked = vi.spyOn(Analytics.getInstance(), "track");
  });
  afterEach(() => {
    tracked.mockRestore();
  });

  it("does not move the tour on a step", async () => {
    world.setGate = deferred();
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");
    await clickAdvance();
    await waitFor(() =>
      expect(paramsOf("config.agentMemories.set")).toHaveLength(1),
    );
    fireEvent.click(screen.getByTestId("onboarding-skip"));
    tracked.mockClear();

    act(() => world.setGate?.resolve());
    await writesAnswered();
    await settled();

    expect(
      tracked.mock.calls.filter(
        ([event]) => event === AnalyticsEvent.OnboardingNavigated,
      ),
    ).toEqual([]);
    expect(currentStepId()).toBe("agent-memories");
  });
});
