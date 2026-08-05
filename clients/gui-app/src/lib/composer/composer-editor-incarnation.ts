/**
 * Opaque identity for one live editor incarnation.
 *
 * React owns the imperative handle facade, so that facade may be replaced
 * during an ordinary render. The Tiptap Editor object is the actual lifecycle
 * boundary: it stays stable for the lifetime of one mounted editor and is
 * replaced when that editor is genuinely recreated.
 */
const composerEditorIncarnationBrand = Symbol("composer-editor-incarnation");

export interface ComposerEditorIncarnation {
  readonly [composerEditorIncarnationBrand]: true;
}

/** Allocate an incarnation token for an editor lifecycle owner. */
export function createComposerEditorIncarnation(): ComposerEditorIncarnation {
  const created: ComposerEditorIncarnation = {
    [composerEditorIncarnationBrand]: true,
  };
  Object.freeze(created);
  return created;
}
