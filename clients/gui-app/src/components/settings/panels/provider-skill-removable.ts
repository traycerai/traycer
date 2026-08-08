import type {
  ProviderNativeScope,
  ProviderSkillSourceBadge,
} from "@traycer/protocol/host/provider-native-schemas";

/**
 * Whether the Remove affordance appears for one skill, and if not, whether
 * that is worth saying out loud.
 *
 * - `hidden` — the contract advertises no `remove` scope at all. The provider
 *   has no removal capability, so a "can't remove" note on every one of its
 *   skills would be noise, not information.
 * - `blocked` — removal IS supported, but not for this skill. Worth a line:
 *   the button is missing for a reason specific to this row, and without it
 *   the surface looks broken next to its removable siblings.
 * - `removable` — offer it.
 */
export type SkillRemovability =
  | { readonly kind: "removable" }
  | { readonly kind: "hidden" }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Mirrors the host's `isWritableSkillSource` (`skills-helpers.ts`), which is
 * the SOURCE OF TRUTH: `assertRemovableSkill` re-derives this server-side and
 * throws for any other source, plus re-checks that the resolved path is
 * contained in a writable root. This copy exists only so the UI does not offer
 * a button that is guaranteed to fail — it is not the enforcement, and the two
 * diverging shows up as the host's error text in the dialog rather than as a
 * silent deletion.
 */
function isWritableSkillSource(source: ProviderSkillSourceBadge): boolean {
  return source === "shared" || source === "provider";
}

const BLOCKED_REASON: Record<ProviderSkillSourceBadge, string> = {
  shared: "",
  provider: "",
  plugin: "This skill comes from a plugin. Remove the plugin to remove it.",
  managed:
    "Built-in skills ship with the provider and can't be removed from here.",
};

/**
 * `actionScopes.remove` advertising a scope is NOT on its own a licence to
 * offer removal: it says the provider supports the verb, while the source
 * badge says whether THIS skill's files are ours to delete. A plugin-provided
 * or built-in skill under a remove-capable provider satisfies the first and
 * fails the second.
 */
export function skillRemovability(args: {
  readonly removeScopes: readonly ProviderNativeScope[];
  readonly source: ProviderSkillSourceBadge;
  /** Scope the tab is currently listing/mutating at. */
  readonly effectiveScope: ProviderNativeScope;
}): SkillRemovability {
  // The selected scope specifically, not "any scope": the tab lists and
  // mutates at `effectiveScope`, so a provider advertising only the other
  // scope would get a button whose request the host must refuse. Testing the
  // scope that is actually invoked is the point of this module; testing merely
  // that SOME scope exists would reintroduce exactly the always-fails button
  // it was written to prevent.
  if (!args.removeScopes.includes(args.effectiveScope)) {
    return { kind: "hidden" };
  }
  if (!isWritableSkillSource(args.source)) {
    return { kind: "blocked", reason: BLOCKED_REASON[args.source] };
  }
  return { kind: "removable" };
}
