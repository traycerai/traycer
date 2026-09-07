/**
 * One flat row per `chord`-kind action in `ACTION_META`.
 * Runs as a React source so rebinding a chord in the settings UI updates the palette's shortcut column live; the items themselves still dispatch through `dispatchAction` via `runCommandItem`, so the keybinding registry remains the single source of truth for.
 */
import { useMemo } from "react";
import {
  ACTION_IDS,
  ACTION_META,
  type ActionId,
  type ActionMeta,
} from "@/lib/keybindings/actions";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import type { CommandItem, ReactCommandSource } from "@/lib/commands/types";

export const actionsSource: ReactCommandSource = {
  id: "actions",
  useItems: () => {
    const bindings = useKeybindingStore((state) => state.bindings);
    return useMemo<ReadonlyArray<CommandItem>>(() => {
      const items: Array<CommandItem> = [];
      for (const id of ACTION_IDS) {
        const meta = ACTION_META[id];
        if (!isPaletteEligible(meta)) continue;
        items.push(buildActionItem(meta, bindings[id] ?? null));
      }
      return items;
    }, [bindings]);
  },
};

function isPaletteEligible(meta: ActionMeta): boolean {
  if (meta.kind !== "chord") return false;
  if (meta.id === "app.palette.open") return false;
  // No dispatchAction handler; handled by the capture-phase dictation hook.
  if (meta.id === "composer.dictation.toggle") return false;
  // The composer source emits a context-gated "Change model…" entry (with the
  // active model as its subtitle); a second generic row here would duplicate it.
  if (meta.id === "composer.model-picker.toggle") return false;
  if (meta.id === "composer.stash") return false;
  return true;
}

function buildActionItem(
  meta: ActionMeta,
  shortcut: string | null,
): CommandItem {
  const actionId: ActionId = meta.id;
  return {
    id: `action:${actionId}`,
    label: meta.label,
    description: meta.description,
    keywords: [meta.category],
    group: "actions",
    scope: "actions",
    shortcut,
    actionId,
    subpage: null,
    // Never reached from the palette: `runCommandItem` short-
    // circuits to `dispatchAction` whenever `actionId !== null`.
    run: () => undefined,
  };
}
