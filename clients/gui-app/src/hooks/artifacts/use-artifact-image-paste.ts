import { useCallback, useMemo } from "react";
import type { Editor } from "@tiptap/core";
import { MAX_ARTIFACT_IMAGE_BYTES } from "@traycer/protocol/host/epic/unary-schemas";
import { useComposerPasteEvents } from "@/hooks/composer/use-composer-paste";
import type {
  ComposerImageConversionResult,
  ComposerImageIngest,
  PathInsertionCommit,
  UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";
import { insertPathSpansCommand } from "@/hooks/composer/use-composer-paste";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useArtifactImageOperations } from "./use-artifact-image-operations";

export interface PreparedArtifactImage {
  readonly operationId: string;
  readonly src: string;
  readonly alt: string;
  readonly attachmentHash: string;
}

export interface ArtifactImagePasteResult {
  readonly supported: boolean;
  readonly paste: UseComposerPasteResult;
}

function removeArtifactImage(
  editor: Editor,
  image: PreparedArtifactImage,
): void {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (
      node.type.name === "image" &&
      node.attrs.src === image.src &&
      node.attrs.alt === image.alt &&
      node.attrs.attachmentHash === image.attachmentHash
    ) {
      positions.push(pos);
    }
    return true;
  });
  const position = positions.at(-1);
  if (position === undefined) return;
  editor.view.dispatch(editor.state.tr.delete(position, position + 1));
}

export function useArtifactImagePaste(
  editor: Editor | null,
  epicId: string,
  artifactId: string,
): ArtifactImagePasteResult {
  const runnerHost = useRunnerHost();
  const operations = useArtifactImageOperations(epicId);

  const finishOperation = useCallback(
    async (operationId: string, commit: boolean): Promise<boolean> => {
      return operations.finish(artifactId, operationId, commit);
    },
    [artifactId, operations],
  );

  const imageIngest = useMemo(
    (): ComposerImageIngest<PreparedArtifactImage> => ({
      convert: async (
        files,
        signal,
      ): Promise<ComposerImageConversionResult<PreparedArtifactImage>> => {
        const prepared: PreparedArtifactImage[] = [];
        try {
          for (const file of files) {
            if (!file.type.startsWith("image/")) continue;
            if (file.size > MAX_ARTIFACT_IMAGE_BYTES) {
              throw new Error(
                `${file.name || "Image"} exceeds the 30 MB artifact image limit.`,
              );
            }
            signal.throwIfAborted();
            const response = await operations.prepareBytes(
              new Uint8Array(await file.arrayBuffer()),
            );
            prepared.push({
              operationId: response.operationId,
              src: response.src,
              alt: file.name || "Image",
              attachmentHash: response.attachmentHash,
            });
            signal.throwIfAborted();
          }
          return {
            attrs: prepared,
            release: () => {
              prepared.forEach((image) => {
                void finishOperation(image.operationId, false).catch(() => {});
              });
            },
          };
        } catch (error) {
          await Promise.allSettled(
            prepared.map((image) => finishOperation(image.operationId, false)),
          );
          throw error;
        }
      },
      onSettled: async (accepted, converted) => {
        const acceptedIds = new Set(accepted.map((image) => image.operationId));
        await Promise.allSettled(
          converted
            .filter((image) => !acceptedIds.has(image.operationId))
            .map((image) => finishOperation(image.operationId, false)),
        );
        for (const image of accepted) {
          try {
            const committed = await finishOperation(image.operationId, true);
            if (committed) continue;
          } catch (error) {
            if (editor !== null && !editor.isDestroyed) {
              removeArtifactImage(editor, image);
            }
            throw error;
          }
          if (editor !== null && !editor.isDestroyed) {
            removeArtifactImage(editor, image);
          }
          throw new Error("The artifact image could not be committed.");
        }
      },
      onRejected: (error, aborted) => {
        if (aborted) return;
        reportableErrorToast(
          "Couldn't add the image to this artifact.",
          {
            description:
              error instanceof Error ? error.message : "Please try again.",
          },
          {
            title: "Could not add artifact image",
            message: error instanceof Error ? error.message : null,
            code: null,
            source: "Artifact editor",
          },
        );
      },
    }),
    [editor, finishOperation, operations],
  );

  const insertAttrs = useCallback(
    (images: ReadonlyArray<PreparedArtifactImage>): number => {
      if (editor === null || editor.isDestroyed || !editor.isEditable) return 0;
      const inserted = editor
        .chain()
        .focus()
        .insertContent(
          images.map((image) => ({
            type: "image",
            attrs: {
              src: image.src,
              alt: image.alt,
              attachmentHash: image.attachmentHash,
            },
          })),
        )
        .run();
      return inserted ? images.length : 0;
    },
    [editor],
  );
  const beginPathInsertion = useCallback((): PathInsertionCommit | null => {
    if (editor === null || editor.isDestroyed || !editor.isEditable)
      return null;
    const position = editor.state.selection.from;
    return (paths) => {
      if (editor.isDestroyed) return false;
      insertPathSpansCommand(editor, { paths, position });
      return true;
    };
  }, [editor]);
  const filePaths = useMemo(
    () => ({
      fileDrops: runnerHost.fileDrops,
      mentionRoots: [],
      beginPathInsertion,
    }),
    [beginPathInsertion, runnerHost.fileDrops],
  );
  const paste = useComposerPasteEvents(imageIngest, insertAttrs, filePaths);
  return { supported: operations.supported, paste };
}
