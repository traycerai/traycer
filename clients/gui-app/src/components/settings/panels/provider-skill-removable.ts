import type {
  ProviderNativeScope,
  ProviderSkillSourceBadge,
} from "@traycer/protocol/host/provider-native-schemas";

/** The provider has no removal capability, so a "can't remove" note on every one of its skills would be noise,
 * not information. `blocked` - removal IS supported, but not for this skill. */
export type SkillRemovability =
  | { readonly kind: "removable" }
  | { readonly kind: "hidden" }
  | { readonly kind: "blocked"; readonly reason: string };

/** This copy exists only so the UI does not offer a button that is guaranteed to fail. */
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

/** `actionScopes.remove` advertising a scope is not on its own a licence to offer removal: it says the provider
 * supports the verb, while the source badge says whether this skill's files are ours to delete. */
export function skillRemovability(args: {
  readonly removeScopes: readonly ProviderNativeScope[];
  readonly source: ProviderSkillSourceBadge;
  readonly effectiveScope: ProviderNativeScope;
  /** Not independently removable: the foreign folder is not ours to delete, and a link row is never a remove
   * target. */
  readonly conflict: boolean;
}): SkillRemovability {
  // The selected scope specifically, not "any scope": the tab lists and mutates at `effectiveScope`, so a
  // provider advertising only the other scope would get a button whose request the host must refuse.
  if (!args.removeScopes.includes(args.effectiveScope)) {
    return { kind: "hidden" };
  }
  if (args.conflict) {
    return {
      kind: "blocked",
      reason:
        "This row is a conflict. A folder already occupies the provider link, so it cannot be removed from here.",
    };
  }
  if (!isWritableSkillSource(args.source)) {
    return { kind: "blocked", reason: BLOCKED_REASON[args.source] };
  }
  return { kind: "removable" };
}
