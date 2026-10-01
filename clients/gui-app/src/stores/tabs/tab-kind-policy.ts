import type { HeaderTabKind } from "@/stores/tabs/registry";

/**
 * The per-kind facts the tab STORES need, as plain data below the registry.
 *
 * `registry.ts` imports every kind module, and the kinds import the stores
 * (the epic kind activates through the epic-canvas store, which reads the tab
 * strip store). A store that imported the registry for these two facts closed
 * that loop, so loading a kind first built `TAB_KINDS` around a binding that
 * did not exist yet. Kind descriptors read their `splitEligibility` from here,
 * so this is the one source, and `satisfies` keeps the key set equal to the
 * registry's.
 */
export const TAB_KIND_SPLIT_ELIGIBILITY = {
  epic: "eligible",
  draft: "eligible",
  history: "eligible",
  settings: "eligible",
  home: "ineligible",
  "sample-workspace": "ineligible",
} as const satisfies Record<HeaderTabKind, "eligible" | "ineligible">;

/**
 * Runtime guard for persisted layout sanitization.
 *
 * `home` is registered like every other kind, but it has no strip presence:
 * `validRef` in `layout.ts` refuses a `home` ref outright. Registration here
 * is what makes `isRegisteredTabKind("home")` true, so that refusal is the
 * thing keeping a hand-edited payload from injecting a second Home into the
 * strip.
 */
export function isRegisteredTabKind(kind: string): kind is HeaderTabKind {
  return Object.hasOwn(TAB_KIND_SPLIT_ELIGIBILITY, kind);
}
