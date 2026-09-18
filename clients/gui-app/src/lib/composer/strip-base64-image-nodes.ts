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
  return stripBase64ImageNode(content) ?? EMPTY_LANDING_DRAFT_CONTENT;
}

/**
 * Whether `content` still holds a pending base64 image node - i.e. whether
 * {@link stripBase64ImageNodes} would change it. Lets a caller skip both the
 * walk and the fresh object when there is nothing to strip, which is the
 * overwhelmingly common case (every persist of every draft that is not mid
 * paste).
 */
export function containsBase64ImageNodes(content: JsonContent): boolean {
  if (content.type === "imageAttachment") {
    return typeof content.attrs?.b64content === "string";
  }
  const children = content.content;
  if (children === undefined) return false;
  return children.some(containsBase64ImageNodes);
}

function stripBase64ImageNode(node: JsonContent): JsonContent | null {
  if (node.type === "imageAttachment") {
    return typeof node.attrs?.b64content === "string" ? null : node;
  }
  const children = node.content;
  if (children === undefined) return node;
  const nextChildren = children.flatMap((child) => {
    const stripped = stripBase64ImageNode(child);
    return stripped === null ? [] : [stripped];
  });
  // An `attachmentGroup` whose every child was a pending b64 node is left empty
  // by the strip, and the legacy leading-group shape is not valid empty - drop
  // the group with its last child.
  if (node.type === "attachmentGroup" && nextChildren.length === 0) return null;
  return { ...node, content: nextChildren };
}
