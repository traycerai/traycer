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
  value: {
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
  };
} = { value: { models: [] } };
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

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { FocusedComposerKind } from "@/lib/commands/types";

function seedDefault(
  harnessId: "claude" | "codex" | "opencode" | "traycer" | "cursor",
): void {
  useSettingsStore.setState({
    defaultSelection: { harnessId, modelSlug: "saved-model" },
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
    modelsData.value = { models: [] };
    harnessQueryCalls.length = 0;
    modelQueryCalls.length = 0;
    registeredComposerKinds.length = 0;
    // Reset the sticky tier default so a tier-normalization test can't leak its
    // preference into a later test's seeded values.
    useSettingsStore.setState({ defaultServiceTier: "" });
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
      useComposerToolbarStore(null, null, null, false),
    );

    await waitFor(() =>
      expect(result.current.getState().selection).toEqual({
        harnessId: "codex",
        modelSlug: "",
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
      useComposerToolbarStore(null, null, null, false),
    );

    // Give the catalog-sync effect a chance to (not) reroute.
    await Promise.resolve();
    expect(result.current.getState().selection).toEqual({
      harnessId: "claude",
      modelSlug: "saved-model",
    });
  });

  it("does nothing while the harness list is still loading", async () => {
    seedDefault("opencode");
    harnessesData.value = undefined;

    const { result } = renderHook(() =>
      useComposerToolbarStore(null, null, null, false),
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
      useComposerToolbarStore(null, null, null, true),
    );

    await waitFor(() =>
      expect(result.current.getState().selection.harnessId).toBe("codex"),
    );
    // Raw sticky value is untouched, so switching back to chat re-presents it.
    expect(result.current.getState().values.selection.harnessId).toBe(
      "traycer",
    );
  });

  it("reroutes a schema-TUI harness that advertises only gui (cursor)", async () => {
    // Cursor is in `tuiHarnessIdSchema`, but its adapter currently advertises
    // only `gui`. Capability is the runtime `modes`, not the schema id, so the
    // terminal surface reroutes off it like any other non-TUI harness.
    seedDefault("cursor");
    harnessesData.value = {
      harnesses: [
        { id: "cursor", available: true, modes: ["gui"] },
        { id: "codex", available: true, modes: ["gui", "tui"] },
      ],
    };

    const { result } = renderHook(() =>
      useComposerToolbarStore(null, null, null, true),
    );

    await waitFor(() =>
      expect(result.current.getState().selection.harnessId).toBe("codex"),
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
      useComposerToolbarStore(null, null, null, true),
    );

    await Promise.resolve();
    expect(result.current.getState().selection).toEqual({
      harnessId: "claude",
      modelSlug: "saved-model",
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
      useComposerToolbarStore(null, null, onSettingsChange, true),
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
      useComposerToolbarStore(null, null, onSettingsChange, false),
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
      defaultSelection: { harnessId: "claude", modelSlug: "" },
    });
    const onSettingsChange = vi.fn();
    const { result, rerender } = renderHook(() =>
      useComposerToolbarStore(null, null, onSettingsChange, false),
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
      defaultSelection: { harnessId: "cursor", modelSlug: "composer" },
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
      useComposerToolbarStore(null, null, null, false),
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
      useComposerToolbarStore(null, null, onSettingsChange, false),
    );

    act(() => {
      result.current.getState().setSelection({
        harnessId: "codex",
        modelSlug: "low-only",
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
      useComposerToolbarStore(null, null, onSettingsChange, false),
    );

    act(() => {
      result.current.getState().setSelection({
        harnessId: "codex",
        modelSlug: "fast-only",
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
      useComposerToolbarStore(null, null, onSettingsChange, false),
    );

    act(() => {
      result.current.getState().setSelection({
        harnessId: "codex",
        modelSlug: "priority-capable",
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
      useComposerToolbarStore(null, null, onSettingsChange, false),
    );

    act(() => {
      result.current.getState().setAgentMode("epic");
    });

    expect(useSettingsStore.getState().defaultAgentMode).toBe("regular");
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ agentMode: "epic" }),
    );
  });

  it("re-seeds the store when the settings seed identity changes", async () => {
    seedDefault("codex");
    const seeds: { current: ChatRunSettings | null } = { current: null };
    const { result, rerender } = renderHook(() =>
      useComposerToolbarStore(null, seeds.current, null, false),
    );
    expect(result.current.getState().selection.harnessId).toBe("codex");

    seeds.current = {
      harnessId: "claude",
      model: "haiku",
      permissionMode: "full_access",
      reasoningEffort: "low",
      serviceTier: null,
      agentMode: "epic",
    };
    rerender();

    await waitFor(() =>
      expect(result.current.getState().selection).toEqual({
        harnessId: "claude",
        modelSlug: "haiku",
      }),
    );
    expect(result.current.getState().agentMode).toBe("epic");
    expect(result.current.getState().permission).toBe("full_access");
  });

  it("detaches harness queries and command registration when inactive", () => {
    seedDefault("codex");
    renderHook(() => useComposerToolbarStore("landing", null, null, false), {
      wrapper: inactiveWrapper,
    });

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
