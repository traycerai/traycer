import type { BoundTarget } from "@/lib/voice/directory";
import type { DeferredVerb, SpanPick } from "@/lib/voice/router";

/**
 * What became of a verb the router recognised: done, or refused with what
 * the voice tells the person. Either way nothing is posted and the words are
 * spent.
 */
export type VerbOutcome =
  | { readonly kind: "executed" }
  | { readonly kind: "refused"; readonly say: string };

/**
 * The executor of `read`, `later`, `brief`, `status` and `open`, which the
 * queue and briefing (VT4) and cards (VT5) build. Until they land each is
 * recognised and refused here with a spoken "not yet", so a build that has
 * the router but not the verb never posts the words by mistake. This is the
 * one place a later ticket swaps in its executor.
 */
export function executeDeferredVerb(
  verb: DeferredVerb,
  target: BoundTarget | null,
  span: SpanPick,
): VerbOutcome {
  void target;
  void span;
  const what: Record<DeferredVerb, string> = {
    read: "reading replies aloud",
    later: "putting replies aside for later",
    brief: "a briefing of what needs attention",
    status: "what a bot is running",
    open: "opening cards and pages",
  };
  return {
    kind: "refused",
    say: `Not yet: the voice cannot do ${what[verb]} yet. Nothing was posted.`,
  };
}
