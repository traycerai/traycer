import type { ReactNode } from "react";

/**
 * Where a fence sits relative to the bytes Tailmark is still appending.
 *
 * `unknown` is the render before this fence's own tail marker has been
 * read. It is not safe to highlight: the bytes may still be the open tail,
 * and guessing "closed" would run `codeToHtml` on a buffer that is about
 * to grow.
 */
export type FenceTailObservation = "unknown" | "open" | "closed";

export interface FenceHighlightIdentity {
  readonly code: string;
  readonly lang: string;
  readonly theme: string;
}

export type FenceHighlightDecision =
  | { readonly action: "plain" }
  | { readonly action: "reuse"; readonly node: ReactNode }
  | { readonly action: "highlight" };

interface ShownHighlight {
  readonly identity: FenceHighlightIdentity;
  readonly node: ReactNode;
}

/**
 * Whether a fence may run a full highlight, and which result is already on screen.
 *
 * An open tail grows on every stream flush. Highlighting that whole buffer
 * on a timer reruns `codeToHtml` on the main thread for as long as the
 * fence is open, which is longer than a frame once the fence is a source
 * file. The gate keeps that fence plain. The same settled bytes are
 * highlighted once per theme; a later render reuses the node.
 */
export class FenceHighlightGate {
  private shown: ShownHighlight | null = null;

  decide(
    observation: FenceTailObservation,
    identity: FenceHighlightIdentity,
  ): FenceHighlightDecision {
    const shown = this.shown;
    if (shown !== null && sameHighlight(shown.identity, identity)) {
      return { action: "reuse", node: shown.node };
    }
    if (observation !== "closed") return { action: "plain" };
    return { action: "highlight" };
  }

  /** Remember a highlight that actually produced a node. A miss must not stick. */
  commit(identity: FenceHighlightIdentity, node: ReactNode): void {
    this.shown = { identity, node };
  }
}

/**
 * Tail observation for the bytes on screen now.
 *
 * A streaming message's previous observation belongs to the previous
 * string. Reusing it after the fence grows would treat the new buffer as
 * settled and highlight a prefix that is still being written.
 */
export function fenceTailObservation(
  messageStreaming: boolean,
  observed: {
    readonly code: string;
    readonly lang: string;
    readonly tail: "open" | "closed";
  } | null,
  code: string,
  lang: string,
): FenceTailObservation {
  if (!messageStreaming) return "closed";
  if (observed === null || observed.code !== code || observed.lang !== lang) {
    return "unknown";
  }
  return observed.tail;
}

function sameHighlight(
  shown: FenceHighlightIdentity,
  identity: FenceHighlightIdentity,
): boolean {
  return (
    shown.code === identity.code &&
    shown.lang === identity.lang &&
    shown.theme === identity.theme
  );
}
