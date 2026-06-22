import { createContext, use } from "react";

/**
 * Whether the surrounding markdown surface is still streaming. Provided by
 * `TraycerMarkdown` from its `isStreaming` prop and read by `CodeBlock` to
 * pick the streaming highlight path (trailing-edge throttle, settle-gated
 * cache writes) over the settled one (synchronous + MRU-cached).
 *
 * The flag is message-scoped, not block-scoped: every code block in a
 * streaming message observes `true`. The value only CHANGES at the
 * settle flip, so memoized settled blocks are not re-rendered by the
 * context while the tail grows - and the flip itself lands on warm cache
 * entries (see `use-throttled-code-highlight.ts`). Defaults to `false`:
 * surfaces that never stream need no wiring. Component-free module per the
 * repo's `*-context.ts` convention.
 */
export const MarkdownStreamingContext = createContext<boolean>(false);

export function useIsMarkdownStreaming(): boolean {
  return use(MarkdownStreamingContext);
}
