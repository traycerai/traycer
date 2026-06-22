/**
 * One-shot handoff between artifact creation flows and the collab tile
 * editor. The sidebar "+" actions mark the freshly created artifact id;
 * `CollabTileBodyEditor` consumes the mark when its Tiptap editor mounts
 * and moves focus into the document so the user can start typing
 * immediately.
 *
 * A module-level registry (same shape as `comment-editor-registry`) rather
 * than Zustand state: the signal is consumed exactly once, never rendered,
 * and must not trigger re-renders. The key includes the tab instance id so a
 * failed create/open path cannot steal focus from a later manual open of the
 * same artifact.
 */

const pendingKeys = new Set<string>();

function pendingKey(artifactId: string, instanceId: string): string {
  return `${artifactId}\0${instanceId}`;
}

export function requestArtifactEditorFocus(
  artifactId: string,
  instanceId: string,
): void {
  pendingKeys.add(pendingKey(artifactId, instanceId));
}

export function consumeArtifactEditorFocus(
  artifactId: string,
  instanceId: string,
): boolean {
  const key = pendingKey(artifactId, instanceId);
  if (!pendingKeys.has(key)) return false;
  pendingKeys.delete(key);
  return true;
}
