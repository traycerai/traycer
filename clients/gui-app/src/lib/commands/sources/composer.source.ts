/**
 * Composer-scoped commands. Visible only when a composer has
 * registered itself with the focused-composer-controls registry
 * (`kind === "landing"` or `"chat-tile"`). Items come in two
 * flavors:
 *
 *   - Sub-page entry rows ("Switch provider", "Switch model",
 *     "Select PC") - selecting pushes a cmdk page with the
 *     provider / model / device list. Item dispatch writes to the
 *     registered composer's setter.
 *   - Immediate rows ("New chat in active tile", "New chat in split
 *     (right/bottom)", "New terminal agent") - visible only when
 *     `activeTabId !== null`. They open the shared New Conversation
 *     modal seeded for the command's composer mode + preferred tile
 *     placement; the modal composes the first prompt and creates +
 *     places the result on submit.
 *
 * The "Select PC" row is landing-only (host is locked on existing
 * chats - final, not a v2 candidate).
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
import type { ConversationTilePlacement } from "@/lib/canvas/conversation-tile-placement";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
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
  // Live snapshot of the active composer picker - the top-of-stack controller,
  // or null. The "Change model…" row dispatches `composer.model-picker.toggle`,
  // which no-ops on an empty stack (a locked/pending composer registers its
  // focused-composer controls, so `kind` is set, but not a picker), so the row
  // is gated on this being non-null. Snapshotting the controller itself rather
  // than a collapsed boolean also re-renders when the top controller is swapped
  // while the stack stays non-empty, keeping the row's selection summary fresh.
  // The registered controller is ref-stable (parked behind a ref in
  // `useRegisterActiveModelPicker`), so the snapshot stays referentially stable
  // while the same picker is on top and `useSyncExternalStore` won't loop.
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
      items.push(buildNewChatSplitItem({ epicId, tabId, position: "right" }));
      items.push(buildNewChatSplitItem({ epicId, tabId, position: "bottom" }));
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

// ---------------------------------------------------------------------------
// Change model (open the focused composer's picker popover)
// ---------------------------------------------------------------------------

// Opens the picker popover via the centrally-dispatched
// `composer.model-picker.toggle` action (so the palette and the shortcut stay in
// lockstep). The subtitle reflects the active composer's current selection,
// passed in from the snapshotted active picker so it tracks controller swaps.
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

// ---------------------------------------------------------------------------
// Entry items (sub-page pushers)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// New-conversation items (open the shared modal at a placement)
// ---------------------------------------------------------------------------

function openNewConversationModal(
  epicId: string,
  tabId: string,
  mode: ComposerMode,
  placement: ConversationTilePlacement,
): void {
  useNewConversationModalStore.getState().setComposerMode(epicId, mode);
  // `hostId: null` names no host, the same as the Epic sidebar's own `+`: the
  // modal resolves this Epic's placement memory (its last created chat's
  // host, else the host the Epic is served from) and keeps the picker live.
  // These items act on the ACTIVE TILE's pane, but the tile's host is not
  // passed - a new agent is not required to live on the machine of the tile
  // it replaces, and naming one would freeze the picker (§55).
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
    label: "New agent in active tile",
    description:
      "Compose a new Chat-interface agent in place of the currently active tile.",
    keywords: ["new", "chat", "agent", "replace"],
    group: "suggested",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    run: () =>
      openNewConversationModal(epicId, tabId, "chat", { kind: "active-tile" }),
  };
}

function buildNewChatSplitItem(args: {
  readonly epicId: string;
  readonly tabId: string;
  readonly position: "right" | "bottom";
}): CommandItem {
  const { epicId, tabId, position } = args;
  const label =
    position === "right"
      ? "New agent in split (right)"
      : "New agent in split (bottom)";
  return {
    id: `composer:new-chat:split:${position}`,
    label,
    description: `Split the active tile and compose a new Chat-interface agent on the ${position}.`,
    keywords: ["new", "chat", "agent", "split", position],
    group: "suggested",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    run: () => {
      const activeGroupId =
        useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId ??
        null;
      const placement: ConversationTilePlacement =
        activeGroupId === null
          ? { kind: "active-tile" }
          : { kind: "split", groupId: activeGroupId, position };
      openNewConversationModal(epicId, tabId, "chat", placement);
    },
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
    description: "Compose a new Terminal-interface agent in the active tile.",
    keywords: ["new", "terminal", "agent", "tui"],
    group: "suggested",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    run: () =>
      openNewConversationModal(epicId, tabId, "terminal", {
        kind: "active-tile",
      }),
  };
}

// ---------------------------------------------------------------------------
// Sub-pages
// ---------------------------------------------------------------------------

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
 * The catalog the composer subpages list: the FOCUSED composer's target
 * host's, because that is the store `switchHarness` / `selectModel` dispatch
 * into (`getFocusedComposerControls()` in the items' `run`) - a chat tab bound
 * to another host must be offered that host's providers/models, not the
 * app-wide default's. With no focused composer there is nothing to dispatch
 * into, so the default host's catalog is listed (harmless); with a focused
 * composer whose host client has not resolved, nothing is listed rather than
 * another host's.
 */
function useFocusedComposerCatalog(): GuiHarnessCatalog {
  const entry = useFocusedComposerEntry();
  const defaultBinding = useHostBinding();
  const defaultEffectiveHostId = useEffectiveHostId();
  const defaultClient = useMemo(
    () => resolveSubtreeHostClient(defaultBinding, defaultEffectiveHostId),
    [defaultBinding, defaultEffectiveHostId],
  );
  // `"cached-only"`: opening a palette subpage must not cold-start every
  // provider on the focused composer's host. The subpages list what the host's
  // cache already holds - on the default host that is the prefetcher's full
  // fill; on a cold remote host it is at least the focused composer's selected
  // harness, which its own picker's standalone query warms on mount, growing
  // as the user browses providers in that picker.
  return useGuiHarnessCatalogForClient(
    entry === null ? defaultClient : entry.hostClient,
    null,
    { enabled: true, subscribed: true, modelsFetch: "cached-only" },
  );
}

/**
 * Both subpages listed on `available` alone, which made them the last
 * auth-blind paths into the composer: `available` is a binary-resolution/CLI
 * probe that never consults auth, so a provider whose account is signed out
 * was offered here indistinguishably from a live one.
 *
 * The picker surfaces answer this by joining against `providers.list`, but the
 * palette has no such query - it holds a catalog and nothing else. So this is
 * the site the row-carried `authStatus` exists for: the same definitive-only
 * verdict the rail reads, taken straight off the row being listed. On a host
 * below `agent.gui.listHarnesses@7.1` the field is absent, the predicate is
 * false for every row, and both subpages look exactly as they do today.
 */
function providerOfferableInPalette(provider: HarnessOption): boolean {
  return provider.available;
}

/**
 * The row's `authStatus` is the provider's AMBIENT verdict
 * (`peekProviderAmbientAuthStatus`, keyed on the null-profile scope) and
 * nothing more, so it DEMOTES a row - it must never remove one.
 *
 * The send gate is the authority on what can actually run, and it applies the
 * ambient verdict only when the composer's `profileId === null`; a composer
 * pinned to a managed profile is judged on THAT profile's own auth. Filtering
 * these rows out therefore hid every provider and model command for a
 * configuration that runs turns perfectly well - a signed-out terminal account
 * beside a signed-in managed profile. The palette cannot tell the two apart
 * (`FocusedComposerEntry` carries a host client, not profile state), so it
 * takes the reading it can defend: say so, order accordingly, and leave the
 * verdict to the gate that has the profile in hand.
 *
 * The rail reads the identical signal (`railHarnessDegraded`) and reaches the
 * same conclusion by a different route: there it dims the row and leaves it
 * exactly where it is, because the rail is a fixed strip of ⌘-digit positions
 * a user learns. This is a searched list with no positional memory to break,
 * so it may additionally group the unusable rows last.
 */
function providerSignedOutInPalette(provider: HarnessOption): boolean {
  return isHarnessRowSignedOut(provider);
}

/**
 * Signed-out providers sort last, keeping catalog order within each group.
 *
 * Generic over the row so the caller keeps the catalog's own element type -
 * `HarnessOption` is the narrow shape the item builders read (`id`, `label`),
 * and collapsing to it here would drop `models`, which the model subpage
 * needs. Same reason `sortGuiHarnessesByProviderOrder` is generic.
 */
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
 * `statusBadge` on an ACTIONABLE row - the qualifier reading of that field, not
 * the non-actionable "reason" one. The row stays selectable on purpose: see
 * {@link providerSignedOutInPalette}.
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
      // Memory-aware harness switch: restore that harness's last model +
      // effort/tier (or its defaults). Replaces the old browse-only
      // `setSelection(firstModel…)`.
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
