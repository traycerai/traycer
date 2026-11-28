import { useEffect, useReducer, useState, type ReactNode } from "react";
import {
  useIsMarkdownStreaming,
  type HighlightOutput,
  type StreamingHighlighter,
} from "@tailmark/react";
import { resolveActiveShikiTheme } from "./shiki-highlighter";
import {
  FenceHighlightGate,
  fenceTailObservation,
  type FenceHighlightIdentity,
  type FenceTailObservation,
} from "./fence-highlight-gate";

/** Tailmark marks the block it is still appending to with this attribute. */
const STREAMING_TAIL_SELECTOR = "[data-md-streaming]";

interface ComputedFenceHighlight {
  readonly node: ReactNode;
  readonly fresh: HighlightOutput | null;
}

interface TailSnapshot {
  readonly code: string;
  readonly lang: string;
  readonly tail: "open" | "closed";
}

/**
 * Highlight a fence once `codeToHtml` will not have to run again for the
 * same bytes.
 *
 * While the fence is the open tail, the hook returns plain text. Tailmark's
 * own throttle would otherwise highlight the whole buffer about every
 * 150ms, and a source-sized fence takes longer than that gap, so the
 * window cannot paint. The highlight runs when this block leaves the tail,
 * or when the message finishes and renders the fence one last time.
 */
export function useClosedFenceHighlight(
  code: string,
  lang: string,
  highlighter: StreamingHighlighter | null,
  root: HTMLElement | null,
): ReactNode | null {
  const messageStreaming = useIsMarkdownStreaming();
  // One gate for the life of this fence. It is not a ref: render reads it
  // to decide whether `codeToHtml` may run.
  const [gate] = useState(() => new FenceHighlightGate());
  // The dispatch re-renders when the core or the theme becomes ready.
  // The count itself is unused; the gate decides whether that render
  // highlights or reuses the node already on screen.
  const [, notifyReady] = useReducer((version: number) => version + 1, 0);
  const [observed, setObserved] = useState<TailSnapshot | null>(null);

  useEffect(() => {
    if (highlighter === null) return;
    return highlighter.subscribe(notifyReady);
  }, [highlighter]);

  // Closing a fence often leaves the code string unchanged; only the
  // following block is new. The tail marker is removed on an ancestor,
  // which this effect is not a dependency of, so watch the marker itself.
  useEffect(() => {
    if (!messageStreaming || root === null) return;
    const publish = () => {
      const tail: TailSnapshot["tail"] = isOpenStreamingTail(root)
        ? "open"
        : "closed";
      setObserved((current) =>
        current !== null &&
        current.code === code &&
        current.lang === lang &&
        current.tail === tail
          ? current
          : { code, lang, tail },
      );
    };
    publish();
    const host = root.closest("[data-tailmark]");
    if (host === null) return;
    const observer = new MutationObserver(publish);
    observer.observe(host, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-md-streaming"],
    });
    return () => {
      observer.disconnect();
    };
  }, [messageStreaming, root, code, lang]);

  const observation = fenceTailObservation(
    messageStreaming,
    observed,
    code,
    lang,
  );

  const highlight = resolveFenceHighlight({
    gate,
    highlighter,
    observation,
    code,
    lang,
  });

  const fresh = highlight?.fresh ?? null;
  useEffect(() => {
    if (highlighter === null || fresh === null) return;
    highlighter.setCached(code, lang, fresh);
  }, [highlighter, code, lang, fresh]);

  return highlight?.node ?? null;
}

function isOpenStreamingTail(root: HTMLElement): boolean {
  return root.closest(STREAMING_TAIL_SELECTOR) !== null;
}

interface FenceHighlightRequest {
  readonly gate: FenceHighlightGate;
  readonly highlighter: StreamingHighlighter | null;
  readonly observation: FenceTailObservation;
  readonly code: string;
  readonly lang: string;
}

function resolveFenceHighlight(
  request: FenceHighlightRequest,
): ComputedFenceHighlight | null {
  const { gate, highlighter, observation, code, lang } = request;
  if (highlighter === null) return null;
  const identity: FenceHighlightIdentity = {
    code,
    lang,
    theme: resolveActiveShikiTheme(),
  };
  const decision = gate.decide(observation, identity);
  if (decision.action === "plain") return null;
  if (decision.action === "reuse") {
    return { node: decision.node, fresh: null };
  }
  const computed = computeFenceHighlight(highlighter, code, lang);
  if (computed === null) return null;
  gate.commit(identity, computed.node);
  return computed;
}

function computeFenceHighlight(
  highlighter: StreamingHighlighter,
  code: string,
  lang: string,
): ComputedFenceHighlight | null {
  const cached = highlighter.getCached(code, lang);
  if (cached !== null) return { node: cached, fresh: null };
  const output = highlighter.highlight(code, lang);
  if (output === null) return null;
  return { node: output.node, fresh: output };
}
