import { v4 as uuidv4 } from "uuid";
import { vi, type Mock } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { FILE_ATTACHMENT_MAX_BYTES } from "@traycer/protocol/host/drafts/schemas";

import type {
  FileAttachmentUploadClient,
  FileAttachmentUploadTarget,
  FileNodeSettle,
  PutFileBlob,
} from "@/lib/composer/file-attachment-upload";
import type { ComposerFileAttachmentAttrs } from "@/lib/composer/file-attachments";

function unused(): never {
  throw new Error("this test's file upload is faked at `put`");
}

/**
 * A requester that is only ever passed through to a faked `put`: the upload
 * queue never calls it itself.
 */
export const UNUSED_REQUESTER: FileAttachmentUploadClient = {
  getRegistry: unused,
  getActiveHost: unused,
  getActiveHostId: unused,
  getRequestContext: unused,
  getRequestContextUserId: unused,
  onChange: unused,
  request: unused,
  requestWithIdempotencyKey: unused,
  requestWithOptions: unused,
  requestWithSignal: unused,
  requestWithSignalRequiringHostMethodVersion: unused,
  requestWithResponseTimeout: unused,
};

/**
 * The client of a whole composer surface under test: it answers every
 * readiness read with "no host yet", so none of the surface's host queries
 * runs, and a `drafts.putBlob` goes through `requestWithOptions`.
 */
export function putOnlyRequester(
  requestWithOptions: FileAttachmentUploadClient["requestWithOptions"],
): FileAttachmentUploadClient {
  return {
    ...UNUSED_REQUESTER,
    getActiveHost: () => null,
    getActiveHostId: () => null,
    getRequestContextUserId: () => null,
    requestWithOptions,
  };
}

export function targetFor(hostId: string): FileAttachmentUploadTarget {
  return { hostId, client: UNUSED_REQUESTER };
}

/**
 * The upload registry and its serial queue are module state: a fresh host id
 * and fresh bytes per test keep one test's uploads from being another's.
 */
export function freshHostId(label: string): string {
  return `${label}-${uuidv4()}`;
}

export function uniqueFile(name: string): File {
  return new File([uuidv4()], name, { type: "text/plain" });
}

export function oversizedFile(): File {
  const file = uniqueFile("huge.mov");
  Object.defineProperty(file, "size", { value: FILE_ATTACHMENT_MAX_BYTES + 1 });
  return file;
}

export function okPut(): Mock<PutFileBlob> {
  return vi.fn<PutFileBlob>().mockResolvedValue({ ok: true });
}

export function recordingSettle(): Mock<FileNodeSettle> {
  return vi.fn<FileNodeSettle>();
}

export function fileNodeAttrs(
  overrides: Partial<ComposerFileAttachmentAttrs>,
): ComposerFileAttachmentAttrs {
  return {
    id: uuidv4(),
    hash: "e".repeat(64),
    fileName: "a.txt",
    mediaType: "text/plain",
    size: 4,
    uploadState: null,
    ...overrides,
  };
}

export function docOfFileNodes(
  nodes: ReadonlyArray<ComposerFileAttachmentAttrs>,
): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: nodes.map((attrs) => ({
          type: "fileAttachment",
          attrs: { ...attrs },
        })),
      },
    ],
  };
}

/** Resolves once `id` leaves `uploading`, however it settles. */
export async function waitForSettled(
  id: string,
  read: (id: string) => string | null,
): Promise<void> {
  await vi.waitFor(() => {
    if (read(id) === "uploading") throw new Error("still uploading");
  });
}
