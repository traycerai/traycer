/** Opaque identity for one live editor incarnation. */
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
