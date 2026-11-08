import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostMethodVersionUnsatisfiedError,
  HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { FILE_ATTACHMENT_MAX_BYTES } from "@traycer/protocol/host/drafts/schemas";

import {
  attachFileAttachment,
  cancelFileAttachmentUpload,
  readFileAttachmentUploadStatus,
  refuseFileAttachment,
  subscribeFileAttachmentUploads,
  type FileAttachmentUploadClient,
  type FileAttachmentUploadTarget,
} from "@/lib/composer/file-attachment-upload";
import type { ComposerFileAttachmentAttrs } from "@/lib/composer/file-attachments";

const toasts = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: toasts.error,
}));

const HOST_ID = "host-1";

type PutBlob = FileAttachmentUploadClient["requestWithOptions"];

function makeTarget(put: PutBlob): FileAttachmentUploadTarget {
  return { hostId: HOST_ID, client: { requestWithOptions: put } };
}

function textFile(name: string, text: string, type: string): File {
  return new File([text], name, { type });
}

function oversizedFile(): File {
  const file = textFile("huge.mov", "x", "video/quicktime");
  Object.defineProperty(file, "size", { value: FILE_ATTACHMENT_MAX_BYTES + 1 });
  return file;
}

/** Resolves once `id` leaves `uploading`, however it settles. */
function settled(id: string): Promise<void> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      if (readFileAttachmentUploadStatus(id) === "uploading") return false;
      return true;
    };
    if (check()) {
      resolve();
      return;
    }
    const unsubscribe = subscribeFileAttachmentUploads(() => {
      if (!check()) return;
      unsubscribe();
      resolve();
    });
  });
}

async function attach(
  file: File,
  target: FileAttachmentUploadTarget,
): Promise<ComposerFileAttachmentAttrs> {
  const inserted: ComposerFileAttachmentAttrs[] = [];
  await attachFileAttachment({
    file,
    target,
    insert: (attrs) => {
      inserted.push(attrs);
      return true;
    },
  });
  const attrs = inserted.at(0);
  if (attrs === undefined) throw new Error("expected the node to be inserted");
  return attrs;
}

beforeEach(() => {
  toasts.error.mockClear();
  resetNegotiatedManifests();
});

afterEach(() => {
  resetNegotiatedManifests();
});

describe("refuseFileAttachment", () => {
  it("refuses a file over the cap, with no host consulted", () => {
    expect(refuseFileAttachment(oversizedFile(), null)).toBe("too-large");
  });

  it("refuses when the composer has no host", () => {
    expect(
      refuseFileAttachment(textFile("a.txt", "a", "text/plain"), null),
    ).toBe("no-host");
  });

  it("refuses a host whose drafts.putBlob is below 1.2, and one without the method", () => {
    const file = textFile("a.txt", "a", "text/plain");
    const target = makeTarget(vi.fn<PutBlob>());
    recordNegotiatedHostManifest(HOST_ID, {
      "drafts.putBlob": { major: 1, minor: 1 },
    });
    expect(refuseFileAttachment(file, target)).toBe("host-outdated");
    resetNegotiatedManifests();
    recordNegotiatedHostManifest(HOST_ID, {
      "drafts.getBlob": { major: 1, minor: 0 },
    });
    expect(refuseFileAttachment(file, target)).toBe("host-outdated");
  });

  it("admits a 1.2 host, and a host whose handshake has not settled", () => {
    const file = textFile("a.txt", "a", "text/plain");
    const target = makeTarget(vi.fn<PutBlob>());
    expect(refuseFileAttachment(file, target)).toBeNull();
    recordNegotiatedHostManifest(HOST_ID, {
      "drafts.putBlob": { major: 1, minor: 2 },
    });
    expect(refuseFileAttachment(file, target)).toBeNull();
  });
});

describe("attachFileAttachment", () => {
  it("inserts a pending node and uploads the bytes as a file with the 1.2 floor", async () => {
    const put = vi.fn<PutBlob>().mockResolvedValue({ ok: true });
    const file = textFile("notes.txt", "hello", "text/plain");

    const attrs = await attach(file, makeTarget(put));

    expect(attrs).toMatchObject({
      hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      fileName: "notes.txt",
      mediaType: "text/plain",
      size: 5,
      uploadState: "pending",
    });
    expect(readFileAttachmentUploadStatus(attrs.id)).toBe("uploading");

    await settled(attrs.id);

    expect(readFileAttachmentUploadStatus(attrs.id)).toBe("stored");
    expect(put).toHaveBeenCalledTimes(1);
    const [method, request, options] = put.mock.calls[0];
    expect(method).toBe("drafts.putBlob");
    expect(request).toEqual({
      kind: "file",
      sha256: attrs.hash,
      bytesBase64: btoa("hello"),
      fileName: "notes.txt",
      mediaType: "text/plain",
    });
    expect(options).toMatchObject({
      idempotencyKey: attrs.hash,
      requiredHostMethodVersion: {
        method: "drafts.putBlob",
        version: { major: 1, minor: 2 },
      },
    });
    expect(options.responseTimeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it("falls back to a generic media type and a placeholder name", async () => {
    const put = vi.fn<PutBlob>().mockResolvedValue({ ok: true });
    const attrs = await attach(textFile("", "abc", ""), makeTarget(put));
    await settled(attrs.id);
    expect(attrs.mediaType).toBe("application/octet-stream");
    expect(attrs.fileName).toBe("file");
  });

  it("puts one file on the wire at a time", async () => {
    const releases: Array<() => void> = [];
    const put = vi.fn<PutBlob>().mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true }));
        }),
    );
    const target = makeTarget(put);
    const first = await attach(textFile("a.txt", "aaa", "text/plain"), target);
    const second = await attach(textFile("b.txt", "bbb", "text/plain"), target);

    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(readFileAttachmentUploadStatus(second.id)).toBe("uploading");

    releases[0]();
    await settled(first.id);
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    releases[1]();
    await settled(second.id);

    expect(put.mock.calls.map(([, request]) => request)).toMatchObject([
      { fileName: "a.txt" },
      { fileName: "b.txt" },
    ]);
  });

  it("marks a lost upload failed and tells the person once", async () => {
    const put = vi.fn<PutBlob>().mockRejectedValue(new Error("socket closed"));
    const attrs = await attach(
      textFile("a.txt", "aaa", "text/plain"),
      makeTarget(put),
    );
    await settled(attrs.id);
    expect(readFileAttachmentUploadStatus(attrs.id)).toBe("failed");
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error.mock.calls[0][0]).toBe("Couldn't attach a.txt.");
  });

  it("marks a digest mismatch failed", async () => {
    const put = vi
      .fn<PutBlob>()
      .mockResolvedValue({ ok: false, reason: "digest-mismatch" });
    const attrs = await attach(
      textFile("a.txt", "aaa", "text/plain"),
      makeTarget(put),
    );
    await settled(attrs.id);
    expect(readFileAttachmentUploadStatus(attrs.id)).toBe("failed");
  });

  it.each([
    [
      "an unsatisfied method floor",
      new HostMethodVersionUnsatisfiedError({
        requirement: {
          method: "drafts.putBlob",
          version: { major: 1, minor: 2 },
        },
        negotiated: { major: 1, minor: 1 },
        requestId: "request-1",
        method: "drafts.putBlob",
        hostId: HOST_ID,
      }),
    ],
    [
      "E_HOST_UNSUPPORTED",
      new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message: "unsupported",
        requestId: "request-1",
        method: "drafts.putBlob",
        fatalDetails: null,
      }),
    ],
  ])("asks the person to update the host on %s", async (_label, error) => {
    const put = vi.fn<PutBlob>().mockRejectedValue(error);
    const attrs = await attach(
      textFile("a.txt", "aaa", "text/plain"),
      makeTarget(put),
    );
    await settled(attrs.id);
    expect(readFileAttachmentUploadStatus(attrs.id)).toBe("failed");
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error.mock.calls[0][1]).toMatchObject({
      description: "Update this host to attach files.",
    });
  });

  it("cancelling a queued upload skips it without a toast", async () => {
    const release: Array<() => void> = [];
    const put = vi.fn<PutBlob>().mockImplementation(
      () =>
        new Promise((resolve) => {
          release.push(() => resolve({ ok: true }));
        }),
    );
    const target = makeTarget(put);
    const first = await attach(textFile("a.txt", "aaa", "text/plain"), target);
    const second = await attach(textFile("b.txt", "bbb", "text/plain"), target);
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));

    cancelFileAttachmentUpload(second.id);
    release[0]();
    await settled(first.id);
    // Let the queue run the cancelled job's turn.
    const third = await attach(textFile("c.txt", "ccc", "text/plain"), target);
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    release[1]();
    await settled(third.id);

    expect(readFileAttachmentUploadStatus(second.id)).toBe("cancelled");
    expect(put.mock.calls.map(([, request]) => request)).toMatchObject([
      { fileName: "a.txt" },
      { fileName: "c.txt" },
    ]);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("uploads nothing when the editor refuses the node", async () => {
    const put = vi.fn<PutBlob>().mockResolvedValue({ ok: true });
    await attachFileAttachment({
      file: textFile("a.txt", "aaa", "text/plain"),
      target: makeTarget(put),
      insert: () => false,
    });
    // A later upload drains the queue behind it.
    const next = await attach(
      textFile("b.txt", "bbb", "text/plain"),
      makeTarget(put),
    );
    await settled(next.id);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
