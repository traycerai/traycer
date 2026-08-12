import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import type { PromptStashEntry } from "@/lib/composer/prompt-stash-codec";

/**
 * Names the exact active destination surface a restore must land in.
 * Captured before materialization; `importAndInsert` only accepts when the
 * same surface identity *and* the same ready editor incarnation are still the
 * active destination afterward. A remounted editor under the same task/draft
 * /epic id is a different incarnation and must be treated as stale.
 */
export interface PromptStashDestinationIdentity {
  readonly surface: string;
  readonly identity: string;
  /**
   * Opaque in-memory token for the actual Tiptap editor at capture. This must
   * not be the React imperative handle: React Compiler-driven renders may
   * replace that capability facade without replacing the editor.
   */
  readonly editorIncarnation: ComposerEditorIncarnation;
}

export type PromptStashDestinationResult =
  { readonly status: "accepted" } | { readonly status: "stale" };

export interface PromptStashMaterializedContent {
  readonly content: JsonContent;
  /**
   * Optional cleanup the restore hook calls exactly once, right after
   * `importAndInsert` resolves - whatever the result. For a destination
   * whose `materialize` step reserves a resource that must stay held across
   * the async gap (e.g. landing's measured image-budget reservation, held
   * until content is committed or found stale), this is where it releases
   * that reservation.
   */
  readonly release?: () => void;
}

/**
 * Inserts a materialized stash into the canonical owner of a composer
 * surface only when that exact destination is still active. Missing,
 * remounted, or switched destinations return `stale` and never report
 * success.
 */
export interface PromptStashDestinationAdapter {
  /**
   * Stable identity of the currently active destination, or `null` when there
   * is no ready destination to restore into.
   */
  readonly captureIdentity: () => PromptStashDestinationIdentity | null;
  /**
   * Destination-owned materialization of `entry`, for a destination that
   * cannot use the restore hook's default inline-base64
   * `materializePromptStashEntry` (landing imports straight into its own
   * hash-addressed image store instead). Omit to use the default.
   *
   * Runs through whichever adapter generation the hook captured when
   * `restore()` started - the async gap this performs (blob resolution,
   * writes) has no freshness requirement of its own, because the hook always
   * invokes `importAndInsert` afterward through the *freshest* adapter
   * generation, exactly as it does for the default path. That second,
   * freshly-read call is what actually enforces the exact-destination
   * guarantee; this step only produces its input.
   *
   * `null` reports a materialization failure the destination can identify
   * (e.g. a landing budget or write rejection) - treated exactly like an
   * `importAndInsert` "failed": the stash is kept. A source-read failure (a
   * missing stash blob) throws instead, matching the default path.
   */
  readonly materialize?: (
    entry: PromptStashEntry,
  ) => Promise<PromptStashMaterializedContent | null>;
  /**
   * Appends already-materialized content (fresh image ids) against the
   * destination's *latest* canonical content at insertion time. Must not use
   * a pre-materialization content snapshot. Optional-chained missing/unready
   * editors are `stale`, never `accepted`. A ready handle that is not the
   * captured incarnation is also `stale`. A replacement handle facade for the
   * same incarnation is accepted and used as the freshest capability object.
   * The destination places the caret at the end of the resulting document;
   * editor selection is transient state and is never persisted with a stash,
   * so it cannot make the next keystroke overwrite restored content.
   */
  readonly importAndInsert: (args: {
    readonly identity: PromptStashDestinationIdentity;
    readonly content: JsonContent;
  }) => Promise<PromptStashDestinationResult>;
}
