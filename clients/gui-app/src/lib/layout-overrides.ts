import { createContext, use, useMemo } from "react";
import {
  useLayoutStore,
  type ComposerLayoutPreferences,
  type StatusBarLayoutPreferences,
  type StatusBarRateLimitPreferences,
  type StatusBarResourcePreferences,
} from "@/stores/settings/layout-store";
import {
  useSettingsStore,
  type SettingsState,
} from "@/stores/settings/settings-store";

/**
 * The ONE seam every layout preference is read through, so a picture of an
 * element under a DIFFERENT value can be drawn by the real component rather
 * than by a second, drifting copy of it.
 *
 * The problem it solves: the Customize editor's popovers and the presets'
 * thumbnails have to show what an option WOULD look like. Today's Layout page
 * answers that by hand-building previews out of visual leaves, which means the
 * preview and the real thing are two implementations of the same drawing and
 * only one of them is the one that ships. Wrapping the real leaf in an override
 * makes them the same implementation.
 *
 * ## The passivity contract (D11) - the part that is easy to get wrong
 *
 * An override changes what a mounted component DRAWS. It does not, and must
 * not, change whether one exists. So what may be wrapped is a VISUAL LEAF:
 * something that renders from props and these hooks and performs no app action.
 * A preview mount does no host fetch, opens no stream, registers no keyboard
 * handler, activates no picker and writes to no store. Mounting `AppStatusBar`
 * or a live `HarnessModelPicker` inside an override is not previewing, it is
 * running a second copy of the app's chrome.
 *
 * ## Ancestor seams an override cannot reach
 *
 * Several values decide whether a child is rendered at all, and they are read
 * by ancestors that a popover is nowhere near:
 *
 * - `AppShell` mounts the status-bar strip (`selectStatusBarShown`);
 * - `AppStatusBar` decides the usage cluster and the resource segment exist at
 *   all (`rateLimits.enabled`, `resources.enabled`);
 * - `chat-messages` mounts the turn minimap;
 * - the chat tile decides its dock exists;
 * - `top-level-tab-host`, the mobile drawer and the palette gate on the Home
 *   tab's existence.
 *
 * Those stay on the store deliberately. Previewing them means drawing the
 * ghost the editor already draws, NOT wrapping an ancestor - an override above
 * a mount decision would make the preview mount real chrome.
 */

/** The `settings-store` keys the Layout surface owns. */
export type LayoutSettingsKey =
  | "pinContextUsageBreakdown"
  | "pinnedContextBreakdownFields"
  | "pinnedContextBreakdownOrder"
  | "contextIndicatorStyle"
  | "chatTurnMinimapSide"
  | "navigatorResourceMetrics"
  | "homeTabEnabled";

/**
 * Two levels deep, spelled out rather than a generic deep-partial: the status
 * bar's two nested groups are the only nesting there is, and naming them keeps
 * the type readable and the merge below obviously total.
 */
export interface StatusBarLayoutOverride extends Partial<
  Omit<StatusBarLayoutPreferences, "rateLimits" | "resources">
> {
  readonly rateLimits?: Partial<StatusBarRateLimitPreferences>;
  readonly resources?: Partial<StatusBarResourcePreferences>;
}

export interface LayoutOverride {
  readonly statusBar?: StatusBarLayoutOverride;
  readonly composer?: Partial<ComposerLayoutPreferences>;
  readonly settings?: Partial<Pick<SettingsState, LayoutSettingsKey>>;
}

/**
 * Frozen and shared, so the common case - no provider anywhere above - costs
 * one stable context read and the hooks below return the store's own slice
 * object untouched. A fresh `{}` default would hand every consumer a new
 * identity on every render.
 */
const NO_OVERRIDE: LayoutOverride = Object.freeze({});

/**
 * Exported for `providers/layout-override-provider.tsx` and nothing else. The
 * provider lives in its own file because a module that exports both a
 * component and hooks breaks fast refresh (`react-refresh/only-export-components`),
 * which is the same three-file split `providers/runner-host-*` uses.
 */
export const LayoutOverrideContext = createContext<LayoutOverride>(NO_OVERRIDE);

function mergeStatusBar(
  parent: StatusBarLayoutOverride | undefined,
  child: StatusBarLayoutOverride | undefined,
): StatusBarLayoutOverride | undefined {
  if (parent === undefined) return child;
  if (child === undefined) return parent;
  return {
    ...parent,
    ...child,
    // Spread per GROUP, not per section: an inner override of `showBar` must
    // not drop an outer override of `percentMode` beside it.
    ...(parent.rateLimits === undefined && child.rateLimits === undefined
      ? {}
      : { rateLimits: { ...parent.rateLimits, ...child.rateLimits } }),
    ...(parent.resources === undefined && child.resources === undefined
      ? {}
      : { resources: { ...parent.resources, ...child.resources } }),
  };
}

/** Used by `LayoutOverrideProvider`; not part of the read API. */
export function mergeOverrides(
  parent: LayoutOverride,
  child: LayoutOverride,
): LayoutOverride {
  return {
    statusBar: mergeStatusBar(parent.statusBar, child.statusBar),
    composer:
      parent.composer === undefined && child.composer === undefined
        ? undefined
        : { ...parent.composer, ...child.composer },
    settings:
      parent.settings === undefined && child.settings === undefined
        ? undefined
        : { ...parent.settings, ...child.settings },
  };
}

/** The composer slice as this subtree should draw it. */
export function useComposerLayout(): ComposerLayoutPreferences {
  const stored = useLayoutStore((state) => state.composer);
  const override = use(LayoutOverrideContext).composer;
  return useMemo(
    () => (override === undefined ? stored : { ...stored, ...override }),
    [stored, override],
  );
}

/** The status-bar slice as this subtree should draw it. */
export function useStatusBarLayout(): StatusBarLayoutPreferences {
  const stored = useLayoutStore((state) => state.statusBar);
  const override = use(LayoutOverrideContext).statusBar;
  return useMemo(() => {
    if (override === undefined) return stored;
    return {
      ...stored,
      ...override,
      // A group the override says nothing about keeps the store's own object,
      // so a popover about the resource segment does not hand every consumer
      // of the usage group a new identity to re-render on.
      rateLimits:
        override.rateLimits === undefined
          ? stored.rateLimits
          : { ...stored.rateLimits, ...override.rateLimits },
      resources:
        override.resources === undefined
          ? stored.resources
          : { ...stored.resources, ...override.resources },
    };
  }, [stored, override]);
}

/** One `settings-store` layout key as this subtree should draw it. */
export function useLayoutSetting<Key extends LayoutSettingsKey>(
  key: Key,
): SettingsState[Key] {
  const stored = useSettingsStore((state) => state[key]);
  const override = use(LayoutOverrideContext).settings;
  const value = override?.[key];
  return value === undefined ? stored : value;
}
