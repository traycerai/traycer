import { useCallback, useMemo } from "react";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { MAX_ARTIFACT_IMAGE_BYTES } from "@traycer/protocol/host/epic/unary-schemas";
import * as Y from "yjs";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { hostWriteFailureOutcome } from "@/lib/host/host-write-outcome";
import { toastIndeterminateHostWrite } from "@/lib/owner-host-write-error-toast";
import { useComposerPasteEvents } from "@/hooks/composer/use-composer-paste";
import type {
  ComposerImageConversionResult,
  ComposerImageIngest,
  ComposerImageInsertion,
  UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
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

const insertedArtifactImages = new WeakMap<
  PreparedArtifactImage,
  Y.XmlElement
>();

function collaborationFragment(editor: Editor): Y.XmlFragment | null {
  const collaboration = editor.extensionManager.extensions.find(
    (extension) => extension.name === "collaboration",
  );
  const options: unknown = collaboration?.options;
  if (typeof options !== "object" || options === null) return null;
  if (!("fragment" in options)) return null;
  const fragment: unknown = options.fragment;
  return fragment instanceof Y.XmlFragment ? fragment : null;
}

function imageElements(parent: Y.XmlFragment | Y.XmlElement): Y.XmlElement[] {
  const images: Y.XmlElement[] = [];
  for (const child of parent.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === "image") images.push(child);
    images.push(...imageElements(child));
  }
  return images;
}

function removeYImage(image: Y.XmlElement): boolean {
  const parent = image.parent;
  if (!(parent instanceof Y.XmlFragment || parent instanceof Y.XmlElement)) {
    return false;
  }
  const index = parent.toArray().indexOf(image);
  if (index < 0) return false;
  parent.delete(index, 1);
  return true;
}

function removeArtifactImage(
  editor: Editor | null,
  image: PreparedArtifactImage,
): void {
  const inserted = insertedArtifactImages.get(image);
  if (inserted !== undefined) {
    insertedArtifactImages.delete(image);
    removeYImage(inserted);
    return;
  }
  if (editor === null || editor.isDestroyed) return;
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
  const client = useEpicSessionHostClient();
  const hostId = useEpicSessionHostId();

  const commitOperation = useCallback(
    (operationId: string) =>
      commitArtifactImageWithRetry(operations.commit, artifactId, operationId),
    [artifactId, operations],
  );
  const abortOperation = useCallback(
    (operationId: string) => operations.abort(artifactId, operationId),
    [artifactId, operations],
  );
  const verifyPoolAttachment = useCallback(
    async (hash: string, userId: string | null): Promise<boolean> => {
      if (
        userId === null ||
        !authorizesCloudCapability(useAuthStore.getState().status) ||
        client?.getActiveHostId() !== POOL_HOST_ID ||
        client.getRequestContextUserId() !== userId
      )
        return false;
      return client
        .request("epic.fetchArtifactAttachment", {
          epicId,
          artifactId,
          hash,
        })
        .then(
          (response) => response.ok,
          () => false,
        );
    },
    [artifactId, client, epicId],
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
        const userId = client?.getRequestContextUserId() ?? null;
        const results = await Promise.allSettled(
          accepted.map((image) => commitOperation(image.operationId)),
        );
        const failures = await Promise.all(
          results.map(async (result, index): Promise<Error | null> => {
            const image = accepted[index];
            image.abortPending = false;
            if (result.status === "fulfilled") return null;

            const cause: unknown = result.reason;
            if (
              hostId === POOL_HOST_ID &&
              cause instanceof HostRpcError &&
              hostWriteFailureOutcome(cause, hostId) === "unknown"
            ) {
              // Verify the bytes through the requester that sent Finish.
              if (await verifyPoolAttachment(image.attachmentHash, userId))
                return null;
              removeArtifactImage(editor, image);
              return new Error("The artifact image could not be committed.");
            }

            void abortOperation(image.operationId).catch(() => {});
            removeArtifactImage(editor, image);
            return cause instanceof Error
              ? cause
              : new Error("The artifact image could not be committed.");
          }),
        );
        const failure = failures.find((error) => error !== null);
        if (failure !== undefined) throw failure;
      },
      onRejected: (error, aborted) => {
        if (
          hostId === POOL_HOST_ID &&
          error instanceof HostRpcError &&
          hostWriteFailureOutcome(error, hostId) === "unknown"
        ) {
          toastIndeterminateHostWrite();
          return;
        }
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
    [
      abortOperation,
      client,
      commitOperation,
      editor,
      hostId,
      operations,
      verifyPoolAttachment,
    ],
  );

  const insertAttrs = useCallback(
    (images: ReadonlyArray<PreparedArtifactImage>): number => {
      if (editor === null || editor.isDestroyed || !editor.isEditable) return 0;
      const fragment = collaborationFragment(editor);
      const existingImages =
        fragment === null
          ? new Set<Y.XmlElement>()
          : new Set(imageElements(fragment));
      const imageContent = images.map((image) => ({
        type: "image",
        attrs: {
          src: image.src,
          alt: image.alt,
          attachmentHash: image.attachmentHash,
          mediaType: image.mediaType,
        },
      }));
      const selectionParent = editor.state.selection.$from.parent;
      const replacesEmptyTextblock =
        editor.state.selection.empty &&
        selectionParent.isTextblock &&
        selectionParent.content.size === 0;
      const inserted = editor
        .chain()
        .focus()
        .insertContent(
          replacesEmptyTextblock
            ? [...imageContent, { type: "paragraph" }]
            : imageContent,
        )
        .run();
      if (inserted && fragment !== null) {
        imageElements(fragment)
          .filter((image) => !existingImages.has(image))
          .slice(0, images.length)
          .forEach((image, index) => {
            const prepared = images[index];
            insertedArtifactImages.set(prepared, image);
          });
      }
      return inserted ? images.length : 0;
    },
    [editor],
  );
  const captureImageInsertion =
    useCallback((): ComposerImageInsertion<PreparedArtifactImage> | null => {
      if (editor === null || editor.isDestroyed || !editor.isEditable) {
        return null;
      }
      const bookmark = editor.state.selection.getBookmark();
      let mapping = new Mapping();
      let released = false;
      const onTransaction = ({
        transaction,
      }: {
        transaction: Transaction;
      }): void => {
        mapping.appendMapping(transaction.mapping);
      };
      editor.on("transaction", onTransaction);
      const release = (): void => {
        if (released) return;
        released = true;
        editor.off("transaction", onTransaction);
      };
      return {
        insert: (images) => {
          if (editor.isDestroyed || !editor.isEditable) {
            release();
            return 0;
          }
          const selection = bookmark.map(mapping).resolve(editor.state.doc);
          mapping = new Mapping();
          const activeBookmark = editor.state.selection.getBookmark();
          editor.commands.setTextSelection({
            from: selection.from,
            to: selection.to,
          });
          const inserted = insertAttrs(images);
          const activeSelection = activeBookmark
            .map(mapping)
            .resolve(editor.state.doc);
          editor.commands.setTextSelection({
            from: activeSelection.from,
            to: activeSelection.to,
          });
          release();
          return inserted;
        },
        release,
      };
    }, [editor, insertAttrs]);
  const beginPathInsertion = useCallback((): null => null, []);
  const filePaths = useMemo(
    () => ({
      fileDrops: runnerHost.fileDrops,
      mentionRoots: [],
      beginPathInsertion,
      // A path is never inserted here (`beginPathInsertion` declines), so
      // there is no host it could fail to reach.
      pathsReachTarget: true,
    }),
    [beginPathInsertion, runnerHost.fileDrops],
  );
  const paste = useComposerPasteEvents({
    imageIngest,
    insertAttrs,
    filePaths,
    captureImageInsertion,
    fileAttach: null,
  });
  return { supported: operations.supported, paste };
}
