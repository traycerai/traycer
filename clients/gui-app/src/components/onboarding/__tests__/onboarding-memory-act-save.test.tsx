/**
 * The Memory act's saves: what Continue writes, the order, a failed write and a queued one. The faked host and the helpers are in `onboarding-memory-act-fixture.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  ENVIRONMENT_ID,
  fixtureAuthService,
  acceptHeldWrite,
  deliverAcceptedWrites,
  deliverSavedWrite,
  writesAnswered,
  overturnWrite,
  cleanupMemoryActFixture,
  resetMemoryActFixture,
  chooseTraycer,
  clickAdvance,
  currentStepId,
  defaultProviders,
  expectOnStep,
  invalidateAllQueries,
  hostCalls,
  holdAgentMemoriesSetMutation,
  isOn,
  methodsInOrder,
  openMemoryAct,
  paramsOf,
  providerSwitch,
  settled,
  switchOf,
  world,
} from "@/components/onboarding/__tests__/onboarding-memory-act-fixture";

import { configMutationKeys } from "@/lib/query-keys";

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
    await screen.findByText(/Agents keep using common memory/);
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

describe("the Memory act: a write abandoned before it was sent", () => {
  it("ends the save unsent, sends nothing more, and leaves the act as it was before the press", async () => {
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");
    const advance = screen.getByTestId("onboarding-advance");
    const labelBefore = advance.textContent;
    const auth = fixtureAuthService();
    await waitFor(() =>
      expect(auth.environmentCloud().onOriginSignIn()).toBe(true),
    );
    const pressedOrigin = auth.environmentCloud();
    const heldMutation = holdAgentMemoriesSetMutation();

    try {
      await clickAdvance();
      await heldMutation.started;

      expect(heldMutation.capture()).toEqual({
        mutationKey: configMutationKeys.agentMemoriesSet(),
        variables: { enabled: true },
      });
      expect(pressedOrigin.onOriginSignIn()).toBe(true);
      expect(currentStepId()).toBe("agent-memories");
      expect(isOn(switchOf("onboarding-memory-traycer"))).toBe(true);
      expect(advance.hasAttribute("disabled")).toBe(true);

      expect(await auth.signOut()).toBe(true);
      expect(pressedOrigin.onOriginSignIn()).toBe(false);
    } finally {
      heldMutation.release();
    }

    await writesAnswered();
    await waitFor(() => expect(advance.hasAttribute("disabled")).toBe(false));

    expect(screen.queryByTestId("onboarding-memory-save-report")).toBeNull();
    expect(currentStepId()).toBe("agent-memories");
    expect(advance.textContent).toBe(labelBefore);
    expect(paramsOf("config.agentMemories.set")).toEqual([]);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);
  });

  it("still files a provider write abandoned before it was sent as failed", async () => {
    world.nativeFailures.set("codex", 1);
    world.nativeFailureKind = "abandoned";
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");

    await clickAdvance();
    const report = await screen.findByTestId("onboarding-memory-save-report");

    expect(report.textContent).toContain("Couldn't change Codex memories.");
    expect(currentStepId()).toBe("agent-memories");
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
    expect(report.textContent).toContain("Agents now use common memory.");

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
      "Common memory for agents is saved to your configuration but hasn't reached this computer yet.",
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
    ).toContain("Couldn't turn on common memory for agents.");
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
