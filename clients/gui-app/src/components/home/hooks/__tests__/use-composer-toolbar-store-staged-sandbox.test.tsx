import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRpcRegistry } from "@/lib/host";
import type { ComposerControls } from "@/lib/commands/composer-controls-registry";
import type { FocusedComposerKind } from "@/lib/commands/types";

// The host the composer sits on reports the person's Codex pick unavailable
// and Claude runnable, the state the Start page was in when E19 was seen.
const HARNESSES = {
  harnesses: [
    { id: "claude", available: true },
    { id: "codex", available: false },
  ],
};

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

// The cloud's Traycer catalog, read only for a Traycer pick sent to a sandbox.
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({ data: undefined }),
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({ data: HARNESSES }),
  useGuiHarnessModelsQueryForClient: (
    _client: HostClient<HostRpcRegistry> | null,
    harnessId: string,
  ) => ({ data: harnessId === "claude" ? CLAUDE_MODELS : CODEX_MODELS }),
}));

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
import { pickedRunSettings } from "@/lib/sandboxes/pending-sandbox-send";
import type { ComposerToolbarStoreState } from "@/stores/composer/composer-toolbar-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import {
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

function renderLandingToolbar() {
  return renderHook(() =>
    useComposerToolbarStore(
      "landing",
      fallbackSeedSource(PICK, HOST_CLIENT),
      null,
      {
        hostClient: HOST_CLIENT,
        hostId: HOST_ID,
        tuiOnly: false,
        chatLineCarriesAutoMode: null,
        stagedSurfaceKey: SURFACE,
        sendsToRestingSandbox: false,
      },
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  useStagedSandboxStore.setState({ bySurface: {} });
  useComposerHarnessMemoryStore.getState().resetForTests();
});

afterEach(() => {
  cleanup();
});

describe("a composer with a sandbox staged (E19)", () => {
  it("shows the model the staged send runs, through every shape, until the stage is dropped", async () => {
    const { result } = renderLandingToolbar();
    const store = result.current;

    // No stage: this host runs the send, so it still swaps in the agent it
    // can run, and the send runs that one too.
    await waitFor(() =>
      expect(chip(store.getState())).toEqual({
        harnessId: "claude",
        model: "sonnet-5.5",
        reasoningEffort: "low",
      }),
    );
    // A stage on another surface keeps nothing here.
    act(() => {
      useStagedSandboxStore
        .getState()
        .stage("landing:window-2", newTarget("linux", 2));
    });
    expect(chip(store.getState()).harnessId).toBe("claude");

    // The New row: the send now runs on the sandbox with the person's pick,
    // and the chip shows exactly that. Only `keepsUnavailablePick` moves in
    // this catalog push.
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, newTarget("linux", 2));
    });
    const staged = {
      harnessId: "codex",
      model: "gpt-6-astra",
      reasoningEffort: "low",
    };
    await waitFor(() => expect(chip(store.getState())).toEqual(staged));
    expect(sent(store.getState())).toEqual(staged);
    const selection = store.getState().selection;

    // The shape sheet's Use: Windows, a bigger size. The model stays put.
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, newTarget("windows", 4));
    });
    expect(store.getState().selection).toBe(selection);
    expect(chip(store.getState())).toEqual(staged);
    expect(sent(store.getState())).toEqual(staged);
    // Nothing was written over the person's pick.
    expect(store.getState().values.selection).toEqual({
      harnessId: "codex",
      modelSlug: "gpt-6-astra",
      profileId: null,
    });

    // Another host picked: the stage is dropped and this host decides again.
    act(() => {
      useStagedSandboxStore.getState().clear(SURFACE);
    });
    await waitFor(() =>
      expect(chip(store.getState()).harnessId).toBe("claude"),
    );
  });
});
