/**
 * A hosted tile body is a SIBLING of the physical top-level wrappers, not a
 * descendant, so it resolves its own owning tab from the event target.
 * `refsMatch`/`refIsFocused` live here so `top-level-tab-host.tsx` shares them.
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

type HostedTopLevelActivationClaim = (
  target: EventTarget | null,
  defaultPrevented: boolean,
) => void;

interface HostedTopLevelActivationClaims {
  readonly claimFocus: HostedTopLevelActivationClaim;
  readonly claimPointerDown: HostedTopLevelActivationClaim;
}

let hostedTopLevelActivationClaims: HostedTopLevelActivationClaims | null =
  null;

export function registerHostedTopLevelActivationClaims(
  claims: HostedTopLevelActivationClaims,
): () => void {
  hostedTopLevelActivationClaims = claims;
  return () => {
    if (hostedTopLevelActivationClaims === claims) {
      hostedTopLevelActivationClaims = null;
    }
  };
}

export function claimHostedTopLevelActivationFocus(
  target: EventTarget | null,
  defaultPrevented: boolean,
): void {
  hostedTopLevelActivationClaims?.claimFocus(target, defaultPrevented);
}

export function claimHostedTopLevelActivationPointerDown(
  target: EventTarget | null,
  defaultPrevented: boolean,
): void {
  hostedTopLevelActivationClaims?.claimPointerDown(target, defaultPrevented);
}
