/**
 * Composer-scoped commands.
 * Visible only when a composer has registered itself with the focused-composer-controls registry (`kind === "landing"` or `"chat-tile"`).
 */
import {
  type ComposerMode,
  type HarnessOption,
  type ModelOption,
} from "@/components/home/data/landing-options";
import {
  useGuiHarnessCatalogForClient,
  type GuiHarnessCatalog,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { isHarnessRowSignedOut } from "@/lib/providers/provider-ambient-auth";
import { useHostBinding } from "@/lib/host";
import { resolveSubtreeHostClient } from "@/lib/host/binding-host-client";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useFocusedComposerEntry } from "@/hooks/command-palette/use-focused-composer-entry";
import { getFocusedComposerControls } from "@/lib/commands/composer-controls-registry";
import {
  getActiveModelPicker,
  subscribeActiveModelPicker,
} from "@/lib/commands/active-model-picker-registry";
import type {
  CommandContext,
  CommandItem,
  CommandSubpage,
  ReactCommandSource,
} from "@/lib/commands/types";
import type { ChordString } from "@/lib/keybindings/chord";
import type { ExplicitTilePlacement } from "@/lib/canvas/tile-open/intent";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { useMemo, useSyncExternalStore } from "react";

const NO_ITEMS: ReadonlyArray<CommandItem> = [];

function useComposerItems(ctx: CommandContext): ReadonlyArray<CommandItem> {
  const kind = ctx.focusedComposerKind;
  // Live binding so rebinding ⌃⌥M / Alt+Shift+M updates the palette's shortcut
  // column immediately.
  const modelPickerShortcut = useKeybindingStore(
    (state) => state.bindings["composer.model-picker.toggle"],
  );
  const stashShortcut = useKeybindingStore(
    (state) => state.bindings["composer.stash"],
  );
  // Live snapshot of the active composer picker - the top-of-stack controller, or null.
  // The "Change model…" row dispatches `composer.model-picker.toggle`, which no-ops on an empty stack (a locked/pending composer registers its focused-composer controls, so `kind` is set, but not a picker), so the row is gated on this being non-null.
  const activeModelPicker = useSyncExternalStore(
    subscribeActiveModelPicker,
    getActiveModelPicker,
    getActiveModelPicker,
  );

  // Provider/model leaves fetch live host data only when their sub-pages
  // render, so opening the top-level palette does not eagerly hit SDKs.

  return useMemo<ReadonlyArray<CommandItem>>(() => {
    if (kind === null) return NO_ITEMS;
    const items: Array<CommandItem> = [buildStashPromptItem(stashShortcut)];
    if (activeModelPicker !== null) {
      items.push(
        buildChangeModelItem(
          modelPickerShortcut ?? null,
          activeModelPicker.getSelectionSummary(),
        ),
      );
    }
    items.push(buildSwitchProviderItem());
    items.push(buildSwitchModelItem());
    if (
      kind === "chat-tile" &&
      ctx.activeEpicId !== null &&
      ctx.activeTabId !== null
    ) {
      const epicId = ctx.activeEpicId;
      const tabId = ctx.activeTabId;
      items.push(buildNewChatReplaceItem({ epicId, tabId }));
      items.push(buildNewTerminalAgentItem({ epicId, tabId }));
    }
    return items;
  }, [
    kind,
    ctx.activeEpicId,
    ctx.activeTabId,
    modelPickerShortcut,
    stashShortcut,
    activeModelPicker,
  ]);
}

export const composerSource: ReactCommandSource = {
  id: "composer",
  useItems: useComposerItems,
};

function buildStashPromptItem(shortcut: ChordString | null): CommandItem {
  return {
    id: "composer:stash-prompt",
    label: "Stash prompt",
    description: "Save this prompt so it can be restored in any composer.",
    keywords: ["stash", "save", "prompt", "draft"],
    group: "suggested",
    scope: "actions",
    shortcut,
    actionId: "composer.stash",
    subpage: null,
    run: () => undefined,
  };
}

// Change model (open the focused composer's picker popover)

// Opens the picker popover via the centrally-dispatched `composer.model-picker.toggle` action (so the palette and the shortcut stay in lockstep).
// The subtitle reflects the active composer's current selection, passed in from the snapshotted active picker so it tracks controller swaps.
function buildChangeModelItem(
  shortcut: ChordString | null,
  description: string | null,
): CommandItem {
  return {
    id: "composer:open-model-picker",
    label: "Change model…",
    description,
    keywords: ["model", "change", "picker", "harness", "provider", "reasoning"],
    group: "suggested",
    scope: "actions",
    shortcut,
    actionId: "composer.model-picker.toggle",
    subpage: null,
    // Never reached: `runCommandItem` routes `actionId` items through
    // `dispatchAction`, which toggles the active picker.
    run: () => undefined,
  };
}

// Entry items (sub-page pushers)

function buildSwitchProviderItem(): CommandItem {
  return {
    id: "composer:switch-provider",
    label: "Switch provider",
    description: "Pick a provider for the focused composer.",
    keywords: ["provider", "switch"],
    group: "suggested",
    scope: "actions",
    shortcut: null,
    actionId: null,
    run: () => undefined,
    subpage: PROVIDER_SUBPAGE,
  };
}

function buildSwitchModelItem(): CommandItem {
  return {
    id: "composer:switch-model",
    label: "Switch model",
    description: "Pick a model for the focused composer.",
    keywords: ["model", "switch"],
    group: "suggested",
    scope: "actions",
    shortcut: null,
    actionId: null,
    run: () => undefined,
    subpage: MODEL_SUBPAGE,
  };
}

// New-conversation items (open the shared modal at a placement)

function openNewConversationModal(
  epicId: string,
  tabId: string,
  mode: ComposerMode,
  placement: ExplicitTilePlacement | null,
): void {
  useNewConversationModalStore.getState().setComposerMode(epicId, mode);
  // `hostId: null` names no host, the same as the Epic sidebar's own `+`: the modal resolves this Epic's placement memory (its last created chat's host, else the host the Epic is served from) and keeps the picker live.
  useNewConversationModalOpenStore
    .getState()
    .open({ epicId, tabId, placement, parentId: null, hostId: null });
}

function buildNewChatReplaceItem(args: {
  readonly epicId: string;
  readonly tabId: string;
}): CommandItem {
  const { epicId, tabId } = args;
  return {
    id: "composer:new-chat:replace",
    label: "New agent",
    description:
      "Compose a new Chat-interface agent; it lands where the conversation tile-placement setting says.",
    keywords: ["new", "chat", "agent", "replace"],
    group: "suggested",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    run: () => openNewConversationModal(epicId, tabId, "chat", null),
  };
}

function buildNewTerminalAgentItem(args: {
  readonly epicId: string;
  readonly tabId: string;
}): CommandItem {
  const { epicId, tabId } = args;
  return {
    id: "composer:new-terminal-agent",
    label: "New Terminal-interface agent",
    description:
      "Compose a new Terminal-interface agent; it lands where the conversation tile-placement setting says.",
    keywords: ["new", "terminal", "agent", "tui"],
    group: "suggested",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    run: () => openNewConversationModal(epicId, tabId, "terminal", null),
  };
}

// Sub-pages

const PROVIDER_SUBPAGE: CommandSubpage = {
  id: "composer:provider",
  title: "Pick provider",
  useItems: () => useProviderSubpageItems(),
};

const MODEL_SUBPAGE: CommandSubpage = {
  id: "composer:model",
  title: "Pick model",
  useItems: () => useModelSubpageItems(),
};

/**
 * The catalog the composer subpages list: the FOCUSED composer's target host's, because that is the store `switchHarness` / `selectModel` dispatch into (`getFocusedComposerControls()` in the items' `run`) - a chat tab bound to another host must be offered.
 */
function useFocusedComposerCatalog(): GuiHarnessCatalog {
  const entry = useFocusedComposerEntry();
  const defaultBinding = useHostBinding();
  const defaultEffectiveHostId = useEffectiveHostId();
  const defaultClient = useMemo(
    () => resolveSubtreeHostClient(defaultBinding, defaultEffectiveHostId),
    [defaultBinding, defaultEffectiveHostId],
  );
  // `"cached-only"`: opening a palette subpage must not cold-start every provider on the focused composer's host.
  // The subpages list what the host's cache already holds - on the default host that is the prefetcher's full fill; on a cold remote host it is at least the focused composer's selected harness, which its own picker's standalone query warms on mount, growing as.
  return useGuiHarnessCatalogForClient(
    entry === null ? defaultClient : entry.hostClient,
    null,
    { enabled: true, subscribed: true, modelsFetch: "cached-only" },
  );
}

/**
 * Both subpages listed on `available` alone, which made them the last auth-blind paths into the composer: `available` is a binary-resolution/CLI probe that never consults auth, so a provider whose account is signed out was offered here indistinguishably from.
 */
function providerOfferableInPalette(provider: HarnessOption): boolean {
  return provider.available;
}

/**
 * The row's `authStatus` is the provider's AMBIENT verdict (`peekProviderAmbientAuthStatus`, keyed on the null-profile scope) and nothing more, so it DEMOTES a row - it must never remove one.
 */
function providerSignedOutInPalette(provider: HarnessOption): boolean {
  return isHarnessRowSignedOut(provider);
}

/** Signed-out providers sort last, keeping catalog order within each group. */
function paletteProviderOrder<T extends HarnessOption>(
  harnesses: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return harnesses
    .filter((provider) => providerOfferableInPalette(provider))
    .toSorted(
      (left, right) =>
        Number(providerSignedOutInPalette(left)) -
        Number(providerSignedOutInPalette(right)),
    );
}

function useProviderSubpageItems(): ReadonlyArray<CommandItem> {
  const catalog = useFocusedComposerCatalog();
  return useMemo(
    () =>
      paletteProviderOrder(catalog.harnesses).map((provider) =>
        buildProviderItem(provider),
      ),
    [catalog.harnesses],
  );
}

function useModelSubpageItems(): ReadonlyArray<CommandItem> {
  const catalog = useFocusedComposerCatalog();
  return useMemo(
    () =>
      paletteProviderOrder(catalog.harnesses).flatMap((provider) =>
        provider.models.map((model) => buildModelItem(provider, model)),
      ),
    [catalog.harnesses],
  );
}

/**
 * `statusBadge` on an ACTIONABLE row - the qualifier reading of that field, not the non-actionable "reason" one.
 * The row stays selectable on purpose: see {@link providerSignedOutInPalette}.
 */
function signedOutBadge(provider: HarnessOption): { statusBadge?: string } {
  return providerSignedOutInPalette(provider)
    ? { statusBadge: "Signed out" }
    : {};
}

function buildProviderItem(provider: HarnessOption): CommandItem {
  return {
    id: `composer:provider:${provider.id}`,
    label: provider.label,
    description: null,
    keywords: [provider.label.toLowerCase()],
    group: "suggested",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    ...signedOutBadge(provider),
    run: () => {
      const entry = getFocusedComposerControls();
      if (entry === null) return;
      // Memory-aware harness switch: restore that harness's last model + effort/tier (or its defaults).
      // Replaces the old browse-only `setSelection(firstModel…)`.
      entry.controls.switchHarness(provider.id);
    },
  };
}

function buildModelItem(
  provider: HarnessOption,
  model: ModelOption,
): CommandItem {
  return {
    id: `composer:model:${provider.id}:${model.slug}`,
    label: model.label,
    description: provider.label,
    keywords: [model.label.toLowerCase(), provider.label.toLowerCase()],
    group: "suggested",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    ...signedOutBadge(provider),
    run: () => {
      const entry = getFocusedComposerControls();
      if (entry === null) return;
      // Memory-aware model pick: keep the slug, restore that pair's effort/tier
      // (or the model's defaults). Replaces the old bare `setSelection`.
      entry.controls.selectModel(provider.id, model.slug);
    },
  };
}
