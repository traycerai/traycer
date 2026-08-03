/**
 * Shared fixtures for the useLandingComposerPaste split suites.
 * Mock mechanics (vi.mock, hoisted maps) stay in each test module.
 */
import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";
import type { ComposerPasteEditorHandle } from "@/hooks/composer/use-composer-paste";

// Default fixture for tests that don't care about file-path resolution at
// all (pure image-ingest coverage): every resolve/copy call comes back
// empty, and path spans are discarded.
export const NOOP_FILE_DROPS: IFileDropHost = {
  resolveDroppedFilePaths: () => Promise.resolve([]),
  copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
  readNativeClipboardFilePaths: () => Promise.resolve([]),
};

export const NO_MENTION_ROOTS: ReadonlyArray<string> = [];

export function makeHandle(
  inserted: ImageAttachmentAttrs[][],
  insertedPaths: ReadonlyArray<string>[],
): {
  readonly handle: ComposerPasteEditorHandle;
  readonly focusCalls: { count: number };
} {
  const focusCalls = { count: 0 };
  const handle: ComposerPasteEditorHandle = {
    isReady: () => true,
    insertImageAttachments: (attrs) => inserted.push([...attrs]),
    // Paths commit independently of image insertion (A1: mixed may be 2 undo steps).
    beginPathInsertion: () => (paths) => {
      if (paths.length > 0) {
        insertedPaths.push([...paths]);
        focusCalls.count += 1;
      }
      return true;
    },
    focus: () => {
      focusCalls.count += 1;
    },
  };
  return { handle, focusCalls };
}
