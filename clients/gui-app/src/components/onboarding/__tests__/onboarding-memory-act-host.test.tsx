/**
 * A save that is still running when the person picks another host in the act's
 * host picker. The faked host and the helpers are in
 * `onboarding-memory-act-fixture.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  HOST_ID,
  OTHER_HOST,
  callsTo,
  chooseTraycer,
  cleanupMemoryActFixture,
  continueFromMemory,
  currentStepId,
  deferred,
  invalidateAllQueries,
  refreshHostDirectory,
  openMemoryAct,
  paramsOf,
  providerSwitch,
  resetMemoryActFixture,
  settled,
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

/** Picks the second machine, and waits until the act is reading from it. */
async function pickOtherHost(): Promise<void> {
  const trigger = await waitFor(() =>
    within(screen.getByTestId("onboarding-host-picker-bar")).getByRole(
      "button",
    ),
  );
  fireEvent.click(trigger);
  fireEvent.click(
    await screen.findByRole("option", { name: new RegExp(OTHER_HOST.label) }),
  );
  // The act follows the picker: its reads and writes now address this host.
  await waitFor(() =>
    expect(
      screen.getByTestId("onboarding-host-picker-bar").textContent,
    ).toContain(OTHER_HOST.label),
  );
}

function methodsSentTo(hostId: string): string[] {
  return callsTo(hostId).map((call) => call.method);
}

describe("the Memory act: the host is picked while a save is running", () => {
  it("sends no provider write to either host once the act shows another", async () => {
    world.otherHosts = [OTHER_HOST];
    world.setGate = deferred();
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");
    await continueFromMemory();
    await waitFor(() =>
      expect(paramsOf("config.agentMemories.set")).toHaveLength(1),
    );

    await pickOtherHost();
    act(() => world.setGate?.resolve());
    await writesAnswered();
    await settled();

    expect(methodsSentTo(HOST_ID)).not.toContain("providers.setNativeMemory");
    expect(methodsSentTo(OTHER_HOST.hostId)).not.toContain(
      "providers.setNativeMemory",
    );
    expect(methodsSentTo(OTHER_HOST.hostId)).not.toContain(
      "config.agentMemories.set",
    );
    expect(methodsSentTo(OTHER_HOST.hostId)).not.toContain(
      "environment.status",
    );
    expect(useOnboardingStore.getState().step).toBe(2);
    expect(currentStepId()).toBe("agent-memories");
  });

  it("does not move the tour on when its last write lands after the host was picked", async () => {
    world.otherHosts = [OTHER_HOST];
    world.nativeGate = deferred();
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");
    await continueFromMemory();
    await waitFor(() =>
      expect(paramsOf("providers.setNativeMemory")).toHaveLength(2),
    );

    await pickOtherHost();
    act(() => world.nativeGate?.resolve());
    await writesAnswered();
    await settled();

    expect(
      callsTo(HOST_ID).filter(
        (call) => call.method === "providers.setNativeMemory",
      ),
    ).toHaveLength(2);
    expect(methodsSentTo(OTHER_HOST.hostId)).not.toContain(
      "providers.setNativeMemory",
    );
    expect(useOnboardingStore.getState().step).toBe(2);
    expect(currentStepId()).toBe("agent-memories");
  });

  it("sends nothing once the picked host drops out and the tour falls back to the first host", async () => {
    world.otherHosts = [OTHER_HOST];
    world.setGate = deferred();
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");
    await continueFromMemory();
    await waitFor(() =>
      expect(paramsOf("config.agentMemories.set")).toHaveLength(1),
    );

    await pickOtherHost();
    // The picked machine leaves the host list: the page has no client for it
    // and goes back to the window's own, while the save is still held.
    world.otherHosts = [];
    await act(() => refreshHostDirectory());
    await act(() => invalidateAllQueries());
    await waitFor(() =>
      expect(
        screen.getByTestId("onboarding-host-picker-bar").textContent,
      ).not.toContain(OTHER_HOST.label),
    );
    act(() => world.setGate?.resolve());
    await writesAnswered();

    expect(methodsSentTo(HOST_ID)).not.toContain("providers.setNativeMemory");
    expect(methodsSentTo(OTHER_HOST.hostId)).not.toContain(
      "providers.setNativeMemory",
    );
    expect(useOnboardingStore.getState().step).toBe(2);
    expect(currentStepId()).toBe("agent-memories");
  });
});
