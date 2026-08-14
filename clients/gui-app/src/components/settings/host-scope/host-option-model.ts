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
 * Whether choosing this row is a legal answer for that intent.
 *
 * Every container asks THIS, rather than re-deriving "can I click it" from
 * `connectable` beside its own copy of the reason word. A second gate written
 * as a hand-rolled subset of this one is how a row ends up inert with no
 * explanation, or explained but still clickable.
 */
export function isHostOptionSelectable(
  host: HostScopeOption,
  intent: HostPickIntent,
): boolean {
  return intent === "view" || host.connectable;
}

/**
 * A host this client cannot dial is still worth listing — it is the account's
 * host and its status is real — but saying so up front prevents a click that
 * could only ever fail. Plan-gated is named apart from unreachable: the first
 * is fixed by an upgrade, the second maybe by waiting, and one word covering
 * both sends people debugging their network over a billing limit.
 */
export function hostOptionStatusWord(host: HostScopeOption): string | null {
  if (host.connectable) return null;
  return host.planRestricted ? "requires upgrade" : "unreachable";
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
