import type { ProviderNoticeKind } from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * The notice kinds the provider-fallback engine writes.
 *
 * A set rather than a per-kind check at each call site: the next kind added to
 * the enum should join by being listed here once rather than by someone
 * remembering four `||`s.
 *
 * **Membership IS the `fallback_` prefix.** Every kind the engine writes is
 * named `fallback_*` and every `fallback_*` kind belongs here, so a new one
 * added to the enum belongs in this set by construction rather than by
 * judgement. The set stays explicit because it is what the GUI reads, but the
 * prefix is the rule it encodes — `fallback-notice-kinds.test.ts` derives its
 * expectation from that prefix for exactly this reason, so a sixth kind cannot
 * pass by being invisible to both sides at once.
 *
 * In its own module rather than beside the components that read it, because a
 * `.tsx` exporting a non-component both breaks fast refresh and hides a
 * testable rule inside a render file. The rule is worth a unit test on its own:
 * it decides which transcript notices the chat's live announcer speaks
 * (`chat-announcements.ts`), and getting it wrong in the permissive direction
 * announces a Codex reroute notice as a routing move. No notice row carries a
 * settings link any more (clutter cuts, 2026-09-27), so the announcer is its
 * one reader.
 */
const FALLBACK_NOTICE_KINDS: ReadonlySet<ProviderNoticeKind> = new Set([
  // The FORWARD hop only, since the producers were split (row #4). It used to
  // cover the return as well, which is why a "Switched to work-account" notice
  // and a "Switched back to personal-account" notice were one value that no
  // reader could tell apart.
  "fallback_applied",
  "fallback_wait_resumed",
  "fallback_settled",
  // The return, both ways it can end. Both belong to the same engine and are
  // news the same way: a chat that did NOT move when it offered to is as much
  // an event as one that did.
  "fallback_returned",
  "fallback_return_blocked",
]);

export function isFallbackNoticeKind(kind: ProviderNoticeKind): boolean {
  return FALLBACK_NOTICE_KINDS.has(kind);
}
