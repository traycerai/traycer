import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
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
  type FileInsertion,
  type FileNodeSettle,
  type PutFileBlob,
} from "@/lib/composer/file-attachment-upload";
import { type ComposerFileAttachmentAttrs } from "@/lib/composer/file-attachments";
import {
  freshHostId,
  okPut,
  recordingSettle,
  targetFor,
  uniqueFile,
  waitForSettled,
} from "@/lib/composer/__tests__/file-attachment-fixtures";

const toasts = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: toasts.error,
}));

function oversizedFile(): File {
  const file = uniqueFile("huge.mov");
  Object.defineProperty(file, "size", { value: FILE_ATTACHMENT_MAX_BYTES + 1 });
  return file;
}

function settled(id: string): Promise<void> {
  return waitForSettled(id, readFileAttachmentUploadStatus);
}

interface Attached {
  readonly attrs: ComposerFileAttachmentAttrs;
  readonly settle: Mock<FileNodeSettle>;
}

async function attach(input: {
  readonly file: File;
  readonly hostId: string;
  readonly put: PutFileBlob;
}): Promise<Attached> {
  const inserted: ComposerFileAttachmentAttrs[] = [];
  const settle = recordingSettle();
  const insert: FileInsertion = (attrs) => {
    inserted.push(attrs);
    return "inserted";
  };
  await attachFileAttachment({
    file: input.file,
    target: targetFor(input.hostId),
    put: input.put,
    insert,
    settle,
  });
  const attrs = inserted.at(0);
  if (attrs === undefined) throw new Error("expected the node to be inserted");
  return { attrs, settle };
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
    expect(refuseFileAttachment(uniqueFile("a.txt"), null)).toBe("no-host");
  });

  it("refuses a host whose drafts.putBlob is below 1.2, and one without the method", () => {
    const hostId = freshHostId("host");
    const file = uniqueFile("a.txt");
    recordNegotiatedHostManifest(hostId, {
      "drafts.putBlob": { major: 1, minor: 1 },
    });
    expect(refuseFileAttachment(file, targetFor(hostId))).toBe("host-outdated");
    resetNegotiatedManifests();
    recordNegotiatedHostManifest(hostId, {
      "drafts.getBlob": { major: 1, minor: 0 },
    });
    expect(refuseFileAttachment(file, targetFor(hostId))).toBe("host-outdated");
  });

  it("admits a 1.2 host, and a host whose handshake has not settled", () => {
    const hostId = freshHostId("host");
    const file = uniqueFile("a.txt");
    expect(refuseFileAttachment(file, targetFor(hostId))).toBeNull();
    recordNegotiatedHostManifest(hostId, {
      "drafts.putBlob": { major: 1, minor: 2 },
    });
    expect(refuseFileAttachment(file, targetFor(hostId))).toBeNull();
  });
});

describe("attachFileAttachment", () => {
  it("inserts a pending node and puts the bytes as a file on the composer's host", async () => {
    const put = okPut();
    const hostId = freshHostId("host");
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    const { attrs, settle } = await attach({
      file,
      hostId,
      put,
    });

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
    expect(settle).toHaveBeenCalledWith(attrs.id, { kind: "stored" });
    expect(put).toHaveBeenCalledTimes(1);
    const [variables] = put.mock.calls[0];
    expect(variables.target.hostId).toBe(hostId);
    expect(variables.request).toEqual({
      kind: "file",
      sha256: attrs.hash,
      bytesBase64: btoa("hello"),
      fileName: "notes.txt",
      mediaType: "text/plain",
    });
  });

  it("falls back to a generic media type and a placeholder name", async () => {
    const { attrs } = await attach({
      file: new File([crypto.randomUUID()], "", { type: "" }),
      hostId: freshHostId("host"),
      put: okPut(),
    });
    await settled(attrs.id);
    expect(attrs.mediaType).toBe("application/octet-stream");
    expect(attrs.fileName).toBe("file");
  });

  it("puts one file on the wire at a time", async () => {
    const releases: Array<() => void> = [];
    const put = vi.fn<PutFileBlob>().mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true }));
        }),
    );
    const hostId = freshHostId("host");
    const first = await attach({
      file: uniqueFile("a.txt"),
      hostId,
      put,
    });
    const second = await attach({
      file: uniqueFile("b.txt"),
      hostId,
      put,
    });

    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(readFileAttachmentUploadStatus(second.attrs.id)).toBe("uploading");

    releases[0]();
    await settled(first.attrs.id);
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    releases[1]();
    await settled(second.attrs.id);

    expect(
      put.mock.calls.map(([variables]) => variables.request),
    ).toMatchObject([{ fileName: "a.txt" }, { fileName: "b.txt" }]);
  });

  it("removes the node and tells the person once when the upload is lost", async () => {
    const put = vi
      .fn<PutFileBlob>()
      .mockRejectedValue(new Error("socket closed"));
    const { attrs, settle } = await attach({
      file: uniqueFile("a.txt"),
      hostId: freshHostId("host"),
      put,
    });
    await settled(attrs.id);
    expect(readFileAttachmentUploadStatus(attrs.id)).toBe("failed");
    expect(settle).toHaveBeenCalledWith(attrs.id, { kind: "remove" });
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error.mock.calls[0][0]).toBe("Couldn't attach a.txt.");
  });

  it("removes the node on a digest mismatch", async () => {
    const put = vi
      .fn<PutFileBlob>()
      .mockResolvedValue({ ok: false, reason: "digest-mismatch" });
    const { attrs, settle } = await attach({
      file: uniqueFile("a.txt"),
      hostId: freshHostId("host"),
      put,
    });
    await settled(attrs.id);
    expect(settle).toHaveBeenCalledWith(attrs.id, { kind: "remove" });
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
        hostId: "host-1",
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
    const put = vi.fn<PutFileBlob>().mockRejectedValue(error);
    const { attrs } = await attach({
      file: uniqueFile("a.txt"),
      hostId: freshHostId("host"),
      put,
    });
    await settled(attrs.id);
    expect(readFileAttachmentUploadStatus(attrs.id)).toBe("failed");
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error.mock.calls[0][1]).toMatchObject({
      description: "Update this host to attach files.",
    });
  });

  it("cancelling a queued upload skips it without a toast", async () => {
    const release: Array<() => void> = [];
    const put = vi.fn<PutFileBlob>().mockImplementation(
      () =>
        new Promise((resolve) => {
          release.push(() => resolve({ ok: true }));
        }),
    );
    const hostId = freshHostId("host");
    const first = await attach({
      file: uniqueFile("a.txt"),
      hostId,
      put,
    });
    const second = await attach({
      file: uniqueFile("b.txt"),
      hostId,
      put,
    });
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));

    cancelFileAttachmentUpload(second.attrs.id);
    release[0]();
    await settled(first.attrs.id);
    const third = await attach({
      file: uniqueFile("c.txt"),
      hostId,
      put,
    });
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    release[1]();
    await settled(third.attrs.id);

    expect(readFileAttachmentUploadStatus(second.attrs.id)).toBe("cancelled");
    expect(
      put.mock.calls.map(([variables]) => variables.request),
    ).toMatchObject([{ fileName: "a.txt" }, { fileName: "c.txt" }]);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it.each(["dropped", "over-cap"] as const)(
    "uploads nothing when the insertion answers %s",
    async (answer) => {
      const put = okPut();
      const settle = recordingSettle();
      const placed = await attachFileAttachment({
        file: uniqueFile("a.txt"),
        target: targetFor(freshHostId("host")),
        put,
        insert: () => answer,
        settle,
      });
      expect(placed).toBe(answer);
      // A later upload drains the queue behind it.
      const next = await attach({
        file: uniqueFile("b.txt"),
        hostId: freshHostId("host"),
        put,
      });
      await settled(next.attrs.id);
      expect(put).toHaveBeenCalledTimes(1);
      expect(settle).not.toHaveBeenCalled();
    },
  );
});
