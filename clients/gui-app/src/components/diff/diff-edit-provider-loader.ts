import type { Editor, EditorOptions } from "@pierre/diffs/edit";

type DiffEditModule = typeof import("@pierre/diffs/edit");

let editModule: DiffEditModule | null = null;
let editModulePromise: Promise<DiffEditModule> | null = null;

export function loadDiffEditProvider(): Promise<DiffEditModule> {
  editModulePromise ??= import("@pierre/diffs/edit")
    .then((loaded) => {
      editModule = loaded;
      return loaded;
    })
    .catch((error: unknown) => {
      editModulePromise = null;
      throw error;
    });
  return editModulePromise;
}

/** Warm the beta editor chunk while the pointer is over editable code. */
export async function preloadDiffEditProvider(): Promise<void> {
  await loadDiffEditProvider();
}

export function createPreloadedDiffEditor(
  options: EditorOptions<undefined>,
): Editor<undefined> {
  const EditorConstructor = editModule?.Editor;
  if (EditorConstructor === undefined) {
    throw new Error(
      "The Diffs editor was attached before its interaction preload completed.",
    );
  }
  return new EditorConstructor(options);
}
