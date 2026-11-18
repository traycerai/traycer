/**
 * The one base64-strip used at every SERIALIZATION seam.
 *
 * In-memory composer content is CANONICAL and deliberately keeps a paste's
 * still-pending `b64content` node: that node IS the work token its background
 * prepare+hash+`putImage` job is keyed on, and a remount re-ingests it. What
 * must never carry base64 is anything written to LOCAL STORAGE — the persisted
 * drafts and the desktop per-window projection — because that is where a single
 * paste turned into multi-megabyte writes that then reloaded on every launch.
 *
 * Every such seam calls this, and no store applies it on the way IN. Today that
 * is the landing draft store (persist `partialize` + the desktop projection),
 * the chat composer draft store and the initial-chat handoff store. A hash-only
 * node, whose bytes are durable in the composer image store, always survives.
 *
 * DELIBERATELY NOT APPLIED to the host draft mirror's write, even though that is
 * also a serialization seam and `drafts.upsert` bodies are what the byte
 * accounting cares most about. A mirror write is ECHOED BACK: the host can
 * return the document it was just sent, and `applyComposerHostDocument` only
 * declines to overwrite `content` while the local draft is DIRTY — which the
 * write itself just stopped being. Stripping there would let that echo delete a
 * pending node whose ingest is still running, losing both the work token and the
 * image; leaving the b64 in means the echo replaces the node with an identical
 * one under the same id, which the in-flight job and the re-entry sweep both
 * handle. The steady state is unaffected either way: a mirror write lands after
 * the sub-second ingest in every ordinary case, and carries the hash.
 *
 * ACCEPTED IMPERFECTION, unchanged from when the landing composer owned this
 * alone: a process exit (quit or crash) inside the sub-second ingest window
 * omits that paste's image from the serialized form, because its b64 node has
 * not become a hash yet.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";

import { EMPTY_LANDING_DRAFT_CONTENT } from "@/stores/home/landing-draft-content";

export function stripBase64ImageNodes(content: JsonContent): JsonContent {
  const stripped = stripBase64ImageNode(content);
  if (stripped === null) return EMPTY_LANDING_DRAFT_CONTENT;
  // A `doc` requires at least one block child, so a document whose only child
  // was a legacy `attachmentGroup` of pending b64 nodes strips to `content: []`
  // - a shape the editor's own schema rejects. It is not a bad draft, it is an
  // unopenable one: `useEditor` throws while building it, so the composer that
  // restores this draft fails to mount rather than coming up empty.
  //
  // The `null` arm above is the same answer for a root that was stripped away
  // entirely; this one covers a root that SURVIVED with nothing left inside it,
  // which is the case the `??` could not see because an empty doc is not null.
  if (stripped.type === "doc" && (stripped.content?.length ?? 0) === 0) {
    return EMPTY_LANDING_DRAFT_CONTENT;
  }
  return stripped;
}

/**
 * The strip, with the caret decision that has to travel WITH it.
 *
 * A selection is a pair of ProseMirror positions, and positions count nodes -
 * so dropping a pending image node ahead of the caret shifts every position
 * after it. Persisting the stripped document beside the unstripped caret
 * restores it somewhere else in the text, or out of range entirely.
 *
 * Every seam that strips for serialization also persists a caret, so the two
 * decisions are made here together rather than left for each seam to remember
 * separately - three of them did not, in three different files.
 *
 * The caret is DROPPED rather than rebased, on purpose. Rebasing needs real
 * positions, which needs the schema and a built document; this runs inside a
 * `partialize`, on plain JSON, for a case that only arises when the process
 * exits inside the sub-second ingest window. That window already loses the
 * image itself (the accepted imperfection above), so a lost caret in the same
 * window costs nothing next to the risk of restoring a wrong one. It is
 * conservative in the other direction too: the caret goes even when the removed
 * node sat AFTER it and its positions would have survived.
 */
export function stripBase64ImageNodesWithSelection<TSelection>(
  content: JsonContent,
  selection: TSelection | null,
): { readonly content: JsonContent; readonly selection: TSelection | null } {
  // The caret is keyed on REFERENCE IDENTITY, which is the walker's own answer
  // to "did the tree change" rather than a second opinion about it.
  //
  // A separate `containsBase64ImageNodes(content)` predicate stood here and was
  // subtly wrong, in a way worth keeping written down: the walk removes an
  // `attachmentGroup` that is ALREADY empty, and an already-empty group holds no
  // b64 node for such a predicate to find. So the content half stripped the
  // group while the caret half declared nothing had changed and kept a position
  // that every later node had just shifted under.
  //
  // Any predicate that answers this question by re-deriving it has to be kept in
  // step with the walker by hand, forever, and this one had already fallen out
  // of step. `stripBase64ImageNode` now returns its input unchanged when it
  // changes nothing, so `stripped === content` IS "the tree is untouched" - not
  // a proxy for it - and a new arm in the walker cannot silently escape it.
  const stripped = stripBase64ImageNodes(content);
  return {
    content: stripped,
    selection: stripped === content ? selection : null,
  };
}

function stripBase64ImageNode(node: JsonContent): JsonContent | null {
  if (node.type === "imageAttachment") {
    return typeof node.attrs?.b64content === "string" ? null : node;
  }
  const children = node.content;
  if (children === undefined) return node;
  // Deliberately not a `let changed = false` mutated inside the callback:
  // TypeScript does not track an assignment made inside a function expression,
  // so such a flag keeps its literal `false` type at the return below and the
  // ternary reads as statically dead - correct at runtime, a lie in the types,
  // and `no-unnecessary-condition` is right to reject it.
  const strippedChildren = children.map(stripBase64ImageNode);
  const changed = strippedChildren.some(
    (stripped, index) => stripped !== children[index],
  );
  const nextChildren = strippedChildren.flatMap((stripped) =>
    stripped === null ? [] : [stripped],
  );
  // An `attachmentGroup` whose every child was a pending b64 node is left empty
  // by the strip, and the legacy leading-group shape is not valid empty - drop
  // the group with its last child. A group that arrived empty takes the same
  // exit, which is why this is a change the caller must hear about even though
  // no b64 node was involved.
  if (node.type === "attachmentGroup" && nextChildren.length === 0) return null;
  // Returning the input node when nothing changed is what makes identity a
  // usable signal upstream; it also skips the allocation on every persist of
  // every draft that is not mid-paste, which is nearly all of them.
  return changed ? { ...node, content: nextChildren } : node;
}
