import { describe, expect, it, vi } from "vitest";
import type {
  EpicReadFileRequest,
  EpicReadFileResponse,
} from "@traycer/protocol/host/epic/files";
import type { EpicFileAddress } from "@/hooks/files/use-epic-file-text-query";
import {
  byteSourceCapBytes,
  readFileBlob,
  readSignedUrl,
  urlRenewalDelayMs,
  type ReadFile,
} from "@/lib/files/byte-source";

const MIB = 1024 * 1024;

const ADDRESS: EpicFileAddress = {
  epicId: "epic-1",
  path: "files/pages/report.pdf",
  sha256: "a".repeat(64),
  via: null,
};

const OPTIONS = {
  maxBytes: null,
  onProgress: null,
  signal: new AbortController().signal,
};

function base64Of(text: string): string {
  return btoa(text);
}

function bytesResponse(args: {
  readonly text: string;
  readonly offset: number;
  readonly totalBytes: number;
}): EpicReadFileResponse {
  return {
    kind: "bytes",
    bytesBase64: base64Of(args.text),
    offset: args.offset,
    totalBytes: args.totalBytes,
    mediaType: "application/pdf",
  };
}

/**
 * A host serving `content` that never answers more than `spanBytes` at once,
 * which a host is free to do: the reader has to keep asking from where the
 * last span ended.
 */
function serving(
  content: string,
  spanBytes: number,
): { readonly readFile: ReadFile; readonly offsets: readonly number[] } {
  const offsets: number[] = [];
  const readFile: ReadFile = (request: EpicReadFileRequest) => {
    if (request.want.kind !== "range") {
      return Promise.reject(new Error("expected a range read"));
    }
    offsets.push(request.want.offset);
    const start = request.want.offset;
    return Promise.resolve(
      bytesResponse({
        text: content.slice(start, start + spanBytes),
        offset: start,
        totalBytes: content.length,
      }),
    );
  };
  return { readFile, offsets };
}

/** A host that answers the given responses in order, whatever is asked. */
function answering(...responses: readonly EpicReadFileResponse[]): ReadFile {
  const queue = [...responses];
  return vi.fn<ReadFile>().mockImplementation(() => {
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error("no answer left"));
    return Promise.resolve(next);
  });
}

function textOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("the blob did not read as text"));
    };
    reader.onerror = () => reject(new Error("the blob could not be read"));
    reader.readAsText(blob);
  });
}

describe("readFileBlob", () => {
  it("joins spans into one Blob typed by the host and reports progress per span", async () => {
    const host = serving("0123456789", 4);
    const progress: [number, number][] = [];

    const result = await readFileBlob(host.readFile, ADDRESS, {
      ...OPTIONS,
      onProgress: (received, total) => progress.push([received, total]),
    });

    if (result.kind !== "blob") throw new Error("expected a blob");
    expect(await textOf(result.blob)).toBe("0123456789");
    expect(result.blob.type).toBe("application/pdf");
    expect(host.offsets).toEqual([0, 4, 8]);
    expect(progress).toEqual([
      [4, 10],
      [8, 10],
      [10, 10],
    ]);
  });

  it("fails rather than building a Blob when the host answers a different offset", async () => {
    const readFile = answering(
      bytesResponse({ text: "0123", offset: 0, totalBytes: 10 }),
      bytesResponse({ text: "89", offset: 8, totalBytes: 10 }),
    );

    await expect(readFileBlob(readFile, ADDRESS, OPTIONS)).rejects.toThrow(
      "wrong span",
    );
  });

  it("fails when the file's total changes between spans", async () => {
    const readFile = answering(
      bytesResponse({ text: "0123", offset: 0, totalBytes: 10 }),
      bytesResponse({ text: "4567", offset: 4, totalBytes: 12 }),
    );

    await expect(readFileBlob(readFile, ADDRESS, OPTIONS)).rejects.toThrow(
      "changed while it was being read",
    );
  });

  it("fails on an empty span before the end instead of asking forever", async () => {
    const readFile = answering(
      bytesResponse({ text: "0123", offset: 0, totalBytes: 10 }),
      bytesResponse({ text: "", offset: 4, totalBytes: 10 }),
    );

    await expect(readFileBlob(readFile, ADDRESS, OPTIONS)).rejects.toThrow(
      "ended a file read early",
    );
  });

  it("fails when a span runs past the file's total", async () => {
    const readFile = answering(
      bytesResponse({ text: "0123", offset: 0, totalBytes: 6 }),
      bytesResponse({ text: "456789", offset: 4, totalBytes: 6 }),
    );

    await expect(readFileBlob(readFile, ADDRESS, OPTIONS)).rejects.toThrow(
      "overlong span",
    );
  });

  it("fails on a span longer than a whole range read, before decoding it", async () => {
    const readFile = answering({
      kind: "bytes",
      // Not even valid base64: the length alone must refuse it.
      bytesBase64: "*".repeat(Math.ceil((4 * MIB * 4) / 3) + 5),
      offset: 0,
      totalBytes: 8 * MIB,
      mediaType: "application/pdf",
    });

    await expect(readFileBlob(readFile, ADDRESS, OPTIONS)).rejects.toThrow(
      "overlong span",
    );
  });

  it("answers too-large after the first span, without reading further", async () => {
    const host = serving("0123456789", 4);

    const result = await readFileBlob(host.readFile, ADDRESS, {
      ...OPTIONS,
      maxBytes: 9,
    });

    expect(result).toEqual({ kind: "too-large", totalBytes: 10 });
    expect(host.offsets).toEqual([0]);
  });

  it("reads a file exactly at the cap", async () => {
    const host = serving("0123456789", 10);

    const result = await readFileBlob(host.readFile, ADDRESS, {
      ...OPTIONS,
      maxBytes: 10,
    });

    expect(result.kind).toBe("blob");
  });

  it("passes the host's reason through when the bytes are unavailable", async () => {
    const readFile = answering({
      kind: "unavailable",
      reason: "not-downloaded",
    });

    const result = await readFileBlob(readFile, ADDRESS, OPTIONS);

    expect(result).toEqual({ kind: "unavailable", reason: "not-downloaded" });
  });
});

describe("readSignedUrl", () => {
  it("returns the URL and its expiry", async () => {
    const readFile = answering({
      kind: "url",
      url: "https://files.example/video.mp4?sig=1",
      expiresAt: 5000,
    });

    expect(await readSignedUrl(readFile, ADDRESS, OPTIONS.signal)).toEqual({
      kind: "url",
      url: "https://files.example/video.mp4?sig=1",
      expiresAt: 5000,
    });
  });

  it("passes the host's reason through when the file is not published yet", async () => {
    const readFile = answering({
      kind: "unavailable",
      reason: "upload-pending",
    });

    expect(await readSignedUrl(readFile, ADDRESS, OPTIONS.signal)).toEqual({
      kind: "unavailable",
      reason: "upload-pending",
    });
  });
});

describe("urlRenewalDelayMs", () => {
  it("renews at 80% of a long lifetime, measured from receipt", () => {
    expect(urlRenewalDelayMs(301_000, 1_000)).toBe(240_000);
  });

  it("never plans sooner than 30 s, for a short lifetime, a near expiry or an already-expired answer", () => {
    // 80% of 10 s is 8 s, but an answer that short must not be re-requested in
    // a tight loop.
    expect(urlRenewalDelayMs(11_000, 1_000)).toBe(30_000);
    expect(urlRenewalDelayMs(2_000, 1_000)).toBe(30_000);
    expect(urlRenewalDelayMs(1_000, 5_000)).toBe(30_000);
  });
});

describe("byteSourceCapBytes", () => {
  it("holds a video to less on a phone than on a desktop, and images and PDFs to the same everywhere", () => {
    expect(byteSourceCapBytes("video", false)).toBe(512 * MIB);
    expect(byteSourceCapBytes("video", true)).toBe(64 * MIB);
    expect(byteSourceCapBytes("image", false)).toBe(64 * MIB);
    expect(byteSourceCapBytes("image", true)).toBe(64 * MIB);
    expect(byteSourceCapBytes("pdf", false)).toBe(128 * MIB);
    expect(byteSourceCapBytes("pdf", true)).toBe(128 * MIB);
  });
});
