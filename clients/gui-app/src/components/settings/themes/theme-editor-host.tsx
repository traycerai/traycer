import { lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

const ThemeEditorPanel = lazy(() =>
  import("./theme-editor-panel").then((module) => ({
    default: module.ThemeEditorPanel,
  })),
);

/** Lives above routing, so editing survives navigation; loaded only when a draft opens. */
export function ThemeEditorHost() {
  const draft = useThemeLibraryStore((state) => state.draft);
  return draft
    ? createPortal(
        <Suspense fallback={null}>
          <ThemeEditorPanel draft={draft} />
        </Suspense>,
        document.body,
      )
    : null;
}
