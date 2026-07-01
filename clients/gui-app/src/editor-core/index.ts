export {
  buildArtifactExtensions,
  ARTIFACT_EDITOR_CONTENT_CLASS,
  type BuildArtifactExtensionsParams,
  type ArtifactAwarenessProvider,
} from "./extensions/build-artifact-extensions";

export {
  deriveCollabUser,
  hashUserIdToColorIndex,
  COLLAB_COLOR_PALETTE,
  type CollabAuthUser,
  type CollabUser,
} from "./awareness/derive-collab-user";

export {
  ArtifactToolbar,
  type ArtifactToolbarProps,
  type ArtifactCommentAction,
} from "./toolbar/artifact-toolbar";

export { MermaidNode } from "./nodes/mermaid";
export type { MermaidAttrs } from "./nodes/mermaid";

export { WireframeNode } from "./nodes/wireframe";
export type { WireframeAttrs } from "./nodes/wireframe";

export { ThreadAnchor } from "./extensions/thread-anchor";
export {
  CommentDecorationsExtension,
  applyCommentDecorationSnapshot,
  commentDecorationsPluginKey,
  type CommentDecorationSnapshot,
} from "./extensions/comment-decorations-extension";
export {
  CommentShortcutExtension,
  type CommentShortcutExtensionOptions,
} from "./extensions/comment-shortcut-extension";
export {
  ArtifactFindExtension,
  artifactFindPluginKey,
  applyArtifactFindSearch,
  calculateArtifactFindMatches,
  clearArtifactFind,
  findNearestArtifactFindMatchIndex,
  getArtifactFindState,
  hasArtifactFindTransactionMeta,
  setArtifactFindCurrent,
  setArtifactFindSearchMeta,
  type ArtifactFindMatch,
  type ArtifactFindPluginState,
  type ArtifactFindSearchParams,
} from "./extensions/artifact-find-extension";
