/**
 * The command palette commits the composer's harness and model through the
 * controls `useComposerToolbarStore` registers. Those controls are held to the
 * same team-sandbox rule as the picker: a blocked harness is a no-op, an
 * unblocked one commits. The gate is mocked as a per-test predicate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRpcRegistry } from "@/lib/host";
import type { ComposerControls } from "@/lib/commands/composer-controls-registry";
import type { FocusedComposerKind } from "@/lib/commands/types";

interface CapturedRegistration {
  controls: ComposerControls | null;
}
const captured: CapturedRegistration = vi.hoisted(() => ({ controls: null }));

const gateState = vi.hoisted(() => ({
  blockedIds: new Set<string>(),
}));

// The cloud's Traycer catalog, read only for a Traycer pick sent to a sandbox.
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({ data: undefined }),
}));

vi.mock("@/hooks/sandboxes/use-team-sandbox-harness-blocked", () => {
  const isBlocked = (harnessId: string): boolean =>
    gateState.blockedIds.has(harnessId);
  return {
    useTeamSandboxHarnessGate: () => isBlocked,
    useTeamSandboxHarnessBlocked: (input: {
      readonly harnessId: string | null;
    }): boolean => input.harnessId !== null && isBlocked(input.harnessId),
  };
});

vi.mock("@/hooks/command-palette/use-register-composer-controls", () => ({
  useRegisterFocusedComposerControls: (
    kind: FocusedComposerKind | null,
    controls: ComposerControls,
  ) => {
    if (kind !== null) captured.controls = controls;
  },
}));

vi.mock("@/hooks/providers/use-resolved-seeded-profile-id", () => ({
  useResolvedSeededProfileId: (_harnessId: string, profileId: string | null) =>
    profileId,
}));

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
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({
    data: {
      harnesses: [
        { id: "claude", available: true },
        { id: "codex", available: true },
        { id: "opencode", available: true },
      ],
    },
  }),
  useGuiHarnessModelsQueryForClient: (_client: unknown, harnessId: string) => ({
    data: { models: [modelOption(harnessId, `${harnessId}-m`)] },
  }),
}));

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

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

const TEST_HOST_CLIENT = buildTestHostClient("host-a");

function renderToolbarStore() {
  return renderHook(() =>
    useComposerToolbarStore("landing", { kind: "none" }, null, {
      hostClient: TEST_HOST_CLIENT,
      hostId: "host-a",
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      ultracodeCarried: false,
      stagedSurfaceKey: null,
      restingSandbox: null,
    }),
  );
}

function latestControls(): ComposerControls {
  const controls = captured.controls;
  if (controls === null) throw new Error("no composer controls registered");
  return controls;
}

describe("palette controls registered by useComposerToolbarStore on a team sandbox", () => {
  beforeEach(() => {
    captured.controls = null;
    gateState.blockedIds.clear();
    useSettingsStore.setState({
      defaultServiceTier: "",
      defaultSelection: {
        harnessId: "codex",
        modelSlug: "codex-m",
        profileId: null,
      },
    });
    useComposerHarnessMemoryStore.getState().resetForTests();
    resetNegotiatedManifests();
  });

  afterEach(() => {
    cleanup();
    gateState.blockedIds.clear();
  });

  it("switchHarness commits an unblocked harness (control)", async () => {
    gateState.blockedIds.add("claude");
    const { result } = renderToolbarStore();
    await waitFor(() =>
      expect(result.current.getState().selection.harnessId).toBe("codex"),
    );

    act(() => {
      latestControls().switchHarness("opencode");
    });

    await waitFor(() =>
      expect(result.current.getState().selection.harnessId).toBe("opencode"),
    );
  });

  it("switchHarness leaves the selection unchanged for a blocked harness", async () => {
    gateState.blockedIds.add("claude");
    const { result } = renderToolbarStore();
    await waitFor(() =>
      expect(result.current.getState().selection.harnessId).toBe("codex"),
    );
    const before = result.current.getState().selection;

    act(() => {
      latestControls().switchHarness("claude");
    });

    expect(result.current.getState().selection).toEqual(before);
  });

  it("selectModel commits a model of an unblocked harness (control)", async () => {
    gateState.blockedIds.add("claude");
    const { result } = renderToolbarStore();
    await waitFor(() =>
      expect(result.current.getState().selection.harnessId).toBe("codex"),
    );

    act(() => {
      latestControls().selectModel("opencode", "opencode-m");
    });

    await waitFor(() =>
      expect(result.current.getState().selection).toEqual({
        harnessId: "opencode",
        modelSlug: "opencode-m",
        profileId: null,
      }),
    );
  });

  it("selectModel leaves the selection unchanged for a model of a blocked harness", async () => {
    gateState.blockedIds.add("claude");
    const { result } = renderToolbarStore();
    await waitFor(() =>
      expect(result.current.getState().selection.harnessId).toBe("codex"),
    );
    const before = result.current.getState().selection;

    act(() => {
      latestControls().selectModel("claude", "claude-m");
    });

    expect(result.current.getState().selection).toEqual(before);
  });
});
