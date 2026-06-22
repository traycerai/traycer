import { createContext, use, useEffect, type EffectCallback } from "react";

/**
 * Signals whether the epic pane the consumer lives in is the one currently
 * shown by `EpicTabHost`. Inactive panes stay mounted (keep-alive) but are
 * hidden with `display:none`, so size-measuring surfaces (xterm, editors)
 * read a 0x0 box while hidden. Subscribers refit when this flips back to
 * `true` instead of remounting - a remount would discard xterm scrollback.
 *
 * The provider is the raw `PaneVisibilityContext.Provider` rendered by
 * `EpicTabHost`; this module stays component-free so fast refresh keeps
 * working (matches the repo's `*-context-value.ts` convention).
 */
export const PaneVisibilityContext = createContext<boolean>(true);

/**
 * `true` when the surrounding epic pane is the visible one. Defaults to `true`
 * outside a provider so surfaces rendered without the host (tests, isolated
 * stories) behave as if visible.
 */
export function usePaneVisible(): boolean {
  return use(PaneVisibilityContext);
}

/**
 * Runs an effect only while the surrounding pane is visible. This is the
 * canonical gate for pane-local components that register global side effects
 * (toasts, find controllers, DOM measurement repair) while keep-alive panes
 * stay mounted in the background.
 */
export function useActivePaneEffect(effect: EffectCallback): void {
  const paneVisible = usePaneVisible();

  useEffect(() => {
    if (!paneVisible) return;
    return effect();
  }, [effect, paneVisible]);
}

export function useVisiblePaneValue<T>(visibleValue: T, hiddenValue: T): T {
  const paneVisible = usePaneVisible();
  return paneVisible ? visibleValue : hiddenValue;
}
