import { useCallback, useMemo } from "react";
import type { Editor } from "@tiptap/core";
import { MAX_ARTIFACT_IMAGE_BYTES } from "@traycer/protocol/host/epic/unary-schemas";
import { useComposerPasteEvents } from "@/hooks/composer/use-composer-paste";
import type {
  ComposerImageConversionResult,
  ComposerImageIngest,
  UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";
import { commitArtifactImageWithRetry } from "./commit-artifact-image-with-retry";
import { useArtifactImageOperations } from "./use-artifact-image-operations";

export interface PreparedArtifactImage {
  readonly operationId: string;
  readonly src: string;
  readonly alt: string;
  readonly attachmentHash: string;
  readonly mediaType: string;
  abortPending: boolean;
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

  const commitOperation = useCallback(
    (operationId: string) =>
      commitArtifactImageWithRetry(operations.commit, artifactId, operationId),
    [artifactId, operations],
  );
  const abortOperation = useCallback(
    (operationId: string) => operations.abort(artifactId, operationId),
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
              mediaType: response.mediaType,
              abortPending: true,
            });
            signal.throwIfAborted();
          }
          return {
            attrs: prepared,
            release: () => {
              prepared
                .filter((image) => image.abortPending)
                .forEach((image) => {
                  void abortOperation(image.operationId)
                    .then(() => {
                      image.abortPending = false;
                    })
                    .catch(() => {});
                });
            },
          };
        } catch (error) {
          await Promise.allSettled(
            prepared.map(async (image) => {
              await abortOperation(image.operationId);
              image.abortPending = false;
            }),
          );
          throw error;
        }
      },
      onSettled: async (accepted, converted) => {
        const acceptedIds = new Set(accepted.map((image) => image.operationId));
        await Promise.allSettled(
          converted
            .filter((image) => !acceptedIds.has(image.operationId))
            .map(async (image) => {
              await abortOperation(image.operationId);
              image.abortPending = false;
            }),
        );
        const results = await Promise.allSettled(
          accepted.map((image) => commitOperation(image.operationId)),
        );
        let failure: Error | null = null;
        for (const [index, result] of results.entries()) {
          const image = accepted[index];
          if (result.status === "fulfilled") {
            image.abortPending = false;
            continue;
          }
          void abortOperation(image.operationId).catch(() => {});
          image.abortPending = false;
          failure ??=
            result.reason instanceof Error
              ? result.reason
              : new Error("The artifact image could not be committed.");
          if (editor !== null && !editor.isDestroyed) {
            removeArtifactImage(editor, image);
          }
        }
        if (failure !== null) throw failure;
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
    [abortOperation, commitOperation, editor, operations],
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
              mediaType: image.mediaType,
            },
          })),
        )
        .run();
      return inserted ? images.length : 0;
    },
    [editor],
  );
  const beginPathInsertion = useCallback((): null => null, []);
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
