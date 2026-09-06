import type { ProviderNoticeKind } from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * The notice kinds the provider-fallback engine writes.
 *
 * A set rather than a per-kind check at each call site: three arms already
 * share the settings link, and the next one added to the enum should join them
 * by being listed here once rather than by someone remembering four `||`s.
 *
 * In its own module rather than beside the components that read it, because a
 * `.tsx` exporting a non-component both breaks fast refresh and hides a
 * testable rule inside a render file. The rule is worth a unit test on its own:
 * it decides which transcript rows carry a settings link, and getting it wrong
 * in the permissive direction puts a fallback affordance on a Codex reroute
 * notice.
 */
const FALLBACK_NOTICE_KINDS: ReadonlySet<ProviderNoticeKind> = new Set([
  "fallback_applied",
  "fallback_wait_resumed",
  "fallback_settled",
]);

export function isFallbackNoticeKind(kind: ProviderNoticeKind): boolean {
  return FALLBACK_NOTICE_KINDS.has(kind);
}
