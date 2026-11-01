/**
 * A chip names the model it holds by the name a list gave it, and no list is
 * needed to keep it: the name is remembered, on this device, across a reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { ComposerToolbarCatalogScope } from "@/components/home/hooks/use-composer-toolbar-store";

const SLUG = "traycer:claude-sonnet-5-5";
const NAME = "Claude Sonnet 5.5";

interface ListedModel {
  readonly harnessId: string;
  readonly slug: string;
  readonly label: string;
  readonly description: null;
  readonly isDefault: boolean;
  readonly contextWindow: null;
  readonly maxOutputTokens: null;
  readonly defaultReasoningEffort: null;
  readonly supportedReasoningEfforts: readonly [];
  readonly defaultServiceTier: null;
  readonly supportedServiceTiers: readonly [];
  readonly metadata: Record<string, never>;
}

const lists = vi.hoisted(() => ({
  models: undefined as { models: unknown[] } | undefined,
}));

vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({ data: undefined }),
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({
    data: { harnesses: [{ id: "traycer", available: true }] },
  }),
  useGuiHarnessModelsQueryForClient: () => ({ data: lists.models }),
}));
vi.mock("@/hooks/command-palette/use-register-composer-controls", () => ({
  useRegisterFocusedComposerControls: () => undefined,
}));
vi.mock("@/hooks/providers/use-resolved-seeded-profile-id", () => ({
  useResolvedSeededProfileId: (_harnessId: string, profileId: string | null) =>
    profileId,
}));

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { HostClient as HostClientClass } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { chipModelName } from "@/stores/composer/composer-toolbar-store";
import {
  COMPOSER_HARNESS_MEMORY_CAP,
  rememberedModelName,
  useComposerHarnessMemoryStore,
} from "@/stores/composer/composer-harness-memory-store";
import { composerHarnessMemoryKey } from "@/lib/persist";
import { useSettingsStore } from "@/stores/settings/settings-store";

const HOST_ID = "host-a";
const STORAGE_KEY = composerHarnessMemoryKey(null);

function listed(slug: string, label: string): ListedModel {
  return {
    harnessId: "traycer",
    slug,
    label,
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

function hostClient(): HostClient<HostRpcRegistry> {
  const entry = {
    hostId: HOST_ID,
    label: HOST_ID,
    kind: "local" as const,
    websocketUrl: `ws://127.0.0.1:0/${HOST_ID}`,
    version: "0.0.0-mock",
    transportDialability: "dialable" as const,
  };
  const spine = new HostClientClass<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (id) => (id === entry.hostId ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req",
      handlers: {},
    }),
  });
  return spine.createRequester(entry);
}

const CLIENT = hostClient();

function scope(): ComposerToolbarCatalogScope {
  return {
    hostClient: CLIENT,
    hostId: HOST_ID,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    ultracodeCarried: false,
    stagedSurfaceKey: null,
    restingSandbox: null,
  };
}

function mountChip() {
  return renderHook(() =>
    useComposerToolbarStore(null, { kind: "none" }, null, scope()),
  );
}

function resetStores(): void {
  window.localStorage.clear();
  useComposerHarnessMemoryStore.persist.setOptions({ name: STORAGE_KEY });
  useComposerHarnessMemoryStore.getState().resetForTests();
  useSettingsStore.setState({
    defaultSelection: {
      harnessId: "traycer",
      modelSlug: SLUG,
      profileId: null,
    },
  });
}

beforeEach(() => {
  lists.models = undefined;
  resetStores();
});

afterEach(() => {
  cleanup();
  resetStores();
});

describe("the name a chip keeps for its model", () => {
  it("is remembered once a list names the model", async () => {
    lists.models = { models: [listed(SLUG, NAME)] };

    const view = mountChip();

    await waitFor(() =>
      expect(chipModelName(view.result.current.getState())).toBe(NAME),
    );
    expect(rememberedModelName("traycer", SLUG)).toBe(NAME);
  });

  it("is the remembered name after a reload with no list", async () => {
    useComposerHarnessMemoryStore
      .getState()
      .recordModelName("traycer", SLUG, NAME);
    // The reload: memory starts empty and reads its persisted blob back.
    const persisted = window.localStorage.getItem(STORAGE_KEY);
    if (persisted === null) throw new Error("nothing was persisted");
    useComposerHarnessMemoryStore.setState({ modelNames: {} });
    expect(rememberedModelName("traycer", SLUG)).toBeNull();
    window.localStorage.setItem(STORAGE_KEY, persisted);
    await act(() => useComposerHarnessMemoryStore.persist.rehydrate());

    const view = mountChip();

    await waitFor(() =>
      expect(view.result.current.getState().selection.modelSlug).toBe(SLUG),
    );
    expect(view.result.current.getState().selectedModel).toBeNull();
    expect(chipModelName(view.result.current.getState())).toBe(NAME);
  });

  it("is a generic name, never the slug, when no list ever named the model", async () => {
    const view = mountChip();

    await waitFor(() =>
      expect(view.result.current.getState().selection.modelSlug).toBe(SLUG),
    );
    expect(chipModelName(view.result.current.getState())).toBe("Traycer model");
  });
});

describe("modelNames in the harness memory", () => {
  it("is written to the persisted blob", () => {
    useComposerHarnessMemoryStore
      .getState()
      .recordModelName("traycer", SLUG, NAME);

    const blob: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "null",
    );

    expect(blob).toMatchObject({
      state: { modelNames: { [`traycer ${SLUG}`]: { name: NAME } } },
    });
  });

  it("is capped, dropping the name least recently recorded", () => {
    vi.useFakeTimers();
    for (let index = 0; index < COMPOSER_HARNESS_MEMORY_CAP + 1; index += 1) {
      vi.setSystemTime(1_000 + index);
      useComposerHarnessMemoryStore
        .getState()
        .recordModelName("traycer", `slug-${index}`, `Name ${index}`);
    }
    vi.useRealTimers();

    const { modelNames } = useComposerHarnessMemoryStore.getState();

    expect(Object.keys(modelNames)).toHaveLength(COMPOSER_HARNESS_MEMORY_CAP);
    expect(rememberedModelName("traycer", "slug-0")).toBeNull();
    expect(
      rememberedModelName("traycer", `slug-${COMPOSER_HARNESS_MEMORY_CAP}`),
    ).toBe(`Name ${COMPOSER_HARNESS_MEMORY_CAP}`);
  });
});
