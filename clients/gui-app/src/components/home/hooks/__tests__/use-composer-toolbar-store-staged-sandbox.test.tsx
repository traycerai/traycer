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
    ],
  });
  return {
    available,
    harnesses: available(true, false),
    offeredAgents: undefined as ReadonlyArray<string> | undefined,
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

// The cloud's Traycer catalog, read only for a Traycer pick sent to a sandbox.
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({ data: undefined }),
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({ data: host.harnesses }),
  useGuiHarnessModelsQueryForClient: (
    _client: HostClient<HostRpcRegistry> | null,
    harnessId: string,
  ) => ({ data: harnessId === "claude" ? CLAUDE_MODELS : CODEX_MODELS }),
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
import {
  landingComposerSettingsSeedForDraft,
  landingMintedDraftSettings,
} from "@/components/home/composer/landing-composer-settings-seed";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useStagedSendSignInCheck } from "@/hooks/sandboxes/use-staged-send-sign-in-check";
import { pickedRunSettings } from "@/lib/sandboxes/pending-sandbox-send";
import type { ComposerToolbarStoreState } from "@/stores/composer/composer-toolbar-store";
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
) {
  return renderHook(() =>
    useComposerToolbarStore(
      "landing",
      fallbackSeedSource(PICK, HOST_CLIENT),
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
  useComposerHarnessMemoryStore.getState().resetForTests();
  useComposerRunSettingsStore.getState().resetForTests();
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
    const { result } = renderLandingToolbar(onSettingsChange);
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
    const { result } = renderLandingToolbar(null);
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
    const { result, rerender } = renderLandingToolbar(null);
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
    const { result } = renderLandingToolbar(null);
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
});

describe("a landing draft with a sandbox staged, then reloaded", () => {
  /** What `LandingComposer` wires: the emit writes the host's last-run settings and the draft, the kept pick only the draft. */
  function renderDraftToolbar(draftId: string | null) {
    const draftSettings = () =>
      useLandingDraftStore.getState().drafts.find((d) => d.id === draftId)
        ?.settings ?? null;
    const lastRun = () =>
      useComposerRunSettingsStore.getState().getGlobalRunSettings(HOST_ID);
    const hook = renderHook(() =>
      useComposerToolbarStore(
        "landing",
        fallbackSeedSource(
          landingComposerSettingsSeedForDraft(
            draftId,
            draftSettings(),
            lastRun(),
          ),
          HOST_CLIENT,
        ),
        (settings) => {
          useComposerRunSettingsStore
            .getState()
            .setGlobalRunSettings(HOST_ID, settings, Date.now());
          if (draftId !== null)
            useLandingDraftStore.getState().setDraftSettings(draftId, settings);
        },
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
    // Installed only while a draft exists, as `LandingComposer` does.
    if (draftId !== null)
      hook.result.current.setState({
        onShownPickKept: (settings) =>
          useLandingDraftStore.getState().setDraftSettings(draftId, settings),
      });
    return { ...hook, draftSettings };
  }

  it("still shows the adopted pick after the reload, and the host's last-run settings never moved", async () => {
    const draftId = useLandingDraftStore.getState().createDraft(PICK);
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(HOST_ID, PICK, 1);
    const lastRun = useComposerRunSettingsStore
      .getState()
      .getGlobalRunSettings(HOST_ID);

    const first = renderDraftToolbar(draftId);
    await waitFor(() =>
      expect(chip(first.result.current.getState())).toEqual(CLAUDE_SHOWN),
    );
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, newTarget("linux", 2));
    });
    await waitFor(() =>
      expect(first.draftSettings()?.harnessId).toBe("claude"),
    );
    expect(
      useComposerRunSettingsStore.getState().getGlobalRunSettings(HOST_ID),
    ).toBe(lastRun);

    // The reload: a fresh composer on the same draft, the stage still up.
    first.unmount();
    const reloaded = renderDraftToolbar(draftId);
    await waitFor(() =>
      expect(
        reloaded.result.current.getState().catalog.keepsUnavailablePick,
      ).toBe(true),
    );
    expect(chip(reloaded.result.current.getState())).toEqual(CLAUDE_SHOWN);
    expect(sent(reloaded.result.current.getState())).toEqual(CLAUDE_SHOWN);
  });

  it("a draft minted under a stage holds the kept pick, not the host's last-run pick", async () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(HOST_ID, PICK, 1);
    const lastRun = useComposerRunSettingsStore
      .getState()
      .getGlobalRunSettings(HOST_ID);

    // A fresh Start Page: no draft yet, so the kept pick has nowhere to land.
    const first = renderDraftToolbar(null);
    const toolbar = first.result.current;
    await waitFor(() => expect(chip(toolbar.getState())).toEqual(CLAUDE_SHOWN));
    // No stage: the mint starts from the host's last run, untouched.
    expect(landingMintedDraftSettings(toolbar.getState(), lastRun)).toBe(
      lastRun,
    );
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, newTarget("linux", 2));
    });
    await waitFor(() =>
      expect(toolbar.getState().values.selection.harnessId).toBe("claude"),
    );

    // The first keystroke mints the draft, as `ensureBoundDraftId` does.
    const draftId = "minted-draft";
    useLandingDraftStore
      .getState()
      .createDraftWithId(
        draftId,
        landingMintedDraftSettings(toolbar.getState(), lastRun),
      );
    const minted = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === draftId)?.settings;
    expect(minted?.harnessId).toBe("claude");
    expect(minted?.model).toBe("sonnet-5.5");
    expect(
      useComposerRunSettingsStore.getState().getGlobalRunSettings(HOST_ID),
    ).toBe(lastRun);

    // The reload: a fresh composer on that draft, the stage still up.
    first.unmount();
    const reloaded = renderDraftToolbar(draftId);
    await waitFor(() =>
      expect(
        reloaded.result.current.getState().catalog.keepsUnavailablePick,
      ).toBe(true),
    );
    expect(chip(reloaded.result.current.getState())).toEqual(CLAUDE_SHOWN);
    expect(sent(reloaded.result.current.getState())).toEqual(CLAUDE_SHOWN);
  });
});
