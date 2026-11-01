import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRpcRegistry } from "@/lib/host";
import type { ComposerControls } from "@/lib/commands/composer-controls-registry";
import type { FocusedComposerKind } from "@/lib/commands/types";

// What the host the composer sits on can run, and what the sandbox catalogue
// offers. By default the host reports the person's Codex pick unavailable and
// Claude runnable, the state the Start page was in when E19 was seen.
const host = vi.hoisted(() => {
  const available = (claude: boolean, codex: boolean) => ({
    harnesses: [
      { id: "claude", available: claude },
      { id: "codex", available: codex },
      { id: "traycer", available: true },
    ],
  });
  return {
    available,
    harnesses: available(true, false),
    offeredAgents: undefined as ReadonlyArray<string> | undefined,
    /** The cloud's Traycer catalogue: `undefined` while it loads. */
    cloudTraycer: undefined as
      | ReadonlyArray<{ readonly slug: string }>
      | undefined,
  };
});

function modelOption(harnessId: string, slug: string) {
  return {
    harnessId,
    slug,
    label: slug,
    description: null,
    isDefault: true,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [
      { id: "low", label: "Low", description: null },
      { id: "high", label: "High", description: null },
    ],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

// Stable references: a fresh list per render would push a new catalog on
// every render.
const CLAUDE_MODELS = { models: [modelOption("claude", "sonnet-5.5")] };
const CODEX_MODELS = { models: [modelOption("codex", "gpt-6-astra")] };
// The host's own Traycer list: it does not hold the person's saved model.
const TRAYCER_HOST_MODELS = {
  models: [modelOption("traycer", "traycer-default")],
};

// The cloud's Traycer catalog, read only for a Traycer pick sent to a sandbox.
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({
    data: host.cloudTraycer?.map((m) => modelOption("traycer", m.slug)),
  }),
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({ data: host.harnesses }),
  useGuiHarnessModelsQueryForClient: (
    _client: HostClient<HostRpcRegistry> | null,
    harnessId: string,
  ) => {
    if (harnessId === "claude") return { data: CLAUDE_MODELS };
    return {
      data: harnessId === "traycer" ? TRAYCER_HOST_MODELS : CODEX_MODELS,
    };
  },
}));

vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    data:
      host.offeredAgents === undefined
        ? undefined
        : { providers: [], offeredAgents: host.offeredAgents },
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://billing.test" }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: null,
    refetch: () => Promise.resolve({ data: null, isError: false }),
  }),
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));

vi.mock("@/hooks/command-palette/use-register-composer-controls", () => ({
  useRegisterFocusedComposerControls: (
    _kind: FocusedComposerKind | null,
    _controls: ComposerControls,
    _hostClient: HostClient<HostRpcRegistry> | null,
  ) => undefined,
}));

vi.mock("@/hooks/providers/use-resolved-seeded-profile-id", () => ({
  useResolvedSeededProfileId: (_harnessId: string, profileId: string | null) =>
    profileId,
}));

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import { useStagedSendSignInCheck } from "@/hooks/sandboxes/use-staged-send-sign-in-check";
import { pickedRunSettings } from "@/lib/sandboxes/pending-sandbox-send";
import {
  chipModelName,
  type ComposerToolbarStoreState,
} from "@/stores/composer/composer-toolbar-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";

const HOST_ID = "laptop-host";
const SURFACE = "landing:window-1";

function buildTestHostClient(hostId: string): HostClient<HostRpcRegistry> {
  const entry = {
    hostId,
    label: hostId,
    kind: "local" as const,
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    transportDialability: "dialable" as const,
  };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (id) => (id === entry.hostId ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${hostId}`,
      handlers: {},
    }),
  });
  return spine.createRequester(entry);
}

const HOST_CLIENT = buildTestHostClient(HOST_ID);

// The person's own pick, as their last run left it.
const PICK: ChatRunSettings = {
  ultracode: false,
  harnessId: "codex",
  model: "gpt-6-astra",
  permissionMode: "supervised",
  reasoningEffort: "low",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

function newTarget(os: "linux" | "windows", cpus: number): StagedSandboxTarget {
  return {
    kind: "new",
    configuration: { kind: "personal" },
    shape: {
      os,
      cpus,
      memoryMb: cpus * 4096,
      diskMb: null,
      region: "us-east",
      idleMinutes: 30,
      destroyAfterRestingMinutes: null,
    },
    name: "",
    wakeString: null,
  };
}

/** What the chip shows. */
function chip(state: ComposerToolbarStoreState) {
  return {
    harnessId: state.selection.harnessId,
    model: state.selection.modelSlug,
    reasoningEffort: state.reasoning,
  };
}

/** What a staged send carries to its task. */
function sent(state: ComposerToolbarStoreState) {
  const settings = pickedRunSettings(state);
  return {
    harnessId: settings.harnessId,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
  };
}

function renderLandingToolbar(
  onSettingsChange: ((settings: ChatRunSettings) => void) | null,
  pick: ChatRunSettings,
) {
  return renderHook(() =>
    useComposerToolbarStore(
      "landing",
      fallbackSeedSource(pick, HOST_CLIENT),
      onSettingsChange,
      {
        hostClient: HOST_CLIENT,
        hostId: HOST_ID,
        tuiOnly: false,
        chatLineCarriesAutoMode: null,
        ultracodeCarried: false,
        stagedSurfaceKey: SURFACE,
        sendsToRestingSandbox: false,
      },
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  useStagedSandboxStore.setState({ bySurface: {} });
  host.harnesses = host.available(true, false);
  host.offeredAgents = undefined;
  host.cloudTraycer = undefined;
  useComposerHarnessMemoryStore.getState().resetForTests();
});

afterEach(() => {
  cleanup();
});

const CLAUDE_SHOWN = {
  harnessId: "claude",
  model: "sonnet-5.5",
  reasoningEffort: "low",
};

describe("a composer with a sandbox staged (E19)", () => {
  it("keeps the shown reroute through every shape, and writes no other store", async () => {
    const onSettingsChange = vi.fn<(settings: ChatRunSettings) => void>();
    const { result } = renderLandingToolbar(onSettingsChange, PICK);
    const store = result.current;

    // No stage: this host cannot run Codex, so the chip shows Claude.
    await waitFor(() => expect(chip(store.getState())).toEqual(CLAUDE_SHOWN));
    // A stage on another surface keeps nothing here.
    act(() => {
      useStagedSandboxStore
        .getState()
        .stage("landing:window-2", newTarget("linux", 2));
    });
    expect(chip(store.getState()).harnessId).toBe("claude");

    const emitsBefore = onSettingsChange.mock.calls.length;
    const memoryBefore = useComposerHarnessMemoryStore.getState().byHost;

    // The New row: the pick on screen is the person's, and the send carries it.
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, newTarget("linux", 2));
    });
    await waitFor(() =>
      expect(store.getState().values.selection.harnessId).toBe("claude"),
    );
    expect(chip(store.getState())).toEqual(CLAUDE_SHOWN);
    expect(sent(store.getState())).toEqual(CLAUDE_SHOWN);

    // The shape sheet's Use: Windows, a bigger size. The pick stays put.
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, newTarget("windows", 4));
    });
    expect(chip(store.getState())).toEqual(CLAUDE_SHOWN);
    expect(sent(store.getState())).toEqual(CLAUDE_SHOWN);

    // Adopting the pick is this composer's own: neither the per-host
    // last-run settings nor the harness memory heard of it.
    expect(onSettingsChange).toHaveBeenCalledTimes(emitsBefore);
    expect(useComposerHarnessMemoryStore.getState().byHost).toBe(memoryBefore);
  });

  it("keeps a pick the host can run, untouched", async () => {
    host.harnesses = host.available(true, true);
    const { result } = renderLandingToolbar(null, PICK);
    const store = result.current;
    const codex = {
      harnessId: "codex",
      model: "gpt-6-astra",
      reasoningEffort: "low",
    };
    await waitFor(() => expect(chip(store.getState())).toEqual(codex));
    const values = store.getState().values;

    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, newTarget("linux", 2));
    });

    await waitFor(() =>
      expect(store.getState().catalog.keepsUnavailablePick).toBe(true),
    );
    expect(store.getState().values).toBe(values);
    expect(chip(store.getState())).toEqual(codex);
    expect(sent(store.getState())).toEqual(codex);
  });

  it("returns to the host's decision when the stage is dropped", async () => {
    const { result, rerender } = renderLandingToolbar(null, PICK);
    const store = result.current;
    await waitFor(() => expect(chip(store.getState())).toEqual(CLAUDE_SHOWN));
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, newTarget("linux", 2));
    });
    await waitFor(() =>
      expect(store.getState().values.selection.harnessId).toBe("claude"),
    );

    // Claude runs here, so the adopted pick stays once the stage is gone.
    act(() => {
      useStagedSandboxStore.getState().clear(SURFACE);
    });
    await waitFor(() =>
      expect(store.getState().catalog.keepsUnavailablePick).toBe(false),
    );
    expect(chip(store.getState())).toEqual(CLAUDE_SHOWN);

    // The host can no longer run the kept pick: the host reroutes again.
    host.harnesses = host.available(false, true);
    rerender();
    await waitFor(() => expect(chip(store.getState()).harnessId).toBe("codex"));
    expect(store.getState().values.selection.harnessId).toBe("claude");
  });

  it("refuses the shown pick at Send when the sandbox does not offer it", async () => {
    host.offeredAgents = ["codex"];
    const { result } = renderLandingToolbar(null, PICK);
    const store = result.current;
    await waitFor(() => expect(chip(store.getState())).toEqual(CLAUDE_SHOWN));
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, newTarget("linux", 2));
    });
    await waitFor(() =>
      expect(store.getState().catalog.keepsUnavailablePick).toBe(true),
    );

    // The gate reads the harness the send carries, as the landing composer does.
    const stage = readStagedSandbox(SURFACE);
    if (stage === null) throw new Error("the stage was not recorded");
    const gate = renderHook(() =>
      useStagedSendSignInCheck({
        harnessId: pickedRunSettings(store.getState()).harnessId,
        modelSlug: pickedRunSettings(store.getState()).model,
        modelName: chipModelName(store.getState()),
        active: true,
      }),
    ).result.current;

    expect(gate.check(stage)?.message).toBe(
      "Claude Code doesn't run on sandboxes. Choose a Traycer model to run agents here.",
    );
    expect((await gate.beforeSend(stage))?.message).toBe(
      "Claude Code doesn't run on sandboxes. Choose a Traycer model to run agents here.",
    );
  });

  it("keeps the shown model when the saved one is not on the host, through the cloud catalogue loading and answering", async () => {
    const saved: ChatRunSettings = {
      ...PICK,
      harnessId: "traycer",
      model: "traycer-saved",
      reasoningEffort: null,
    };
    const { result, rerender } = renderLandingToolbar(null, saved);
    const store = result.current;
    const shown = {
      harnessId: "traycer",
      model: "traycer-default",
      reasoningEffort: "",
    };
    await waitFor(() =>
      expect(store.getState().selection.modelSlug).toBe("traycer-default"),
    );

    // The stage: the cloud's catalogue is still loading.
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, newTarget("linux", 2));
    });
    await waitFor(() =>
      expect(store.getState().catalog.keepsUnavailablePick).toBe(true),
    );
    expect(store.getState().selection.modelSlug).toBe("traycer-default");
    expect(sent(store.getState()).model).toBe("traycer-default");

    // It answers with a list that holds the saved model.
    host.cloudTraycer = [
      { slug: "traycer-saved" },
      { slug: "traycer-default" },
    ];
    rerender();
    await waitFor(() =>
      expect(store.getState().catalog.modelsLoaded).toBe(true),
    );

    expect(chip(store.getState()).model).toBe(shown.model);
    expect(sent(store.getState()).model).toBe("traycer-default");
  });

  describe("the draft write of a kept pick whose saved model the catalogue lacks", () => {
    const saved: ChatRunSettings = {
      ...PICK,
      harnessId: "traycer",
      model: "traycer-saved",
      reasoningEffort: null,
    };

    function renderWatched() {
      const hook = renderLandingToolbar(null, saved);
      const kept = vi.fn<(settings: ChatRunSettings) => void>();
      hook.result.current.setState({ onShownPickKept: kept });
      return { ...hook, store: hook.result.current, kept };
    }

    it("writes the model that was on screen, not the cached catalogue's heal of it", async () => {
      // The cloud's list is already cached, and holds only the saved model.
      host.cloudTraycer = [{ slug: "traycer-saved" }];
      const { store, kept } = renderWatched();
      await waitFor(() =>
        expect(store.getState().selection.modelSlug).toBe("traycer-default"),
      );

      act(() => {
        useStagedSandboxStore.getState().stage(SURFACE, newTarget("linux", 2));
      });

      await waitFor(() => expect(kept).toHaveBeenCalled());
      expect(kept.mock.calls.map(([settings]) => settings.model)).toEqual([
        "traycer-default",
      ]);
      expect(sent(store.getState()).model).toBe("traycer-default");
    });

    it("keeps writing it when the cloud list arrives after the stage", async () => {
      const { store, kept, rerender } = renderWatched();
      await waitFor(() =>
        expect(store.getState().selection.modelSlug).toBe("traycer-default"),
      );
      act(() => {
        useStagedSandboxStore.getState().stage(SURFACE, newTarget("linux", 2));
      });
      await waitFor(() => expect(kept).toHaveBeenCalled());

      host.cloudTraycer = [{ slug: "traycer-saved" }];
      rerender();
      await waitFor(() =>
        expect(store.getState().catalog.modelsLoaded).toBe(true),
      );

      expect(kept.mock.calls.map(([settings]) => settings.model)).toEqual([
        "traycer-default",
      ]);
      expect(sent(store.getState()).model).toBe("traycer-default");
    });
  });
});
