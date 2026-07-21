import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";

const harnessesData: {
  value:
    | {
        harnesses: ReadonlyArray<{
          id: string;
          available: boolean;
          modes?: ReadonlyArray<string>;
          supportedPermissionModes?: ReadonlyArray<string>;
        }>;
      }
    | undefined;
} = { value: undefined };
const modelsData: {
  // `undefined` models the models query still LOADING (no data yet); a `models`
  // object models it RESOLVED. The store now distinguishes the two via the
  // explicit `modelsLoaded` status, so tests drive the loading window by leaving
  // this undefined and the loaded window by assigning a `{ models }` object.
  value:
    | {
        models: ReadonlyArray<{
          harnessId: string;
          slug: string;
          label: string;
          description: null;
          isDefault: boolean;
          contextWindow: null;
          maxOutputTokens: null;
          defaultReasoningEffort: string | null;
          supportedReasoningEfforts: ReadonlyArray<{
            id: string;
            label: string;
            description: null;
          }>;
          defaultServiceTier: string | null;
          supportedServiceTiers: ReadonlyArray<{
            id: string;
            label: string;
            description: null;
          }>;
          metadata: Record<string, unknown>;
        }>;
      }
    | undefined;
} = { value: undefined };
const harnessQueryCalls: Array<{
  readonly enabled: boolean;
  readonly subscribed: boolean;
}> = [];
const modelQueryCalls: Array<{
  readonly harnessId: string;
  readonly workingDirectory: string | null;
  readonly enabled: boolean;
  readonly subscribed: boolean;
}> = [];
const registeredComposerKinds: Array<FocusedComposerKind | null> = [];

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: (activity: {
    enabled: boolean;
    subscribed: boolean;
  }) => {
    harnessQueryCalls.push({
      enabled: activity.enabled,
      subscribed: activity.subscribed,
    });
    return { data: activity.enabled ? harnessesData.value : undefined };
  },
  useGuiHarnessModelsQuery: (
    harnessId: string,
    workingDirectory: string | null,
    activity: { enabled: boolean; subscribed: boolean },
  ) => {
    modelQueryCalls.push({
      harnessId,
      workingDirectory,
      enabled: activity.enabled,
      subscribed: activity.subscribed,
    });
    return { data: activity.enabled ? modelsData.value : undefined };
  },
}));

vi.mock("@/hooks/command-palette/use-register-composer-controls", () => ({
  useRegisterFocusedComposerControls: (kind: FocusedComposerKind | null) => {
    registeredComposerKinds.push(kind);
  },
}));

// None of this file's cases exercise the seeded-profile host-liveness check
// (that's `profile-durability-*` coverage) - a plain pass-through here mirrors
// exactly what the real hook does for `client: null` (every test below passes
// `null`): hold the profileId verbatim, no `providers.list` query attempted.
vi.mock("@/hooks/providers/use-resolved-seeded-profile-id", () => ({
  useResolvedSeededProfileId: (_harnessId: string, profileId: string | null) =>
    profileId,
}));

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import type { FocusedComposerKind } from "@/lib/commands/types";

function seedDefault(
  harnessId: "claude" | "codex" | "opencode" | "traycer" | "cursor",
): void {
  useSettingsStore.setState({
    defaultSelection: { harnessId, modelSlug: "saved-model", profileId: null },
  });
}

function inactiveWrapper(props: { children: ReactNode }) {
  return (
    <SurfaceActivityProvider active={false}>
      {props.children}
    </SurfaceActivityProvider>
  );
}

describe("useComposerToolbarStore selection reconciliation", () => {
  beforeEach(() => {
    harnessesData.value = undefined;
    // Default to the LOADING window (no model data yet); tests that need a
    // resolved catalog assign `modelsData.value = { models: [...] }` explicitly.
    modelsData.value = undefined;
    harnessQueryCalls.length = 0;
    modelQueryCalls.length = 0;
    registeredComposerKinds.length = 0;
    // Reset the sticky tier default so a tier-normalization test can't leak its
    // preference into a later test's seeded values.
    useSettingsStore.setState({ defaultServiceTier: "" });
    // The harness-memory store is a module singleton written by the recording
    // wrapper; reset so write assertions don't leak between tests.
    useComposerHarnessMemoryStore.getState().resetForTests();
  });

  // Unmount each test's hook so a later `useSettingsStore.setState` can't
  // re-render a lingering store against the next test's mock catalog.
  afterEach(() => {
    cleanup();
  });

  it("falls back by provider order when the default is unavailable", async () => {
    seedDefault("opencode");
    harnessesData.value = {
      harnesses: [
        { id: "claude", available: true },
        { id: "codex", available: true },
        { id: "opencode", available: false },
      ],
    };

    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, null, false),
    );

    await waitFor(() =>
      expect(result.current.getState().selection).toEqual({
        harnessId: "codex",
        modelSlug: "",
        profileId: null,
      }),
    );
  });

  it("leaves an available default selection untouched", async () => {
    seedDefault("claude");
    harnessesData.value = {
      harnesses: [
        { id: "codex", available: true },
        { id: "claude", available: true },
        { id: "opencode", available: false },
      ],
    };

    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, null, false),
    );

    // Give the catalog-sync effect a chance to (not) reroute.
    await Promise.resolve();
    expect(result.current.getState().selection).toEqual({
      harnessId: "claude",
      modelSlug: "saved-model",
      profileId: null,
    });
  });

  it("does nothing while the harness list is still loading", async () => {
    seedDefault("opencode");
    harnessesData.value = undefined;

    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, null, false),
    );

    await Promise.resolve();
    expect(result.current.getState().selection.harnessId).toBe("opencode");
  });

  it("reroutes a GUI-only selection off the terminal surface", async () => {
    // `traycer` is selectable in chat but can't back a terminal agent. On the
    // terminal surface (`tuiOnly`) it must reroute to the first available
    // TUI-capable harness in provider order instead of being carried forward
    // un-launchable.
    seedDefault("traycer");
    harnessesData.value = {
      harnesses: [
        { id: "traycer", available: true, modes: ["gui"] },
        { id: "claude", available: true, modes: ["gui", "tui"] },
        { id: "codex", available: true, modes: ["gui", "tui"] },
      ],
    };

    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, null, true),
    );

    await waitFor(() =>
      expect(result.current.getState().selection.harnessId).toBe("codex"),
    );
    // Raw sticky value is untouched, so switching back to chat re-presents it.
    expect(result.current.getState().values.selection.harnessId).toBe(
      "traycer",
    );
  });

  it("keeps a TUI-capable selection on the terminal surface", async () => {
    seedDefault("claude");
    harnessesData.value = {
      harnesses: [
        { id: "codex", available: true, modes: ["gui", "tui"] },
        { id: "claude", available: true, modes: ["gui", "tui"] },
      ],
    };

    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, null, true),
    );

    await Promise.resolve();
    expect(result.current.getState().selection).toEqual({
      harnessId: "claude",
      modelSlug: "saved-model",
      profileId: null,
    });
  });

  it("never persists the rerouted harness when editing on the terminal surface", async () => {
    // GUI-only `traycer` is rerouted to `codex` on the terminal surface. The
    // reroute is display/launch-only: an edit there must NOT emit (and thus
    // persist) `codex`, or switching back to chat would lose the sticky
    // `traycer`. The edit is held until the derived harness matches the raw one.
    seedDefault("traycer");
    harnessesData.value = {
      harnesses: [
        { id: "traycer", available: true, modes: ["gui"] },
        { id: "codex", available: true, modes: ["gui", "tui"] },
      ],
    };
    modelsData.value = {
      models: [
        {
          harnessId: "codex",
          slug: "codex-default",
          label: "Codex Default",
          description: null,
          isDefault: true,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [
            { id: "high", label: "High", description: null },
          ],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    };
    const onSettingsChange = vi.fn();
    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, onSettingsChange, true),
    );

    // Reroute settles on a TUI-capable harness with a concrete model slug, so a
    // later emit can only be blocked by the reroute guard (not an empty slug).
    await waitFor(() => {
      const selection = result.current.getState().selection;
      expect(selection.harnessId).toBe("codex");
      expect(selection.modelSlug).toBe("codex-default");
    });

    act(() => {
      result.current.getState().setReasoning("high");
    });

    expect(onSettingsChange).not.toHaveBeenCalled();
    // The raw sticky harness is untouched, so flipping back to chat re-presents it.
    expect(result.current.getState().values.selection.harnessId).toBe(
      "traycer",
    );
  });

  it("notifies settings changes from action setters, never from catalog sync", () => {
    seedDefault("claude");
    const onSettingsChange = vi.fn();
    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, onSettingsChange, false),
    );

    act(() => {
      result.current.getState().setReasoning("high");
    });

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: "high" }),
    );
  });

  it("defers settings changes until the model resolves", async () => {
    seedDefault("claude");
    useSettingsStore.setState({
      defaultSelection: { harnessId: "claude", modelSlug: "", profileId: null },
    });
    const onSettingsChange = vi.fn();
    const { result, rerender } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, onSettingsChange, false),
    );

    act(() => {
      result.current.getState().setReasoning("high");
    });

    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(result.current.getState().pendingSettingsEmit).toBe(true);

    modelsData.value = {
      models: [
        {
          harnessId: "claude",
          slug: "resolved-haiku",
          label: "Resolved Haiku",
          description: null,
          isDefault: true,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [
            { id: "high", label: "High", description: null },
          ],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    };
    rerender();

    await waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "resolved-haiku",
          reasoningEffort: "high",
        }),
      ),
    );
    expect(result.current.getState().pendingSettingsEmit).toBe(false);
  });

  it("clamps the permission to one the selected harness honors", async () => {
    // A chat seeded straight onto Cursor (advertises only `full_access`) keeps
    // the default `supervised` sticky - raw values are never clamped. The
    // derived `permission` must surface the harness-honored mode so the picker
    // label and the sent settings agree, instead of sending `supervised` and
    // being rejected.
    useSettingsStore.setState({
      defaultSelection: {
        harnessId: "cursor",
        modelSlug: "composer",
        profileId: null,
      },
      defaultPermission: "supervised",
    });
    harnessesData.value = {
      harnesses: [
        {
          id: "cursor",
          available: true,
          supportedPermissionModes: ["full_access"],
        },
      ],
    };

    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, null, false),
    );

    await waitFor(() =>
      expect(result.current.getState().permission).toBe("full_access"),
    );
    // The raw sticky preference survives for a later harness that honors it.
    expect(result.current.getState().values.permission).toBe("supervised");
  });

  it("emits the normalized reasoning for the selected model", () => {
    seedDefault("codex");
    useSettingsStore.setState({ defaultReasoning: "high" });
    modelsData.value = {
      models: [
        {
          harnessId: "codex",
          slug: "low-only",
          label: "Low Only",
          description: null,
          isDefault: false,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [
            { id: "low", label: "Low", description: null },
          ],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    };
    const onSettingsChange = vi.fn();
    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, onSettingsChange, false),
    );

    act(() => {
      result.current.getState().setSelection({
        harnessId: "codex",
        modelSlug: "low-only",
        profileId: null,
      });
    });

    expect(result.current.getState().reasoning).toBe("low");
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "low-only",
        reasoningEffort: "low",
      }),
    );
  });

  it("drops a carried service tier the selected model does not advertise", () => {
    seedDefault("codex");
    // Sticky "priority" (Codex Fast), as if carried from a prior GPT turn.
    useSettingsStore.setState({ defaultServiceTier: "priority" });
    modelsData.value = {
      models: [
        {
          harnessId: "codex",
          slug: "fast-only",
          label: "Fast Only",
          description: null,
          isDefault: false,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
          // Only advertises "fast" (like Claude) - never "priority".
          defaultServiceTier: null,
          supportedServiceTiers: [
            { id: "fast", label: "Fast", description: null },
          ],
          metadata: {},
        },
      ],
    };
    const onSettingsChange = vi.fn();
    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, onSettingsChange, false),
    );

    act(() => {
      result.current.getState().setSelection({
        harnessId: "codex",
        modelSlug: "fast-only",
        profileId: null,
      });
    });

    // Display + emit drop the unsupported tier (picker shows fast off)...
    expect(result.current.getState().serviceTier).toBe("");
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ model: "fast-only", serviceTier: null }),
    );
    // ...but the raw preference survives for a later model that honors it.
    expect(result.current.getState().values.serviceTier).toBe("priority");
  });

  it("keeps a carried service tier the selected model advertises", () => {
    seedDefault("codex");
    useSettingsStore.setState({ defaultServiceTier: "priority" });
    modelsData.value = {
      models: [
        {
          harnessId: "codex",
          slug: "priority-capable",
          label: "Priority Capable",
          description: null,
          isDefault: false,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
          defaultServiceTier: null,
          supportedServiceTiers: [
            { id: "priority", label: "Fast", description: null },
          ],
          metadata: {},
        },
      ],
    };
    const onSettingsChange = vi.fn();
    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, onSettingsChange, false),
    );

    act(() => {
      result.current.getState().setSelection({
        harnessId: "codex",
        modelSlug: "priority-capable",
        profileId: null,
      });
    });

    expect(result.current.getState().serviceTier).toBe("priority");
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "priority-capable",
        serviceTier: "priority",
      }),
    );
  });

  it("emits agent-mode changes without mutating settings defaults", () => {
    seedDefault("codex");
    useSettingsStore.setState({ defaultAgentMode: "regular" });
    const onSettingsChange = vi.fn();
    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, onSettingsChange, false),
    );

    act(() => {
      result.current.getState().setAgentMode("epic");
    });

    expect(useSettingsStore.getState().defaultAgentMode).toBe("regular");
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ agentMode: "epic" }),
    );
  });

  it("commits a (harness,model) selection in a single emit", async () => {
    // The combined action must patch selection + reasoning + tier in one
    // `update()`, so a commit emits exactly once - never the multiple emits a
    // sequenced setSelection/setReasoning/setServiceTier would produce.
    useSettingsStore.setState({
      defaultSelection: {
        harnessId: "codex",
        modelSlug: "multi",
        profileId: null,
      },
    });
    harnessesData.value = {
      harnesses: [{ id: "codex", available: true }],
    };
    modelsData.value = {
      models: [
        {
          harnessId: "codex",
          slug: "multi",
          label: "Multi",
          description: null,
          isDefault: true,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { id: "low", label: "Low", description: null },
            { id: "medium", label: "Medium", description: null },
            { id: "high", label: "High", description: null },
          ],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    };
    const onSettingsChange = vi.fn();
    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, onSettingsChange, false),
    );

    // Let the catalog load so the commit resolves a concrete slug and emits
    // (rather than deferring). The mount itself never emits.
    await waitFor(() =>
      expect(result.current.getState().catalog.models.length).toBe(1),
    );
    expect(onSettingsChange).not.toHaveBeenCalled();

    act(() => {
      result.current.getState().applyComposerSelection({
        selection: { harnessId: "codex", modelSlug: "multi", profileId: null },
        reasoning: "high",
        serviceTier: "",
      });
    });

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ model: "multi", reasoningEffort: "high" }),
    );
  });

  it("fires HarnessChanged once on a harness switch, not on a same-harness model change", () => {
    seedDefault("codex");
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, null, false),
    );
    // The mount path (catalog sync / seed) never tracks; start from a clean count.
    trackSpy.mockClear();

    act(() => {
      result.current.getState().applyComposerSelection({
        selection: {
          harnessId: "claude",
          modelSlug: "some-model",
          profileId: null,
        },
        reasoning: "",
        serviceTier: "",
      });
    });

    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.HarnessChanged, {
      from: "codex",
      to: "claude",
    });

    // Same harness, different model: no harness-change analytics.
    act(() => {
      result.current.getState().applyComposerSelection({
        selection: {
          harnessId: "claude",
          modelSlug: "another-model",
          profileId: null,
        },
        reasoning: "",
        serviceTier: "",
      });
    });

    expect(trackSpy).toHaveBeenCalledTimes(1);
    trackSpy.mockRestore();
  });

  it("drops sticky effort and tier to the model's defaults via the no-carry levers", async () => {
    // A commit through the combined action sets effort/tier from the SUPPLIED
    // values, so passing "" resolves to the selected model's own default
    // (effort) and drops the tier - even when the model would support the
    // sticky values. This is the per-(harness,model) "no carry" behavior.
    useSettingsStore.setState({
      defaultSelection: {
        harnessId: "codex",
        modelSlug: "multi",
        profileId: null,
      },
      defaultReasoning: "high",
      defaultServiceTier: "priority",
    });
    harnessesData.value = {
      harnesses: [{ id: "codex", available: true }],
    };
    modelsData.value = {
      models: [
        {
          harnessId: "codex",
          slug: "multi",
          label: "Multi",
          description: null,
          isDefault: true,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { id: "low", label: "Low", description: null },
            { id: "medium", label: "Medium", description: null },
            { id: "high", label: "High", description: null },
          ],
          defaultServiceTier: null,
          supportedServiceTiers: [
            { id: "priority", label: "Fast", description: null },
          ],
          metadata: {},
        },
      ],
    };
    const onSettingsChange = vi.fn();
    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, onSettingsChange, false),
    );

    // The model supports both sticky values, so they carry before the commit.
    await waitFor(() =>
      expect(result.current.getState().selectedModel?.slug).toBe("multi"),
    );
    expect(result.current.getState().reasoning).toBe("high");
    expect(result.current.getState().serviceTier).toBe("priority");

    act(() => {
      result.current.getState().applyComposerSelection({
        selection: { harnessId: "codex", modelSlug: "multi", profileId: null },
        reasoning: "",
        serviceTier: "",
      });
    });

    // The supplied "" wins: effort falls to the model default, tier drops.
    expect(result.current.getState().reasoning).toBe("medium");
    expect(result.current.getState().serviceTier).toBe("");
    expect(onSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: "multi",
        reasoningEffort: "medium",
        serviceTier: null,
      }),
    );
  });

  it("resolves a stale/delisted remembered slug to the first model and emits the resolved slug", async () => {
    // A remembered slug comes from memory, not a loaded list, so it can be
    // delisted. Once THIS harness's catalog loads WITHOUT it, the derive falls
    // back to the first model + its default effort, and the RESOLVED slug - not
    // the dead one - is what emits (so the memory write self-heals next time).
    useSettingsStore.setState({
      defaultSelection: {
        harnessId: "codex",
        modelSlug: "delisted-old",
        profileId: null,
      },
      // No sticky effort, so the resolved first model surfaces its OWN default.
      defaultReasoning: "",
    });
    harnessesData.value = {
      harnesses: [{ id: "codex", available: true }],
    };
    modelsData.value = {
      models: [
        {
          harnessId: "codex",
          slug: "survivor",
          label: "Survivor",
          description: null,
          isDefault: true,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { id: "low", label: "Low", description: null },
            { id: "medium", label: "Medium", description: null },
            { id: "high", label: "High", description: null },
          ],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    };
    const onSettingsChange = vi.fn();
    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, onSettingsChange, false),
    );

    // The dead slug resolves to the first live model for display, with that
    // model's own default effort - never the stale slug.
    await waitFor(() =>
      expect(result.current.getState().selection.modelSlug).toBe("survivor"),
    );
    expect(result.current.getState().reasoning).toBe("medium");
    expect(result.current.getState().selectionCatalogConfirmed).toBe(true);

    // A commit that still carries the dead remembered slug (as Ticket 4's entry
    // points will, reading it from memory) emits the RESOLVED slug, not the
    // dead one.
    act(() => {
      result.current.getState().applyComposerSelection({
        selection: {
          harnessId: "codex",
          modelSlug: "delisted-old",
          profileId: null,
        },
        reasoning: "",
        serviceTier: "",
      });
    });

    expect(onSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "survivor", reasoningEffort: "medium" }),
    );
  });

  it("emits immediately for a non-empty unvalidated slug but reports it not catalog-confirmed until validated", async () => {
    // Under the "gate only the write" decision the surface emit is NOT held: a
    // held non-empty remembered slug still propagates to live-settings the moment
    // it is edited. The `selectionCatalogConfirmed` flag - which Ticket 4's record
    // wrapper gates the MEMORY write on - is what stays false until the catalog
    // validates the slug, so an unvalidated slug reaches live-settings but is
    // never recorded.
    useSettingsStore.setState({
      defaultSelection: {
        harnessId: "codex",
        modelSlug: "remembered",
        profileId: null,
      },
    });
    harnessesData.value = {
      harnesses: [{ id: "codex", available: true }],
    };
    // Models query still loading: data is undefined.
    modelsData.value = undefined;
    const onSettingsChange = vi.fn();
    const { result, rerender } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, onSettingsChange, false),
    );

    // Loading window: the remembered slug is held for display but unconfirmed.
    await waitFor(() =>
      expect(result.current.getState().selection.modelSlug).toBe("remembered"),
    );
    expect(result.current.getState().selectionCatalogConfirmed).toBe(false);

    act(() => {
      result.current.getState().setReasoning("high");
    });

    // The edit emits immediately, carrying the held slug...
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ model: "remembered", reasoningEffort: "high" }),
    );
    // ...but it is NOT catalog-confirmed yet, so the Ticket 4 write skips it.
    expect(result.current.getState().pendingSettingsEmit).toBe(false);

    // The catalog loads WITH the remembered slug -> confirmed flips true (no
    // spurious re-emit, since the resolved slug did not change).
    modelsData.value = {
      models: [
        {
          harnessId: "codex",
          slug: "remembered",
          label: "Remembered",
          description: null,
          isDefault: true,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [
            { id: "high", label: "High", description: null },
          ],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    };
    rerender();

    await waitFor(() =>
      expect(result.current.getState().selectionCatalogConfirmed).toBe(true),
    );
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
  });

  it("emits the resolved first-model slug when a delisted remembered slug self-heals on catalog load", async () => {
    // INV3: when a remembered slug is absent on load and resolves X -> Y, the
    // catalog load itself must propagate an emit carrying Y - so live-settings
    // updates AND Ticket 4 later records Y (not the dead slug). No user action is
    // required; the catalog resolution alone drives the emit.
    useSettingsStore.setState({
      defaultSelection: {
        harnessId: "codex",
        modelSlug: "delisted-old",
        profileId: null,
      },
      defaultReasoning: "",
    });
    harnessesData.value = {
      harnesses: [{ id: "codex", available: true }],
    };
    // Still loading: the dead slug is held, nothing emitted yet.
    modelsData.value = undefined;
    const onSettingsChange = vi.fn();
    const { result, rerender } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, onSettingsChange, false),
    );

    await waitFor(() =>
      expect(result.current.getState().selection.modelSlug).toBe(
        "delisted-old",
      ),
    );
    expect(onSettingsChange).not.toHaveBeenCalled();

    // The catalog loads WITHOUT the remembered slug -> resolves to the first
    // model AND emits it (the self-heal), carrying that model's own default
    // effort - never the dead slug.
    modelsData.value = {
      models: [
        {
          harnessId: "codex",
          slug: "survivor",
          label: "Survivor",
          description: null,
          isDefault: true,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { id: "low", label: "Low", description: null },
            { id: "medium", label: "Medium", description: null },
            { id: "high", label: "High", description: null },
          ],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    };
    rerender();

    await waitFor(() =>
      expect(onSettingsChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          model: "survivor",
          reasoningEffort: "medium",
        }),
      ),
    );
    expect(result.current.getState().selection.modelSlug).toBe("survivor");
    expect(result.current.getState().selectionCatalogConfirmed).toBe(true);
  });

  it("does not re-emit a stale slug when the catalog unloads after a delisting self-heal", async () => {
    // Regression (cold-review repro): a delisted slug self-heals X -> Y on load and
    // emits Y. If the surface later goes inactive / the query detaches
    // (`modelsLoaded:false`), the derive falls back to holding a raw slug - the
    // self-heal detector must NOT fire in that UNLOAD direction (it would emit the
    // dead slug). The catalog-confirmed gate on the detector prevents it; the raw
    // heal additionally aligns the sticky slug so there is no transition at all.
    useSettingsStore.setState({
      defaultSelection: {
        harnessId: "codex",
        modelSlug: "delisted-old",
        profileId: null,
      },
      defaultReasoning: "",
    });
    harnessesData.value = {
      harnesses: [{ id: "codex", available: true }],
    };
    modelsData.value = undefined;
    const onSettingsChange = vi.fn();
    const { result, rerender } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, onSettingsChange, false),
    );

    // Load WITHOUT the remembered slug -> self-heals to the first model, emits it.
    modelsData.value = {
      models: [
        {
          harnessId: "codex",
          slug: "survivor",
          label: "Survivor",
          description: null,
          isDefault: true,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    };
    rerender();
    await waitFor(() =>
      expect(onSettingsChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ model: "survivor" }),
      ),
    );
    // Raw heal: the sticky slug is now the resolved one, not the dead slug.
    expect(result.current.getState().values.selection.modelSlug).toBe(
      "survivor",
    );

    // The query now detaches / surface unloads: `modelsLoaded` flips false.
    onSettingsChange.mockClear();
    modelsData.value = undefined;
    rerender();
    await waitFor(() =>
      expect(result.current.getState().selectionCatalogConfirmed).toBe(false),
    );
    // The unload must NOT re-emit - neither the healed slug nor the dead one.
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("holds a valid remembered slug through the loading window without resetting it", async () => {
    // The inverse guard: while THIS harness's catalog is still loading, a valid
    // remembered slug must be HELD for display, not reset to the first model -
    // so the normal cross-harness loading window never blows away a good
    // selection. It is only reset once the catalog is actually loaded-without-it.
    useSettingsStore.setState({
      defaultSelection: {
        harnessId: "codex",
        modelSlug: "remembered",
        profileId: null,
      },
    });
    harnessesData.value = {
      harnesses: [{ id: "codex", available: true }],
    };
    modelsData.value = undefined;
    const { result, rerender } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, null, false),
    );

    await waitFor(() =>
      expect(result.current.getState().selection.harnessId).toBe("codex"),
    );
    // Held verbatim during loading - NOT reset to "" or a first model.
    expect(result.current.getState().selection.modelSlug).toBe("remembered");
    expect(result.current.getState().selectionCatalogConfirmed).toBe(false);

    // Once the catalog loads and contains it, it survives and is now confirmed.
    modelsData.value = {
      models: [
        {
          harnessId: "codex",
          slug: "remembered",
          label: "Remembered",
          description: null,
          isDefault: true,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    };
    rerender();

    await waitFor(() =>
      expect(result.current.getState().selectionCatalogConfirmed).toBe(true),
    );
    expect(result.current.getState().selection.modelSlug).toBe("remembered");
  });

  it("re-seeds the store when the settings seed identity changes", async () => {
    seedDefault("codex");
    const seeds: { current: ChatRunSettings | null } = { current: null };
    const { result, rerender } = renderHook(() =>
      useComposerToolbarStore(
        null,
        fallbackSeedSource(seeds.current, null),
        null,
        false,
      ),
    );
    expect(result.current.getState().selection.harnessId).toBe("codex");

    seeds.current = {
      harnessId: "claude",
      model: "haiku",
      permissionMode: "full_access",
      reasoningEffort: "low",
      serviceTier: null,
      agentMode: "epic",
      profileId: null,
    };
    rerender();

    await waitFor(() =>
      expect(result.current.getState().selection).toEqual({
        harnessId: "claude",
        modelSlug: "haiku",
        profileId: null,
      }),
    );
    expect(result.current.getState().agentMode).toBe("epic");
    expect(result.current.getState().permission).toBe("full_access");
  });

  it("ticket 07 round 2: converges the store's committed profileId when the resolved seed clears a stale pin, closing the fork-dialog transition window", () => {
    // Models a fork dialog's seed transitioning from a stale non-null
    // profileId (persisted seed) to null - exactly what
    // `resolveSeededProfileId` now produces once `providers.list` settles
    // empty (round 1's fix). The production fix uses `useLayoutEffect`
    // (not a passive `useEffect`) for the re-seed, since only a layout
    // effect is guaranteed by React to complete before the next paint - the
    // real-world window a submit-on-click could otherwise land in. NOTE:
    // this synchronous `rerender()` + immediate assertion (no `waitFor`)
    // does NOT distinguish `useLayoutEffect` from `useEffect` here -
    // Testing Library's `act()` flushes both effect types before
    // `rerender()` returns in this harness (verified empirically), so this
    // test is a regression guard on the OUTCOME (the store converges to the
    // resolved seed), not a proof of the specific scheduling mechanism; the
    // `useLayoutEffect` choice itself rests on React's documented layout-
    // effect/paint ordering guarantee, not on this test.
    const seeds: { current: ChatRunSettings } = {
      current: {
        harnessId: "claude",
        model: "opus",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: "work-uuid",
      },
    };
    const { result, rerender } = renderHook(() =>
      useComposerToolbarStore(
        null,
        fallbackSeedSource(seeds.current, null),
        null,
        false,
      ),
    );
    expect(result.current.getState().selection.profileId).toBe("work-uuid");

    seeds.current = { ...seeds.current, profileId: null };
    rerender();

    expect(result.current.getState().selection.profileId).toBeNull();
  });

  it("records memory even when the surface passes a null onSettingsChange", async () => {
    // Fork dialogs / add-node pass `onSettingsChange: null`. The always-on
    // recording wrapper must still populate memory on a confirmed user edit.
    seedDefault("codex");
    harnessesData.value = {
      harnesses: [{ id: "codex", available: true }],
    };
    modelsData.value = {
      models: [
        {
          harnessId: "codex",
          slug: "saved-model",
          label: "Saved Model",
          description: null,
          isDefault: true,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [
            { id: "high", label: "High", description: null },
          ],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    };
    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, null, false),
    );

    await waitFor(() =>
      expect(result.current.getState().selectedModel?.slug).toBe("saved-model"),
    );

    act(() => {
      result.current.getState().setReasoning("high");
    });

    const memory = useComposerHarnessMemoryStore.getState();
    expect(memory.lastModelByHarness.codex).toBe("saved-model");
    expect(
      memory.resolveModelSelection("codex", "saved-model").reasoningEffort,
    ).toBe("high");
  });

  it("does not record memory while the surface reroutes the harness", async () => {
    // GUI-only `traycer` is rerouted to `codex` on the terminal surface. The edit
    // is suppressed (rerouted), so the catalog-confirmed write must record
    // nothing - not under the rerouted harness, not under the raw one.
    seedDefault("traycer");
    harnessesData.value = {
      harnesses: [
        { id: "traycer", available: true, modes: ["gui"] },
        { id: "codex", available: true, modes: ["gui", "tui"] },
      ],
    };
    modelsData.value = {
      models: [
        {
          harnessId: "codex",
          slug: "codex-default",
          label: "Codex Default",
          description: null,
          isDefault: true,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [
            { id: "high", label: "High", description: null },
          ],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    };
    const { result } = renderHook(() =>
      useComposerToolbarStore(null, { kind: "none" }, null, true),
    );

    await waitFor(() => {
      const selection = result.current.getState().selection;
      expect(selection.harnessId).toBe("codex");
      expect(selection.modelSlug).toBe("codex-default");
    });

    act(() => {
      result.current.getState().setReasoning("high");
    });

    // Rerouted -> emit suppressed -> nothing recorded for either harness.
    const memory = useComposerHarnessMemoryStore.getState();
    expect(memory.lastModelByHarness).toEqual({});
  });

  it("detaches harness queries and command registration when inactive", () => {
    seedDefault("codex");
    renderHook(
      () => useComposerToolbarStore("landing", { kind: "none" }, null, false),
      {
        wrapper: inactiveWrapper,
      },
    );

    expect(harnessQueryCalls.at(-1)).toEqual({
      enabled: false,
      subscribed: false,
    });
    expect(modelQueryCalls.at(-1)).toEqual({
      harnessId: "codex",
      workingDirectory: null,
      enabled: false,
      subscribed: false,
    });
    expect(registeredComposerKinds.at(-1)).toBeNull();
  });
});
