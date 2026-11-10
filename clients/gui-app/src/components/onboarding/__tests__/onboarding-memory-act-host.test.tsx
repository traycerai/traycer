/**
 * A save that is still running when the person picks another host in the act's
 * host picker. The faked host and the helpers are in
 * `onboarding-memory-act-fixture.tsx`.
 */
import { useEffect, useMemo, useState } from "react";
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
  expectSettingsReaderIsCurrent,
  invalidateAllQueries,
  readsAnswered,
  refreshHostDirectory,
  renderInHost,
  openMemoryAct,
  paramsOf,
  providerSwitch,
  resetMemoryActFixture,
  settled,
  world,
  writesAnswered,
} from "@/components/onboarding/__tests__/onboarding-memory-act-fixture";
import {
  useOnboardingAgentMemories,
  type OnboardingAgentMemories,
} from "@/components/onboarding/use-onboarding-agent-memories";
import { HostRuntimeContext, useHostBinding } from "@/lib/host";
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

/** Picks a machine in the host picker, and waits until the picker names it. */
async function pickHost(label: string): Promise<void> {
  const trigger = await waitFor(() =>
    within(screen.getByTestId("onboarding-host-picker-bar")).getByRole(
      "button",
    ),
  );
  fireEvent.click(trigger);
  fireEvent.click(
    await screen.findByRole("option", { name: new RegExp(label) }),
  );
  // The act follows the picker: its reads and writes now address this host.
  await waitFor(() =>
    expect(
      screen.getByTestId("onboarding-host-picker-bar").textContent,
    ).toContain(label),
  );
}

const pickOtherHost = (): Promise<void> => pickHost(OTHER_HOST.label);

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
    // Writes go one at a time, each after a read: the first is held open.
    await waitFor(() =>
      expect(paramsOf("providers.setNativeMemory")).toHaveLength(1),
    );

    await pickOtherHost();
    act(() => world.nativeGate?.resolve());
    await writesAnswered();
    await settled();

    expect(
      callsTo(HOST_ID).filter(
        (call) => call.method === "providers.setNativeMemory",
      ),
    ).toHaveLength(1);
    expect(methodsSentTo(OTHER_HOST.hostId)).not.toContain(
      "providers.setNativeMemory",
    );
    expect(useOnboardingStore.getState().step).toBe(2);
    expect(currentStepId()).toBe("agent-memories");
  });

  it("keeps a stopped save stopped when the first host is picked again", async () => {
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
    await pickHost("MacBook Pro");
    act(() => world.setGate?.resolve());
    await writesAnswered();

    expect(methodsSentTo(HOST_ID)).not.toContain("providers.setNativeMemory");
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

interface MemoryProbe {
  readonly memory: OnboardingAgentMemories;
  readonly pickHost: (hostId: string | null) => void;
}

/** The hook as the tour calls it, with the picked host a test can move. */
function MemoryHookHost(props: {
  readonly onRender: (probe: MemoryProbe) => void;
}) {
  const [pickedHostId, setPickedHostId] = useState<string | null>(HOST_ID);
  const memory = useOnboardingAgentMemories({
    active: true,
    hostUsable: true,
    pickedHostId,
  });
  const { onRender } = props;
  useEffect(() => {
    onRender({ memory, pickHost: setPickedHostId });
  }, [memory, onRender]);
  return null;
}

describe("the Memory act's save: the picker names another host but the client stays", () => {
  it("stops a save when only the picked host changes", async () => {
    world.setGate = deferred();
    let latest: MemoryProbe | null = null;
    const current = (): MemoryProbe => {
      if (latest === null) throw new Error("the hook has not rendered yet");
      return latest;
    };
    renderInHost(
      <MemoryHookHost
        onRender={(probe) => {
          latest = probe;
        }}
      />,
    );
    await waitFor(() => expect(current().memory.rows).toHaveLength(2));
    act(() => current().memory.choose());
    await waitFor(() => expect(current().memory.chosen).toBe(true));

    let saved: Promise<boolean> = Promise.resolve(true);
    act(() => {
      saved = current().memory.save();
    });
    await waitFor(() =>
      expect(paramsOf("config.agentMemories.set")).toHaveLength(1),
    );

    // The client still addresses the first host; only the picker's name moves.
    act(() => current().pickHost(OTHER_HOST.hostId));
    act(() => world.setGate?.resolve());

    await expect(saved).resolves.toBe(false);
    expect(methodsSentTo(HOST_ID)).not.toContain("providers.setNativeMemory");
  });
});

interface RebindProbe {
  readonly memory: OnboardingAgentMemories;
  readonly bindTo: (hostId: string) => void;
  readonly leave: () => void;
}

/**
 * The hook under a binding a test can move between hosts, as the tour's
 * picker does: the client and the host it names change together.
 */
function RebindableMemoryHost(props: {
  readonly onRender: (probe: RebindProbe) => void;
}) {
  const ambient = useHostBinding();
  const [boundHost, setBoundHost] = useState<string>(HOST_ID);
  const binding = useMemo(
    () =>
      ambient === null
        ? null
        : {
            ...ambient,
            hostClient: ambient.hostClient.createRequesterForHostId(boundHost),
            hostId: boundHost,
          },
    [ambient, boundHost],
  );
  return (
    <HostRuntimeContext.Provider value={binding}>
      <BoundMemoryHook
        pickedHostId={boundHost}
        bindTo={setBoundHost}
        onRender={props.onRender}
      />
    </HostRuntimeContext.Provider>
  );
}

function BoundMemoryHook(props: {
  readonly pickedHostId: string;
  readonly bindTo: (hostId: string) => void;
  readonly onRender: (probe: RebindProbe) => void;
}) {
  const [active, setActive] = useState(true);
  const memory = useOnboardingAgentMemories({
    active,
    hostUsable: true,
    pickedHostId: props.pickedHostId,
  });
  const { onRender, bindTo } = props;
  useEffect(() => {
    onRender({ memory, bindTo, leave: () => setActive(false) });
  }, [memory, bindTo, onRender]);
  return null;
}

describe("the Memory act's save: a held write outlives a choice made on another host", () => {
  it("sends the first host no second set after a choice on another host replaced its draft", async () => {
    world.otherHosts = [OTHER_HOST];
    world.setAnswers = ["queued"];
    let latest: RebindProbe | null = null;
    const current = (): RebindProbe => {
      if (latest === null) throw new Error("the hook has not rendered yet");
      return latest;
    };
    renderInHost(
      <RebindableMemoryHost
        onRender={(probe) => {
          latest = probe;
        }}
      />,
    );
    await waitFor(() => expect(current().memory.rows).toHaveLength(2));
    act(() => current().memory.choose());
    await waitFor(() => expect(current().memory.chosen).toBe(true));
    await act(async () => {
      await current().memory.save();
    });
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);

    // A choice on the other host replaces the draft kept for the first.
    act(() => current().bindTo(OTHER_HOST.hostId));
    act(() => current().memory.choose());
    act(() => current().bindTo(HOST_ID));
    await waitFor(() => expect(current().memory.rows).toHaveLength(2));
    act(() => current().memory.choose());
    await waitFor(() => expect(current().memory.chosen).toBe(true));
    let saved = true;
    await act(async () => {
      saved = await current().memory.save();
    });

    expect(saved).toBe(false);
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
  });
});

describe("the Memory act: Settings reads the host after the act is left mid-save", () => {
  /** The hook with a save held on the first host, in a binding that can move. */
  async function startHeldSave(): Promise<() => RebindProbe> {
    world.otherHosts = [OTHER_HOST];
    let latest: RebindProbe | null = null;
    const current = (): RebindProbe => {
      if (latest === null) throw new Error("the hook has not rendered yet");
      return latest;
    };
    renderInHost(
      <RebindableMemoryHost
        onRender={(probe) => {
          latest = probe;
        }}
      />,
    );
    await waitFor(() => expect(current().memory.rows).toHaveLength(2));
    act(() => current().memory.choose());
    await waitFor(() => expect(current().memory.chosen).toBe(true));
    return current;
  }

  it("on the host the person moved to, when its first read lands after the act was left", async () => {
    const current = await startHeldSave();
    world.setGate = deferred();
    act(() => {
      void current().memory.save();
    });
    await waitFor(() =>
      expect(paramsOf("config.agentMemories.set")).toHaveLength(1),
    );

    // The person moves to B, whose first read is held open, and leaves.
    world.getGate = deferred();
    act(() => current().bindTo(OTHER_HOST.hostId));
    await waitFor(() =>
      expect(
        callsTo(OTHER_HOST.hostId).filter(
          (call) => call.method === "config.agentMemories.get",
        ),
      ).toHaveLength(1),
    );
    act(() => current().leave());
    act(() => world.getGate?.resolve());
    await readsAnswered();
    act(() => world.setGate?.resolve());
    await writesAnswered();
    await settled();

    await expectSettingsReaderIsCurrent(OTHER_HOST.hostId);
  });

  it("on the first host, when the person went to another and back while a provider write was held", async () => {
    const current = await startHeldSave();
    world.nativeGate = deferred();
    act(() => {
      void current().memory.save();
    });
    await waitFor(() =>
      expect(paramsOf("providers.setNativeMemory")).toHaveLength(1),
    );

    // Back on the first host, an ordinary read is held open as the act is left.
    act(() => current().bindTo(OTHER_HOST.hostId));
    world.getGate = deferred();
    act(() => current().bindTo(HOST_ID));
    await waitFor(() =>
      expect(
        callsTo(HOST_ID).filter(
          (call) => call.method === "config.agentMemories.get",
        ).length,
      ).toBeGreaterThan(2),
    );
    act(() => current().leave());
    act(() => world.nativeGate?.resolve());
    await writesAnswered();
    act(() => world.getGate?.resolve());
    await settled();

    await expectSettingsReaderIsCurrent(HOST_ID);
  });
});
