import { describe, expect, it } from "vitest";

import {
  EPIC_READ_FILE_RANGE_MAX_BYTES,
  epicCancelFetchFileV10,
  epicDeleteFileV10,
  epicFetchFileV10,
  epicOpenFileInBrowserV10,
  epicReadFileV10,
  epicRestoreFileV10,
} from "@traycer/protocol/host/epic/files";
import {
  epicStateSubscribeServerFrameSchemaV11,
  epicStateSubscribeServerFrameSchemaV12,
  epicStateSubscribeV12,
} from "@traycer/protocol/host/epic/state-subscribe";
import {
  MCP_UI_CSP_DOMAIN_PATTERN,
  mcpUiCspNormalizedSchema,
  mcpUiPermissionSchema,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  epicFileEntrySchema,
  formatEpicFileRef,
  isEpicFilePath,
  isEpicFileProducerPath,
  parseEpicFileRef,
} from "@traycer/protocol/persistence/epic/files";

/**
 * The epic files plane's wire shapes: the `epic.*File` unaries, the files arm of
 * `epic.state.subscribe@1.2`, the manifest entry, and the MCP App stamp's
 * closed vocabularies (CSP origins, device permissions).
 *
 * Every assertion is at a parse boundary - what a peer may send and what a
 * reader must refuse - because the manifest and the stamp are written by peers
 * and rendered by clients.
 */

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

const address = { epicId: "epic-1", path: "files/pages/report-1.html" };

function readRequest(want: unknown) {
  return { ...address, sha256: SHA, via: null, want };
}

describe("epic.readFile", () => {
  const request = epicReadFileV10.requestSchema;
  const response = epicReadFileV10.responseSchema;

  describe("want", () => {
    it.each([
      ["text", { kind: "text" }],
      ["url", { kind: "url" }],
      ["range", { kind: "range", offset: 0, length: 1024 }],
    ])("accepts a %s read", (_label, want) => {
      expect(request.safeParse(readRequest(want)).success).toBe(true);
    });

    it("caps a range read at 4 MiB, inclusive", () => {
      const at = readRequest({
        kind: "range",
        offset: 0,
        length: EPIC_READ_FILE_RANGE_MAX_BYTES,
      });
      const over = readRequest({
        kind: "range",
        offset: 0,
        length: EPIC_READ_FILE_RANGE_MAX_BYTES + 1,
      });
      expect(EPIC_READ_FILE_RANGE_MAX_BYTES).toBe(4 * 1024 * 1024);
      expect(request.safeParse(at).success).toBe(true);
      expect(request.safeParse(over).success).toBe(false);
    });

    it.each([
      ["a zero length", { kind: "range", offset: 0, length: 0 }],
      ["a negative offset", { kind: "range", offset: -1, length: 10 }],
      ["a fractional offset", { kind: "range", offset: 1.5, length: 10 }],
      ["a range with no length", { kind: "range", offset: 0 }],
      ["an unknown kind", { kind: "stream" }],
    ])("rejects %s", (_label, want) => {
      expect(request.safeParse(readRequest(want)).success).toBe(false);
    });
  });

  describe("address", () => {
    it("rejects a sha that is not 64 lowercase hex characters", () => {
      for (const sha256 of ["A".repeat(64), "a".repeat(63), `${SHA}0`, ""]) {
        expect(
          request.safeParse({ ...readRequest({ kind: "text" }), sha256 })
            .success,
        ).toBe(false);
      }
    });

    it("requires `via` to be present, and takes a chat/block pair or null", () => {
      const base = { ...address, sha256: SHA, want: { kind: "text" } };
      expect(request.safeParse(base).success).toBe(false);
      expect(
        request.safeParse({
          ...base,
          via: { chatId: "chat-1", blockId: "block-1" },
        }).success,
      ).toBe(true);
      expect(
        request.safeParse({ ...base, via: { chatId: "chat-1" } }).success,
      ).toBe(false);
    });
  });

  describe("answer", () => {
    it("carries the network policy on the text arm, and only open | https-only", () => {
      for (const networkPolicy of ["open", "https-only"]) {
        expect(
          response.safeParse({
            kind: "text",
            text: "<html></html>",
            mediaType: "text/html",
            networkPolicy,
          }).success,
        ).toBe(true);
      }
      expect(
        response.safeParse({
          kind: "text",
          text: "",
          mediaType: "text/html",
          networkPolicy: "none",
        }).success,
      ).toBe(false);
      expect(
        response.safeParse({
          kind: "text",
          text: "",
          mediaType: "text/html",
        }).success,
      ).toBe(false);
    });

    it("parses a bytes span and a signed url, and rejects a url that is not one", () => {
      expect(
        response.safeParse({
          kind: "bytes",
          bytesBase64: "AAAA",
          offset: 0,
          totalBytes: 3,
          mediaType: "image/png",
        }).success,
      ).toBe(true);
      expect(
        response.safeParse({
          kind: "url",
          url: "https://files.example.com/x?sig=1",
          expiresAt: 1,
        }).success,
      ).toBe(true);
      expect(
        response.safeParse({ kind: "url", url: "not a url", expiresAt: 1 })
          .success,
      ).toBe(false);
    });

    it.each([
      "not-downloaded",
      "upload-pending",
      "local-only",
      "missing",
      "failed",
    ])("answers unavailable/%s as data", (reason) => {
      expect(response.safeParse({ kind: "unavailable", reason }).success).toBe(
        true,
      );
    });

    it("rejects an unavailable reason outside the closed set", () => {
      expect(
        response.safeParse({ kind: "unavailable", reason: "timeout" }).success,
      ).toBe(false);
    });
  });
});

describe("epic.fetchFile / epic.cancelFetchFile", () => {
  const body = { ...address, sha256: SHA };

  it("addresses the bytes by epic, path and sha", () => {
    expect(epicFetchFileV10.requestSchema.safeParse(body).success).toBe(true);
    expect(epicCancelFetchFileV10.requestSchema.safeParse(body).success).toBe(
      true,
    );
    expect(
      epicFetchFileV10.requestSchema.safeParse({ ...body, sha256: "nope" })
        .success,
    ).toBe(false);
    expect(
      epicCancelFetchFileV10.requestSchema.safeParse({ epicId: "epic-1" })
        .success,
    ).toBe(false);
  });

  it("answers present | downloading | unavailable, and nothing else", () => {
    const response = epicFetchFileV10.responseSchema;
    expect(response.safeParse({ kind: "present" }).success).toBe(true);
    expect(response.safeParse({ kind: "downloading" }).success).toBe(true);
    expect(
      response.safeParse({ kind: "unavailable", reason: "failed" }).success,
    ).toBe(true);
    expect(response.safeParse({ kind: "queued" }).success).toBe(false);
  });

  it("answers a cancel with whether a download was running", () => {
    const response = epicCancelFetchFileV10.responseSchema;
    expect(response.safeParse({ cancelled: false }).success).toBe(true);
    expect(response.safeParse({}).success).toBe(false);
  });
});

describe("epic.deleteFile / epic.restoreFile", () => {
  it("take an epic and a path, no sha", () => {
    for (const contract of [epicDeleteFileV10, epicRestoreFileV10]) {
      expect(contract.requestSchema.safeParse(address).success).toBe(true);
      expect(
        contract.requestSchema.safeParse({ epicId: "epic-1", path: "" })
          .success,
      ).toBe(false);
    }
  });

  it("each answers its own success arm or a refusal of missing | forbidden", () => {
    expect(
      epicDeleteFileV10.responseSchema.safeParse({ kind: "deleted" }).success,
    ).toBe(true);
    expect(
      epicRestoreFileV10.responseSchema.safeParse({ kind: "restored" }).success,
    ).toBe(true);
    // The two success arms are not interchangeable.
    expect(
      epicDeleteFileV10.responseSchema.safeParse({ kind: "restored" }).success,
    ).toBe(false);
    expect(
      epicRestoreFileV10.responseSchema.safeParse({ kind: "deleted" }).success,
    ).toBe(false);
    for (const contract of [epicDeleteFileV10, epicRestoreFileV10]) {
      for (const reason of ["missing", "forbidden"]) {
        expect(
          contract.responseSchema.safeParse({ kind: "refused", reason })
            .success,
        ).toBe(true);
      }
      expect(
        contract.responseSchema.safeParse({ kind: "refused", reason: "busy" })
          .success,
      ).toBe(false);
    }
  });
});

describe("epic.openFileInBrowser", () => {
  it("takes the address and a nullable `via`, and answers a url or unavailable", () => {
    const request = epicOpenFileInBrowserV10.requestSchema;
    const response = epicOpenFileInBrowserV10.responseSchema;
    expect(
      request.safeParse({ ...address, sha256: SHA, via: null }).success,
    ).toBe(true);
    expect(request.safeParse({ ...address, sha256: SHA }).success).toBe(false);
    expect(
      response.safeParse({
        kind: "url",
        url: "http://127.0.0.1:4310/page/token",
      }).success,
    ).toBe(true);
    expect(
      response.safeParse({ kind: "unavailable", reason: "missing" }).success,
    ).toBe(true);
    expect(response.safeParse({ kind: "url", url: "page/token" }).success).toBe(
      false,
    );
  });
});

describe("epic.state.subscribe@1.2 files arm", () => {
  const snapshotBase = {
    kind: "snapshot",
    authorityEpoch: "epoch-1",
    position: 0,
    basis: "cold",
    reconciledWithCloud: false,
    epicMeta: { revision: 0, meta: { title: "An epic", updatedAt: 1 } },
    artifactRecords: [],
    deletedArtifacts: [],
    roleClaims: { revision: 0, claims: [] },
    commentThreads: [],
    hasBinaryPayload: false,
  };
  const deltaBase = {
    kind: "delta",
    authorityEpoch: "epoch-1",
    seq: 1,
    artifactUpserts: [],
    artifactTombstones: [],
    commentThreadUpserts: [],
    commentThreadRemovals: [],
    epicMeta: null,
    roleClaims: null,
    hasBinaryPayload: false,
  };
  const entry = {
    v: 1,
    kind: "page",
    sha256: SHA,
    byteLength: 12,
    mediaType: "text/html",
    status: "published",
    createdAt: 1,
  };
  const filesProjection = {
    revision: 3,
    files: [
      {
        path: "files/pages/report-1.html",
        entry,
        localState: { kind: "present" },
      },
    ],
  };

  it("requires `files` on the snapshot, where @1.1 neither requires nor carries it", () => {
    expect(
      epicStateSubscribeServerFrameSchemaV12.safeParse(snapshotBase).success,
    ).toBe(false);
    expect(
      epicStateSubscribeServerFrameSchemaV12.safeParse({
        ...snapshotBase,
        files: filesProjection,
      }).success,
    ).toBe(true);
    expect(
      epicStateSubscribeServerFrameSchemaV11.safeParse(snapshotBase).success,
    ).toBe(true);
  });

  it("counts `files` as a change, so a files-only delta is a legal envelope", () => {
    const filesOnly = { ...deltaBase, files: filesProjection };
    expect(
      epicStateSubscribeServerFrameSchemaV12.safeParse(filesOnly).success,
    ).toBe(true);
    // Nothing else changed and `files` is null: still an empty envelope.
    expect(
      epicStateSubscribeServerFrameSchemaV12.safeParse({
        ...deltaBase,
        files: null,
      }).success,
    ).toBe(false);
  });

  it("requires a delta to say whether it touched files (null), unlike @1.1", () => {
    const withMeta = {
      ...deltaBase,
      roleClaims: { revision: 1, claims: [] },
    };
    expect(
      epicStateSubscribeServerFrameSchemaV12.safeParse(withMeta).success,
    ).toBe(false);
    expect(
      epicStateSubscribeServerFrameSchemaV12.safeParse({
        ...withMeta,
        files: null,
      }).success,
    ).toBe(true);
    expect(
      epicStateSubscribeServerFrameSchemaV11.safeParse(withMeta).success,
    ).toBe(true);
  });

  it("types localState as present | absent | downloading with byte counts", () => {
    const withState = (localState: unknown) =>
      epicStateSubscribeServerFrameSchemaV12.safeParse({
        ...snapshotBase,
        files: {
          revision: 0,
          files: [{ path: "files/a.txt", entry, localState }],
        },
      }).success;
    expect(withState({ kind: "absent" })).toBe(true);
    expect(withState({ kind: "downloading", received: 5, total: 10 })).toBe(
      true,
    );
    expect(withState({ kind: "downloading" })).toBe(false);
    expect(withState({ kind: "uploading" })).toBe(false);
  });

  it("is the @1.2 contract of the line, not yet registered", () => {
    expect(epicStateSubscribeV12.schemaVersion).toEqual({ major: 1, minor: 2 });
    expect(epicStateSubscribeV12.serverFrameSchema).toBe(
      epicStateSubscribeServerFrameSchemaV12,
    );
  });
});

describe("the manifest entry", () => {
  const entry = {
    v: 1,
    kind: "page",
    sha256: SHA,
    byteLength: 12,
    mediaType: "text/html",
    status: "published",
    createdAt: 1,
  };

  it("defaults the two nullable keys an older writer omitted", () => {
    const parsed = epicFileEntrySchema.parse(entry);
    expect(parsed.derivedFrom).toBeNull();
    expect(parsed.deletedAt).toBeNull();
  });

  it("keeps an entry a newer host wrote: higher v, unknown kind and status, extra keys", () => {
    const parsed = epicFileEntrySchema.parse({
      ...entry,
      v: 7,
      kind: "hologram",
      status: "teleporting",
      addedLater: true,
    });
    expect(parsed).toMatchObject({
      v: 7,
      kind: "hologram",
      status: "teleporting",
    });
  });

  it("refuses an entry whose content address or size is malformed", () => {
    expect(
      epicFileEntrySchema.safeParse({ ...entry, sha256: "xyz" }).success,
    ).toBe(false);
    expect(
      epicFileEntrySchema.safeParse({ ...entry, byteLength: -1 }).success,
    ).toBe(false);
    expect(
      epicFileEntrySchema.safeParse({ ...entry, byteLength: 1.5 }).success,
    ).toBe(false);
  });

  describe("paths", () => {
    it.each([
      "files/a.txt",
      "files/pages/report-1.html",
      "files/mcp-apps/abc.html",
      "files/dir/with space.md",
    ])("accepts %s as a key", (path) => {
      expect(isEpicFilePath(path)).toBe(true);
    });

    it.each([
      ["empty", ""],
      ["outside files/", "pages/a.html"],
      ["leading slash", "/files/a.txt"],
      ["a traversal segment", "files/../secret"],
      ["a host projection", "files/.index.md"],
      ["a dot-prefixed segment", "files/.hidden/a.txt"],
      ["an empty segment", "files//a.txt"],
      ["a trailing slash", "files/pages/"],
      ["a backslash", "files\\a.txt"],
      ["a newline (log forging)", "files/a\r\nb.txt"],
      ["a NUL", "files/a\u0000.txt"],
      ["DEL", "files/a\u007f.txt"],
      ["over 1024 characters", `files/${"a".repeat(1019)}`],
    ])("rejects %s", (_label, path) => {
      expect(isEpicFilePath(path)).toBe(false);
    });

    it("accepts a path of exactly 1024 characters", () => {
      expect(isEpicFilePath(`files/${"a".repeat(1018)}`)).toBe(true);
    });
  });

  describe("producer namespaces", () => {
    it("are exactly files/pages/ and files/mcp-apps/", () => {
      expect(isEpicFileProducerPath("files/pages/x.html")).toBe(true);
      expect(isEpicFileProducerPath("files/mcp-apps/x.html")).toBe(true);
      expect(isEpicFileProducerPath("files/notes.md")).toBe(false);
      // A sibling that merely shares the prefix characters is the drop zone.
      expect(isEpicFileProducerPath("files/pages-old/x.html")).toBe(false);
      expect(isEpicFileProducerPath("files/mcp-apps")).toBe(false);
    });
  });

  describe("path@sha references", () => {
    it("round-trips through format and parse", () => {
      const ref = { path: "files/pages/report-1.html", sha256: SHA };
      expect(formatEpicFileRef(ref)).toBe(`files/pages/report-1.html@${SHA}`);
      expect(parseEpicFileRef(formatEpicFileRef(ref))).toEqual(ref);
    });

    it("splits at the LAST @, so a file name may contain one", () => {
      const ref = { path: "files/me@work.md", sha256: OTHER_SHA };
      expect(parseEpicFileRef(formatEpicFileRef(ref))).toEqual(ref);
    });

    it.each([
      ["no separator", "files/a.txt"],
      ["a short sha", "files/a.txt@abc"],
      ["an uppercase sha", `files/a.txt@${"A".repeat(64)}`],
      ["a path that cannot key the manifest", `../a.txt@${SHA}`],
      ["an empty path", `@${SHA}`],
    ])("returns null for %s", (_label, value) => {
      expect(parseEpicFileRef(value)).toBeNull();
    });
  });
});

describe("MCP App stamp vocabularies", () => {
  describe("CSP origins", () => {
    it.each([
      "https://example.com",
      "wss://stream.example.com",
      "https://*.example.com",
      "https://example.com:8443",
      "https://cdn-1.example.co.uk",
    ])("admit %s", (origin) => {
      expect(MCP_UI_CSP_DOMAIN_PATTERN.test(origin)).toBe(true);
    });

    it.each([
      ["a directive separator", "https://example.com; script-src *"],
      ["a single quote", "https://example.com'"],
      ["a double quote", 'https://example.com"'],
      ["a space", "https://example.com evil.com"],
      ["a CSP keyword", "'unsafe-inline'"],
      ["a bare keyword", "self"],
      ["a wildcard host", "*"],
      ["a scheme-only source", "https:"],
      ["plain http", "http://example.com"],
      ["a data: source", "data:"],
      ["a path", "https://example.com/path"],
      ["a mid-label wildcard", "https://a.*.example.com"],
      ["a newline", "https://example.com\nscript-src *"],
      ["an uppercase host", "https://Example.com"],
    ])("reject %s", (_label, origin) => {
      expect(MCP_UI_CSP_DOMAIN_PATTERN.test(origin)).toBe(false);
    });

    const emptyCsp = {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    };

    it("is enforced on every one of the four lists", () => {
      for (const key of Object.keys(emptyCsp)) {
        expect(
          mcpUiCspNormalizedSchema.safeParse({
            ...emptyCsp,
            [key]: ["https://example.com"],
          }).success,
        ).toBe(true);
        expect(
          mcpUiCspNormalizedSchema.safeParse({
            ...emptyCsp,
            [key]: ["https://example.com; img-src *"],
          }).success,
        ).toBe(false);
      }
    });

    it("allows 32 entries in a list and rejects 33", () => {
      const origins = (count: number) =>
        Array.from(
          { length: count },
          (_unused, i) => `https://h${i}.example.com`,
        );
      expect(
        mcpUiCspNormalizedSchema.safeParse({
          ...emptyCsp,
          connectDomains: origins(32),
        }).success,
      ).toBe(true);
      expect(
        mcpUiCspNormalizedSchema.safeParse({
          ...emptyCsp,
          connectDomains: origins(33),
        }).success,
      ).toBe(false);
    });

    it("requires every list to be present", () => {
      expect(
        mcpUiCspNormalizedSchema.safeParse({
          connectDomains: [],
          resourceDomains: [],
          frameDomains: [],
        }).success,
      ).toBe(false);
    });
  });

  describe("device permissions", () => {
    it.each(["camera", "microphone", "geolocation", "clipboard-write"])(
      "admit %s",
      (permission) => {
        expect(mcpUiPermissionSchema.safeParse(permission).success).toBe(true);
      },
    );

    it.each(["clipboard-read", "payment", "camera; microphone", "", "Camera"])(
      "reject %j",
      (permission) => {
        expect(mcpUiPermissionSchema.safeParse(permission).success).toBe(false);
      },
    );
  });
});
