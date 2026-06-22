/**
 * Framework-free command-palette type definitions. The keybinding
 * module owns keyboard dispatch; this module owns the palette's data
 * shape so sources, the registry, and the dispatcher never import
 * React and stay unit-testable.
 */
import type { ActionId } from "@/lib/keybindings/actions";
import type { ChordString } from "@/lib/keybindings/chord";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";

/**
 * Scopes narrow the palette to a subset of items. A leading prefix
 * character in the input (`>`, `#`, `@`, `?` - see `./scopes.ts`)
 * activates a scope; `null` means "show everything".
 */
export type CommandScope = "actions" | "epics" | "workspaces" | "help";

/**
 * Groups map 1:1 to the visual buckets rendered in the palette list.
 * Source authors pick one of these for every item they emit; the
 * renderer groups results by this field.
 */
export type CommandGroupId =
  | "pinned"
  | "recents"
  | "suggested"
  | "actions"
  | "navigation"
  | "epics"
  | "theme"
  | "help"
  // "open" backs the open-into-target opener categories. These items are only
  // emitted when the palette is bound to a target group and are rendered by a
  // dedicated opener root view, not the default group buckets.
  | "open";

/**
 * Runtime context a source sees when asked to emit its items. Built
 * fresh on every palette open / query change so sources stay pure.
 *
 * `focusedComposerKind` is stubbed to `null` in this phase - the
 * composer-scoped source wires it up in ticket 04.
 */
export interface CommandContext {
  readonly pathname: string;
  readonly router: KeybindingRouter;
  readonly activeTabId: string | null;
  readonly activeEpicId: string | null;
  readonly focusedComposerKind: FocusedComposerKind | null;
  /**
   * The opener's bound canvas tile group, or `null` for the global palette.
   * The "open" source emits its category entries only when this is non-null,
   * and opener leaves route their open through it.
   */
  readonly targetGroupId: string | null;
}

export type FocusedComposerKind = "landing" | "chat-tile";

/**
 * One selectable row in the palette. Sources emit these; the
 * dispatcher runs them. Any item whose `actionId !== null` routes
 * through `dispatchAction(id, router)` so shortcuts and the palette
 * never get out of sync - the single source of truth for what the
 * action does stays inside `src/lib/keybindings/`.
 *
 * Items whose `subpage !== null` push a new cmdk page onto the
 * palette's internal stack on select; `run` is ignored in that
 * case. Used by the composer source's "Switch model" / "Switch
 * provider" / "Select PC" items so users drill one level into a
 * picker without leaving the palette.
 */
export interface CommandItem {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly keywords: ReadonlyArray<string>;
  readonly group: CommandGroupId;
  readonly scope: CommandScope;
  readonly shortcut: ChordString | null;
  readonly actionId: ActionId | null;
  readonly run: CommandRun;
  readonly subpage: CommandSubpage | null;
}

/**
 * Named sub-page description - the palette pushes this onto its
 * stack when a subpage-bearing item is selected, then renders only
 * this page's items until the user backs out (Esc pops one level).
 *
 * `useItems` is a hook (same rules as `ReactCommandSource.useItems`)
 * so sub-page content can reactively track store state like the
 * enabled providers list or the currently-selected model.
 */
export interface CommandSubpage {
  readonly id: string;
  readonly title: string;
  readonly useItems: (ctx: CommandContext) => ReadonlyArray<CommandItem>;
}

/**
 * Item handler. Synchronous or asynchronous; the dispatcher awaits
 * the returned promise (if any) before closing the palette and
 * recording the use. Throwing is treated as "the action failed" -
 * dispatch logs + swallows so the palette can't crash the shell.
 */
export type CommandRun = (ctx: CommandContext) => void | Promise<void>;

/**
 * A source plugs into the registry by exporting a `CommandSource`.
 * Pure sources are synchronous and framework-free - they cannot
 * call React hooks. Use `ReactCommandSource` when items depend on
 * data only available through a hook (TanStack Query, store
 * subscriptions, etc).
 */
export interface CommandSource {
  readonly id: string;
  readonly getItems: (ctx: CommandContext) => ReadonlyArray<CommandItem>;
}

/**
 * A React-aware source. `useItems` is a hook - follows the rules of
 * hooks, must always be called unconditionally. The registry lists
 * these separately so the palette aggregator can call each hook
 * exactly once per render.
 */
export interface ReactCommandSource {
  readonly id: string;
  readonly useItems: (ctx: CommandContext) => ReadonlyArray<CommandItem>;
}
