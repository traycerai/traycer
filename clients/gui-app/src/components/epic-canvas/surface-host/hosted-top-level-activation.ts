/**
 * Design-review slice-4 finding 3: a hosted record's pointerdown/focus never
 * reaches any physical top-level surface wrapper's own
 * `onFocusCapture`/`onPointerDownCapture` (each of `TopLevelTabHost`'s
 * `mounts.map(...)` divs) - `StableTileSurfaceHost` is a SIBLING of those
 * wrappers, not a descendant of any one of them. This resolves the hosted
 * record's owning `HeaderTab` from the event target itself and applies the
 * exact same focused/defaultPrevented gate `activateTopLevelSurfaceFromPointer`/
 * `FromFocus` already use for the physical case, so a hosted body activates
 * its OWN owning top-level tab rather than a fixed one.
 *
 * A non-component module (design-review slice-4 residual): co-located with
 * `TopLevelTabHost` until this was factored out, exporting a plain
 * function/interface alongside a component tripped `react-refresh/only-
 * export-components`. `refsMatch`/`refIsFocused` moved here too rather than
 * being duplicated - `TopLevelTabHost`'s own `placementForRef` needs the
 * exact same ref-vs-tab matching this activation path does, so this module
 * is their single shared source, imported back into `top-level-tab-host.tsx`.
 */
import {
  tabRefKey,
  type SplitSide,
  type StripItem,
} from "@/stores/tabs/layout";
import type { HeaderTab, TabRef } from "@/stores/tabs/types";
import { resolveHostedTileOwnership } from "@/components/epic-canvas/surface-host/hosted-tile-resolver";
import type { TopLevelSurfaceActivator } from "@/components/layout/top-level-surface-activation-context";

export interface HostedTopLevelActivationContext {
  readonly tabsByRefKey: ReadonlyMap<string, HeaderTab>;
  readonly activeItem: StripItem | null;
  readonly activate: TopLevelSurfaceActivator | null;
}

export function refsMatch(ref: TabRef | SplitSide, tab: HeaderTab): boolean {
  const candidate = ref.kind === "tab" ? ref.ref : ref;
  return (
    candidate.kind === tab.kind && "id" in candidate && candidate.id === tab.id
  );
}

export function refIsFocused(
  activeItem: StripItem | null,
  tab: HeaderTab,
): boolean {
  if (activeItem === null) return false;
  if (activeItem.kind === "tab") return refsMatch(activeItem.ref, tab);
  const focused =
    activeItem.focusedSide === "left" ? activeItem.left : activeItem.right;
  return refsMatch(focused, tab);
}

export function activateHostedTopLevelSurface(
  target: EventTarget | null,
  defaultPrevented: boolean,
  context: HostedTopLevelActivationContext,
): void {
  if (defaultPrevented || context.activate === null) return;
  if (!(target instanceof Element)) return;
  const ownership = resolveHostedTileOwnership(target);
  if (ownership === null) return;
  const tab = context.tabsByRefKey.get(
    tabRefKey({ kind: "epic", id: ownership.viewTabId }),
  );
  if (tab === undefined || refIsFocused(context.activeItem, tab)) return;
  context.activate(tab);
}
