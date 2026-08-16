import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

/**
 * What CHOOSING a host does on this surface — the one thing that legitimately
 * differs between the pickers now that they share a list.
 *
 * - `view`: point a read-only surface at the host (Settings' scoped sections,
 *   the header's usage popover). A host this client cannot dial is a legal
 *   pick: the surface then says why it is empty, and picking it is how you get
 *   back to it when it returns.
 * - `bind`: make it the host this window RUNS on — where new work lands (the
 *   composer, the file tree, the git-diff panel, the terminal picker, the
 *   shell's Select host dialog). A host this client cannot dial is not a legal
 *   answer there, so its row is inert rather than a click that could only fail.
 *
 * Both intents draw the SAME row. Which hosts exist, what they are called and
 * whether they can be reached is one answer everywhere; only the consequence of
 * clicking differs.
 */
export type HostPickIntent = "view" | "bind";

/**
 * A refusal the SURFACE holds against a host, keyed by `hostId` and carrying
 * the one word the row shows for it ("needs update").
 *
 * `connectable` / `planRestricted` are facts about the host that every picker
 * shares. This is the other kind: a reason THIS picker cannot use THIS host,
 * which no other picker would state — the fork dialog's target must speak
 * `epic.createChat` at the minor that carries the cross-host owner hint, and a
 * host below it is perfectly fine everywhere else in the app.
 *
 * It travels as a map rather than a predicate so the picker chain stays
 * referentially stable and a surface with nothing to say passes
 * {@link NO_HOST_OPTION_REFUSALS} instead of a fresh closure per render.
 */
export const NO_HOST_OPTION_REFUSALS: ReadonlyMap<string, string> = new Map();

/**
 * What a surface is saying about one row, as ONE value.
 *
 * A union rather than two independent fields because the combination
 * "unreachable because of the surface" AND "here is what is wrong with this
 * host" is not a state that should be expressible. It rendered as a globally
 * inert row still carrying "needs update", which invites a retry on another
 * machine that cannot possibly help — the per-host word contradicting the
 * class-level reason sitting next to it.
 *
 * Inert LEADS: when the surface has put every row but one out of reach, the
 * surface owns the explanation and the rows stay silent.
 */
export type HostRowSurfaceState =
  | { readonly kind: "available" }
  /** This host's own problem, in one word, on this row. */
  | { readonly kind: "refused"; readonly word: string }
  /** The surface's problem. No word here — the surface says it once. */
  | { readonly kind: "inert" };

export function hostRowSurfaceState(input: {
  readonly surfaceRefusal: string | null;
  readonly surfaceInert: boolean;
}): HostRowSurfaceState {
  if (input.surfaceInert) return { kind: "inert" };
  if (input.surfaceRefusal !== null) {
    return { kind: "refused", word: input.surfaceRefusal };
  }
  return { kind: "available" };
}

export const AVAILABLE_HOST_ROW_SURFACE_STATE: HostRowSurfaceState = {
  kind: "available",
};

/**
 * Whether choosing this row is a legal answer for that intent.
 *
 * Every container asks THIS, rather than re-deriving "can I click it" from
 * `connectable` beside its own copy of the reason word. A second gate written
 * as a hand-rolled subset of this one is how a row ends up inert with no
 * explanation, or explained but still clickable — which is exactly why the
 * surface state is an argument here and not a second `&&` at each container.
 */
export function isHostOptionSelectable(
  host: HostScopeOption,
  intent: HostPickIntent,
  surfaceState: HostRowSurfaceState,
): boolean {
  if (surfaceState.kind !== "available") return false;
  return intent === "view" || host.connectable;
}

/**
 * A host this client cannot dial is still worth listing — it is the account's
 * host and its status is real — but saying so up front prevents a click that
 * could only ever fail. Plan-gated is named apart from unreachable: the first
 * is fixed by an upgrade, the second maybe by waiting, and one word covering
 * both sends people debugging their network over a billing limit.
 *
 * Order of precedence, most-owning first: an INERT row says nothing at all
 * (the surface owns the explanation); otherwise connectivity leads, because a
 * host there is no route to cannot also be meaningfully described as out of
 * date; and the surface refusal speaks for a host that IS dialable and still
 * cannot be used here.
 */
export function hostOptionStatusWord(
  host: HostScopeOption,
  surfaceState: HostRowSurfaceState,
): string | null {
  // The SURFACE state is consulted FIRST, not after connectivity. When the
  // surface has put the row out of reach it owns the whole explanation, and a
  // connectivity word alongside it contradicts that reason - "unreachable" or
  // "requires upgrade" on a row the class already ruled out reads as a problem
  // with THAT machine, and invites trying another one when no other one can
  // help. Suppressing it here is what makes the no-word channel actually
  // wordless: it was the third writer of row words, upstream of the union.
  if (surfaceState.kind === "inert") return null;
  if (!host.connectable) {
    return host.planRestricted ? "requires upgrade" : "unreachable";
  }
  return surfaceState.kind === "refused" ? surfaceState.word : null;
}

/**
 * What KIND of host this is, in words.
 *
 * The row draws this as a glyph, which is `aria-hidden` — so when the Select
 * host dialog moved onto the shared row it silently dropped the `Local` /
 * `Remote` badge that had been the only kind information a screen reader ever
 * got there. The glyph stays the visual carrier; this is its text twin,
 * rendered `sr-only` beside it, so nobody has to infer a machine's kind from an
 * icon they cannot see.
 */
export function hostOptionKindLabel(host: HostScopeOption): string {
  if (host.isLocalMachine) return "This machine";
  if (host.entry?.kind === "remote") return "Remote host";
  if (host.entry?.kind === "mock") return "Mock host";
  return "Host";
}
