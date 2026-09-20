import { createContext, use, useMemo } from "react";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import {
  AUTOMATIC_LIMIT_SELECTION,
  useLayoutStore,
  type ComposerLayoutPreferences,
  type ComposerToolbarOrder,
  type StatusBarHostShownProfiles,
  type StatusBarLayoutPreferences,
  type StatusBarProviderLimitSelection,
  type StatusBarProviderLimitSelections,
  type StatusBarRateLimitPreferences,
  type StatusBarResourcePreferences,
  type StatusBarShownProfiles,
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
 * Spelled out level by level rather than a generic deep-partial, because the
 * nesting is finite and naming it makes the merge below obviously total.
 *
 * **An ARRAY is a leaf and is replaced, never concatenated.** A list of metric
 * ids or window keys means "exactly these", so merging two of them would
 * produce a selection neither override asked for. A RECORD is not a leaf: its
 * keys are independent subjects (one provider, one host), so an override naming
 * one of them must leave the rest alone. That is the whole distinction, and
 * getting it wrong the other way round is what this shape exists to prevent -
 * an inner override of `providers["claude-code"]` used to drop an outer
 * override of `providers.codex`.
 */
/**
 * Per provider, then per leaf INSIDE that provider's selection.
 *
 * Two levels rather than one, for the same reason `shownProfiles` needs two: a
 * selection is `{ automatic, limitKeys }`, so replacing it whole means an
 * override about the windows a provider draws silently switches its automatic
 * choice back on. A popover that says "draw the weekly window" is saying
 * nothing at all about `automatic`. `limitKeys` stays a leaf - a list of
 * windows means exactly those.
 */
export type StatusBarProviderLimitOverrides = Readonly<
  Partial<Record<RateLimitProviderId, Partial<StatusBarProviderLimitSelection>>>
>;

export interface StatusBarRateLimitOverride extends Partial<
  Omit<StatusBarRateLimitPreferences, "providers" | "shownProfiles">
> {
  /** Per provider. An unnamed provider keeps whatever is under this one. */
  readonly providers?: StatusBarProviderLimitOverrides;
  /** Per host, then per provider. The id list itself is the leaf. */
  readonly shownProfiles?: StatusBarShownProfiles;
}

export interface StatusBarLayoutOverride extends Partial<
  Omit<StatusBarLayoutPreferences, "rateLimits" | "resources">
> {
  readonly rateLimits?: StatusBarRateLimitOverride;
  readonly resources?: Partial<StatusBarResourcePreferences>;
}

export interface ComposerLayoutOverride extends Partial<
  Omit<ComposerLayoutPreferences, "toolbar">
> {
  /**
   * One cluster at a time, so a popover about the left cluster does not have to
   * restate the right one it has no opinion about. Each cluster's LIST is a
   * leaf and is replaced whole - an arrangement is the order, not a set.
   */
  readonly toolbar?: Partial<ComposerToolbarOrder>;
}

export interface LayoutOverride {
  readonly statusBar?: StatusBarLayoutOverride;
  readonly composer?: ComposerLayoutOverride;
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

/**
 * The checked accounts, merged per host AND per provider inside that host.
 *
 * One level would not do it: the value under a host id is itself a map of
 * providers, so `{...parent, ...child}` at the host level replaces that whole
 * map and an inner override of one provider's accounts silently drops an outer
 * override of another's on the same machine. The `ReadonlyArray<string | null>`
 * at the bottom is the leaf.
 */
function mergeShownProfiles(
  parent: StatusBarShownProfiles,
  child: StatusBarShownProfiles,
): StatusBarShownProfiles {
  const merged: Record<string, StatusBarHostShownProfiles> = { ...parent };
  for (const [hostId, hostShown] of Object.entries(child)) {
    merged[hostId] = { ...merged[hostId], ...hostShown };
  }
  return merged;
}

/**
 * One override's providers onto another's, per provider AND per leaf inside it.
 */
function mergeProviderOverrides(
  parent: StatusBarProviderLimitOverrides,
  child: StatusBarProviderLimitOverrides,
): StatusBarProviderLimitOverrides {
  const merged: Record<string, Partial<StatusBarProviderLimitSelection>> = {
    ...parent,
  };
  for (const [providerId, selection] of Object.entries(child)) {
    merged[providerId] = { ...merged[providerId], ...selection };
  }
  return merged;
}

/**
 * An override's providers onto the STORED map, which is the same merge one
 * level down: a provider the override does not name keeps its stored
 * selection, and one it names half of keeps the stored other half.
 *
 * A provider with no stored entry is on the default selection - the same floor
 * `statusBarProviderLimitSelection` reads it at - so an override naming only
 * `limitKeys` there resolves against that rather than against nothing.
 */
function resolveProviders(
  stored: StatusBarProviderLimitSelections,
  override: StatusBarProviderLimitOverrides,
): StatusBarProviderLimitSelections {
  const merged: Record<string, StatusBarProviderLimitSelection> = {
    ...stored,
  };
  for (const [providerId, selection] of Object.entries(override)) {
    merged[providerId] = {
      ...AUTOMATIC_LIMIT_SELECTION,
      ...merged[providerId],
      ...selection,
    };
  }
  return merged;
}

function mergeRateLimits(
  parent: StatusBarRateLimitOverride,
  child: StatusBarRateLimitOverride,
): StatusBarRateLimitOverride {
  return {
    ...parent,
    ...child,
    // The two RECORDS spread one level deeper than the group around them, so a
    // key neither override names keeps whatever the other put there.
    ...(parent.providers === undefined && child.providers === undefined
      ? {}
      : {
          providers: mergeProviderOverrides(
            parent.providers ?? {},
            child.providers ?? {},
          ),
        }),
    ...(parent.shownProfiles === undefined && child.shownProfiles === undefined
      ? {}
      : {
          shownProfiles: mergeShownProfiles(
            parent.shownProfiles ?? {},
            child.shownProfiles ?? {},
          ),
        }),
  };
}

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
      : {
          rateLimits: mergeRateLimits(
            parent.rateLimits ?? {},
            child.rateLimits ?? {},
          ),
        }),
    // `resources` has no record under it - `metrics` is an array, which is a
    // leaf - so one level is the whole merge here.
    ...(parent.resources === undefined && child.resources === undefined
      ? {}
      : { resources: { ...parent.resources, ...child.resources } }),
  };
}

function mergeComposer(
  parent: ComposerLayoutOverride | undefined,
  child: ComposerLayoutOverride | undefined,
): ComposerLayoutOverride | undefined {
  if (parent === undefined) return child;
  if (child === undefined) return parent;
  return {
    ...parent,
    ...child,
    // Per cluster: an inner override of `right` keeps an outer `left`.
    ...(parent.toolbar === undefined && child.toolbar === undefined
      ? {}
      : { toolbar: { ...parent.toolbar, ...child.toolbar } }),
  };
}

/** Used by `LayoutOverrideProvider`; not part of the read API. */
export function mergeOverrides(
  parent: LayoutOverride,
  child: LayoutOverride,
): LayoutOverride {
  return {
    statusBar: mergeStatusBar(parent.statusBar, child.statusBar),
    composer: mergeComposer(parent.composer, child.composer),
    settings:
      parent.settings === undefined && child.settings === undefined
        ? undefined
        : { ...parent.settings, ...child.settings },
  };
}

function resolveRateLimits(
  stored: StatusBarRateLimitPreferences,
  override: StatusBarRateLimitOverride | undefined,
): StatusBarRateLimitPreferences {
  if (override === undefined) return stored;
  return {
    ...stored,
    ...override,
    // Same record rule as the override-to-override merge: an override naming
    // one provider leaves every other provider's stored selection standing.
    providers:
      override.providers === undefined
        ? stored.providers
        : resolveProviders(stored.providers, override.providers),
    shownProfiles:
      override.shownProfiles === undefined
        ? stored.shownProfiles
        : mergeShownProfiles(stored.shownProfiles, override.shownProfiles),
  };
}

/** The composer keys a leaf hook may read. See {@link useComposerLayoutValue}. */
type ComposerLeafKey = Exclude<keyof ComposerLayoutPreferences, "toolbar">;

/** The usage-group keys a leaf hook may read. See {@link useStatusBarRateLimitValue}. */
type StatusBarRateLimitLeafKey = Exclude<
  keyof StatusBarRateLimitPreferences,
  "providers" | "shownProfiles"
>;

/**
 * One leaf out of an override, typed as the PREFERENCE it stands in for.
 *
 * Indexing the override interface directly would not do it: under a generic
 * key, `ComposerLayoutOverride[Key]` is its own indexed access and TypeScript
 * has no way to see that it is the same type as `ComposerLayoutPreferences[Key]`,
 * so the value cannot be returned from a hook that promises the latter. Taking
 * the override as the mapped type `Partial<Pick<…>>` instead makes the index
 * resolve through the preferences themselves - the same types, read from the
 * side the answer is owed to. A cast would silence the error and lose exactly
 * the check that matters here.
 */
function composerOverrideValue<Key extends ComposerLeafKey>(
  override:
    | Partial<Pick<ComposerLayoutPreferences, ComposerLeafKey>>
    | undefined,
  key: Key,
): ComposerLayoutPreferences[Key] | undefined {
  return override?.[key];
}

/** {@link composerOverrideValue}, for the usage group. */
function statusBarRateLimitOverrideValue<Key extends StatusBarRateLimitLeafKey>(
  override:
    | Partial<Pick<StatusBarRateLimitPreferences, StatusBarRateLimitLeafKey>>
    | undefined,
  key: Key,
): StatusBarRateLimitPreferences[Key] | undefined {
  return override?.[key];
}

/**
 * The whole composer slice.
 *
 * For a reader that genuinely draws from the whole slice - the chat tile's dock
 * chrome, which reads seven fields. A reader that wants ONE field wants
 * {@link useComposerLayoutValue}: this hook subscribes to the slice, so
 * changing `access` would re-render the mic button too.
 */
export function useComposerLayout(): ComposerLayoutPreferences {
  const stored = useLayoutStore((state) => state.composer);
  const override = use(LayoutOverrideContext).composer;
  return useMemo(() => {
    if (override === undefined) return stored;
    return {
      ...stored,
      ...override,
      toolbar:
        override.toolbar === undefined
          ? stored.toolbar
          : { ...stored.toolbar, ...override.toolbar },
    };
  }, [stored, override]);
}

/**
 * One composer field, subscribed to exactly that field.
 *
 * This is the default for a consumer that draws one element, and the reason is
 * re-renders: the mic button, the attach button, the permission pill and the
 * model chip each read a single key, and before the seam existed each selected
 * only that key. Routing them through the slice hook made every one of them
 * re-render whenever any OTHER composer preference changed - invisible in a
 * test, and a real cost in a composer that is on screen all day.
 *
 * `toolbar` is deliberately not reachable here: its override is a PARTIAL
 * (either cluster may be absent), so a hook returning `ComposerLayoutPreferences[Key]`
 * cannot honestly type it. A toolbar reader takes the slice hook, which merges
 * the two clusters properly.
 */
export function useComposerLayoutValue<Key extends ComposerLeafKey>(
  key: Key,
): ComposerLayoutPreferences[Key] {
  const stored = useLayoutStore((state) => state.composer[key]);
  const value = composerOverrideValue(use(LayoutOverrideContext).composer, key);
  return value === undefined ? stored : value;
}

/** The whole status-bar slice. Prefer the leaf hooks below; same reason. */
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
      rateLimits: resolveRateLimits(stored.rateLimits, override.rateLimits),
      resources:
        override.resources === undefined
          ? stored.resources
          : { ...stored.resources, ...override.resources },
    };
  }, [stored, override]);
}

/**
 * One usage-group field, subscribed to exactly that field.
 *
 * `providers` and `shownProfiles` are excluded for {@link useComposerLayoutValue}'s
 * reason: their overrides are partial records that merge, so a hook typed to
 * return the full map would be lying. A reader of either takes the slice hook.
 */
export function useStatusBarRateLimitValue<
  Key extends StatusBarRateLimitLeafKey,
>(key: Key): StatusBarRateLimitPreferences[Key] {
  const stored = useLayoutStore((state) => state.statusBar.rateLimits[key]);
  const value = statusBarRateLimitOverrideValue(
    use(LayoutOverrideContext).statusBar?.rateLimits,
    key,
  );
  return value === undefined ? stored : value;
}

/** One resource-segment field, subscribed to exactly that field. */
export function useStatusBarResourceValue<
  Key extends keyof StatusBarResourcePreferences,
>(key: Key): StatusBarResourcePreferences[Key] {
  const stored = useLayoutStore((state) => state.statusBar.resources[key]);
  const override = use(LayoutOverrideContext).statusBar?.resources;
  const value = override?.[key];
  return value === undefined ? stored : value;
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
