/**
 * A document-aware `ComposerHashFirstEditorHandle` fixture shared by the
 * hash-first paste hook suites. Unlike a set of constant-returning stubs,
 * this one actually holds image nodes keyed by id: `rewriteImageAttachmentHashById`
 * looks the id up and returns `false` when it isn't there (mirroring the real
 * ProseMirror command in `image-attachment-extension.ts`), which is what lets
 * a test on top of it fail when the hook doesn't do what it claims.
 */
import type { ComposerHashFirstEditorHandle } from "@/hooks/composer/use-composer-hash-first-paste";
import type {
  ImageAttachmentAttrs,
  ImageAttachmentRewrite,
} from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type { JsonContent } from "@traycer/protocol/common/registry";

export interface DocumentAwareEditor {
  readonly handle: ComposerHashFirstEditorHandle;
  readonly rewrites: ImageAttachmentRewrite[];
  readonly removedIds: string[];
  readonly inserted: ImageAttachmentAttrs[];
  readonly imageNode: (id: string) => Record<string, unknown> | undefined;
  readonly getJSON: () => JsonContent;
}

export function documentAwareEditor(
  initialImages: ReadonlyArray<ImageAttachmentAttrs>,
): DocumentAwareEditor {
  const rewrites: ImageAttachmentRewrite[] = [];
  const removedIds: string[] = [];
  const inserted: ImageAttachmentAttrs[] = [];
  const images = new Map<string, Record<string, unknown>>();
  for (const attrs of initialImages) images.set(attrs.id, { ...attrs });

  const getJSON = (): JsonContent => ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: Array.from(images.values()).map((attrs) => ({
          type: "imageAttachment",
          attrs,
        })),
      },
    ],
  });

  const handle: ComposerHashFirstEditorHandle = {
    isReady: () => true,
    insertImageAttachments: (attrs) => {
      for (const attachment of attrs) {
        images.set(attachment.id, { ...attachment });
        inserted.push(attachment);
      }
    },
    beginPathInsertion: () => null,
    focus: () => undefined,
    getJSON,
    removeImageAttachmentById: (id) => {
      if (images.delete(id)) removedIds.push(id);
    },
    rewriteImageAttachmentHashById: (id, rewrite) => {
      const existing = images.get(id);
      if (existing === undefined) return false;
      images.set(id, {
        ...existing,
        hash: rewrite.hash,
        fileName: rewrite.fileName,
        mimeType: rewrite.mimeType,
        size: rewrite.size,
        byHashEligible: rewrite.byHashEligible,
        b64content: null,
      });
      rewrites.push(rewrite);
      return true;
    },
  };

  return {
    handle,
    rewrites,
    removedIds,
    inserted,
    getJSON,
    imageNode: (id) => images.get(id),
  };
}
