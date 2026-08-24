/**
 * Tri-state parent identity for a provider-native sub-agent run, and its
 * projection onto the `parentBlockId` field of a `subagent.*` runtime event.
 * Shared by the harness converters (Codex, OpenCode, …) so every producer
 * spells the three states the same way the accumulator reads them
 * (`resolveParentBlockId` in `agent-runtime-accumulator.ts`):
 *
 *   - `unresolved` → the key is OMITTED. The accumulator preserves whatever
 *     parent the card already carries; a late re-emit never un-nests a card by
 *     accident while the producer has not yet learned the owner.
 *   - `root`       → `parentBlockId: null`. A positively confirmed top-level
 *     child of the root execution.
 *   - `subagent`   → `parentBlockId: <owning run id>`. A confirmed nested child.
 *
 * A `string | null` on its own cannot express the first state, and emitting a
 * late `null` for "unknown" would silently hoist a nested card to top level.
 */
export type ParentResolution =
  | { readonly kind: "unresolved" }
  | { readonly kind: "root" }
  | { readonly kind: "subagent"; readonly runId: string };

export function parentBlockIdForEvent(parent: ParentResolution): {
  readonly parentBlockId?: string | null;
} {
  switch (parent.kind) {
    case "unresolved":
      return {};
    case "root":
      return { parentBlockId: null };
    case "subagent":
      return { parentBlockId: parent.runId };
  }
}
