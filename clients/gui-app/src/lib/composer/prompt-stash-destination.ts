import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import type { PromptStashEntry } from "@/lib/composer/prompt-stash-codec";

/**
 * Names the exact active destination surface a restore must land in.
 * Captured before materialization; `importAndInsert` only accepts when the same surface identity *and* the same ready editor incarnation are still the active destination afterward.
 */
export interface PromptStashDestinationIdentity {
  readonly surface: string;
  readonly identity: string;
  /**
   * Opaque in-memory token for the actual Tiptap editor at capture.
   * This must not be the React imperative handle: React Compiler-driven renders may replace that capability facade without replacing the editor.
   */
  readonly editorIncarnation: ComposerEditorIncarnation;
}

export type PromptStashDestinationResult =
  | { readonly status: "accepted" }
  | { readonly status: "stale" };

export interface PromptStashMaterializedContent {
  readonly content: JsonContent;
  /**
   * Optional cleanup the restore hook calls exactly once, right after `importAndInsert` resolves - whatever the result.
   * For a destination whose `materialize` step reserves a resource that must stay held across the async gap (e.g. landing's measured image-budget reservation, held until content is committed or found stale), this is where it releases that reservation.
   */
  readonly release?: () => void;
}

/**
 * Inserts a materialized stash into the canonical owner of a composer surface only when that exact destination is still active.
 * Missing, remounted, or switched destinations return `stale` and never report success.
 */
export interface PromptStashDestinationAdapter {
  /**
   * Stable identity of the currently active destination, or `null` when there is no ready destination to restore into.
   */
  readonly captureIdentity: () => PromptStashDestinationIdentity | null;
  /**
   * Destination-owned materialization of `entry`, for a destination that cannot use the restore hook's default inline-base64 `materializePromptStashEntry` (landing imports straight into its own hash-addressed image store instead).
   */
  readonly materialize?: (
    entry: PromptStashEntry,
  ) => Promise<PromptStashMaterializedContent | null>;
  /**
   * Appends already-materialized content (fresh image ids) against the destination's *latest* canonical content at insertion time.
   * Must not use a pre-materialization content snapshot.
   */
  readonly importAndInsert: (args: {
    readonly identity: PromptStashDestinationIdentity;
    readonly content: JsonContent;
  }) => Promise<PromptStashDestinationResult>;
}
