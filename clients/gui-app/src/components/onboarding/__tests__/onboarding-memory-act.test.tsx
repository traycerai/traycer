/**
 * The Memory act as the person meets it: what it shows, the host gates and finishing the tour. The faked host and the helpers are in `onboarding-memory-act-fixture.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  chooseTraycer,
  clickAdvance,
  continueFromMemory,
  currentStepId,
  defaultProviders,
  deferred,
  enterTour,
  expectOnStep,
  isOn,
  openMemoryAct,
  paramsOf,
  providerSwitch,
  invalidateAllQueries,
  negotiateManifest,
  cleanupMemoryActFixture,
  resetMemoryActFixture,
  settled,
  switchOf,
  walkToMemoryAct,
  world,
  writesAnswered,
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

describe("the Memory act: what it shows", () => {
  it("gives switches only to enabled, supported, non-Traycer providers, starting off", async () => {
    world.providers = [
      ...defaultProviders(),
      {
        providerId: "opencode",
        enabled: true,
        supported: false,
        nativeMemory: true,
      },
      {
        providerId: "cursor",
        enabled: false,
        supported: true,
        nativeMemory: true,
      },
      {
        providerId: "traycer",
        enabled: true,
        supported: true,
        nativeMemory: true,
      },
    ];
    await openMemoryAct();
    await chooseTraycer();

    const claude = await providerSwitch("claude-code");
    expect(isOn(claude)).toBe(false);
    expect(isOn(await providerSwitch("codex"))).toBe(false);
    expect(
      screen.queryByTestId("onboarding-memory-provider-cursor"),
    ).toBeNull();
    expect(
      screen.queryByTestId("onboarding-memory-provider-opencode"),
    ).toBeNull();
    expect(
      screen.queryByTestId("onboarding-memory-provider-traycer"),
    ).toBeNull();
    expect(
      screen.getByTestId("onboarding-memory-without-switch").textContent,
    ).toBe("Memory settings for OpenCode stay as they are.");
  });

  it("writes nothing while shown, and Not now advances writing nothing", async () => {
    await openMemoryAct();
    await screen.findByTestId("onboarding-memory-not-now");
    await settled();
    expect(paramsOf("config.agentMemories.set")).toEqual([]);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);

    fireEvent.click(screen.getByTestId("onboarding-memory-not-now"));
    await expectOnStep("session-import");
    await settled();
    expect(paramsOf("config.agentMemories.set")).toEqual([]);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);
  });

  it("keeps explicit overrides across Back and Next", async () => {
    await walkToMemoryAct();
    await chooseTraycer();
    fireEvent.click(await providerSwitch("codex"));
    expect(isOn(switchOf("onboarding-memory-provider-codex"))).toBe(true);

    fireEvent.click(screen.getByTestId("onboarding-back"));
    await expectOnStep("providers");
    await clickAdvance();
    await screen.findByTestId("onboarding-memory-stage");

    expect(isOn(await providerSwitch("codex"))).toBe(true);
    expect(isOn(await providerSwitch("claude-code"))).toBe(false);
  });

  it("reconciles a changed selection by provider id", async () => {
    await walkToMemoryAct();
    await chooseTraycer();
    fireEvent.click(await providerSwitch("codex"));

    fireEvent.click(screen.getByTestId("onboarding-back"));
    await expectOnStep("providers");
    // Providers act: Claude Code deselected, Cursor newly enabled.
    world.providers = [
      { ...defaultProviders()[1], nativeMemory: true },
      {
        providerId: "cursor",
        enabled: true,
        supported: true,
        nativeMemory: true,
      },
      { ...defaultProviders()[0], enabled: false },
    ];
    // Enabling and disabling providers is what invalidates this list.
    await act(() => invalidateAllQueries());
    await clickAdvance();
    await screen.findByTestId("onboarding-memory-stage");

    await waitFor(() =>
      expect(
        screen.queryByTestId("onboarding-memory-provider-claude-code"),
      ).toBeNull(),
    );
    expect(isOn(await providerSwitch("codex"))).toBe(true);
    expect(isOn(await providerSwitch("cursor"))).toBe(false);

    await continueFromMemory();
    await expectOnStep("session-import");
    expect(paramsOf("providers.setNativeMemory")).toEqual([
      { harnessId: "cursor", nativeMemory: false },
    ]);
  });
});

describe("the Memory act: host gates", () => {
  it("is not in the tour on a host without config.agentMemories", async () => {
    negotiateManifest({
      "providers.list": { major: 10, minor: 8 },
      "providers.setNativeMemory": { major: 1, minor: 0 },
    });
    await enterTour();
    await clickAdvance();
    await expectOnStep("providers");
    await clickAdvance();
    await expectOnStep("session-import");
    expect(screen.queryByTestId("onboarding-memory-stage")).toBeNull();
  });

  it.each([
    [
      "providers.setNativeMemory is not negotiated",
      {
        "providers.list": { major: 10, minor: 8 },
        "config.agentMemories.get": { major: 1, minor: 0 },
        "config.agentMemories.set": { major: 1, minor: 0 },
      },
    ],
    [
      "providers.list is older than 10.8",
      {
        "providers.list": { major: 10, minor: 7 },
        "providers.setNativeMemory": { major: 1, minor: 0 },
        "config.agentMemories.get": { major: 1, minor: 0 },
        "config.agentMemories.set": { major: 1, minor: 0 },
      },
    ],
  ])("offers no provider switches when %s", async (_name, manifest) => {
    negotiateManifest(manifest);
    await walkToMemoryAct();
    await chooseTraycer();

    const line = await screen.findByTestId("onboarding-memory-without-switch");
    expect(line.textContent).toBe(
      "Memory settings for Claude Code and Codex stay as they are.",
    );
    expect(screen.queryAllByRole("switch")).toHaveLength(1);

    await continueFromMemory();
    await expectOnStep("session-import");
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);
  });
});

describe("the Memory act: finishing", () => {
  it("is the last act without import, reads Start building, and finishes only once saved", async () => {
    world.sessionImport = false;
    world.setGate = deferred();
    await openMemoryAct();
    await chooseTraycer();
    expect(screen.getByTestId("onboarding-advance").textContent).toContain(
      "Start building",
    );

    await continueFromMemory();
    await waitFor(() =>
      expect(paramsOf("config.agentMemories.set")).toHaveLength(1),
    );
    expect(useOnboardingStore.getState().completedAt).toBeNull();

    act(() => world.setGate?.resolve());
    await waitFor(() =>
      expect(useOnboardingStore.getState().completedAt).toEqual(
        expect.any(Number),
      ),
    );
  });

  it("does not advance a person who pressed Back while the save was in flight", async () => {
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
    await waitFor(() =>
      expect(paramsOf("providers.setNativeMemory")).toHaveLength(2),
    );
    await writesAnswered();

    // The store holds the position the save would have moved; the page draws it a frame later.
    expect(useOnboardingStore.getState().step).toBe(1);
    expect(currentStepId()).toBe("providers");
  });

  it("saves on Enter, then advances", async () => {
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");

    fireEvent.keyDown(document.body, { key: "Enter" });
    await expectOnStep("session-import");

    expect(paramsOf("config.agentMemories.set")).toEqual([{ enabled: true }]);
    expect(paramsOf("providers.setNativeMemory")).toEqual([
      { harnessId: "claude", nativeMemory: false },
      { harnessId: "codex", nativeMemory: false },
    ]);
  });
});
