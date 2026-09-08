import { lazy } from "react";

function loadAppearanceEditor() {
  return import("./appearance-editor");
}

export const LazyAppearanceEditor = lazy(loadAppearanceEditor);
