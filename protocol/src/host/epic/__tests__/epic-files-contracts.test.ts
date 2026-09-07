import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  epicCaptureTabScreenshotV10,
  epicDeleteFileV10,
  epicOpenFileInBrowserV10,
  epicReadFileV10,
  epicRestoreFileV10,
  epicStartTabRecordingV10,
  epicStopTabRecordingV10,
} from "@traycer/protocol/host/epic/contracts";
import {
  captureTabScreenshotRequestSchema,
  captureTabScreenshotResponseSchema,
  epicFileEventsClientFrameSchema,
  epicFileEventsOpenRequestSchema,
  epicFileEventsServerFrameSchema,
  epicFileEventsV10,
  epicFileTombstoneRequestSchema,
  epicFileTombstoneResponseSchema,
  openEpicFileInBrowserRequestSchema,
  openEpicFileInBrowserResponseSchema,
  readEpicFileRequestSchema,
  readEpicFileResponseSchema,
  startTabRecordingRequestSchema,
  startTabRecordingResponseSchema,
  stopTabRecordingRequestSchema,
  stopTabRecordingResponseSchema,
} from "@traycer/protocol/host/epic/files";

/**
 * `epic.readFile` / `epic.deleteFile` / `epic.restoreFile` /
 * `epic.openFileInBrowser` / `epic.captureTabScreenshot` /
 * `epic.startTabRecording` / `epic.stopTabRecording` / `epic.fileEvents`
 * contract fixtures + the optional-method degrade guard.
 *
 * Every method here is a VERB against one already-known manifest entry, never
 * a directory read - there is deliberately no `epic.listFiles` (see
 * `epic/files.ts`), so this file also proves that surface stays absent.
 */

const SHA = "a".repeat(64);
const EPIC_ID = "epic-1";
const PATH = "files/recordings/clip.mp4";

describe("readEpicFileRequestSchema / readEpicFileResponseSchema", () => {
  it("round-trips a valid request, including coLocatedHostId: null", () => {
    const request = {
      epicId: EPIC_ID,
      path: PATH,
      sha256: SHA,
      coLocatedHostId: null,
    };
    expect(readEpicFileRequestSchema.parse(request)).toEqual(request);
  });

  it("round-trips a valid request with a real coLocatedHostId", () => {
    const request = {
      epicId: EPIC_ID,
      path: PATH,
      sha256: SHA,
      coLocatedHostId: "host-1",
    };
    expect(readEpicFileRequestSchema.parse(request)).toEqual(request);
  });

  it("rejects a missing coLocatedHostId key (required-and-nullable, not optional)", () => {
    expect(
      readEpicFileRequestSchema.safeParse({
        epicId: EPIC_ID,
        path: PATH,
        sha256: SHA,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-hex or wrong-length sha256", () => {
    expect(
      readEpicFileRequestSchema.safeParse({
        epicId: EPIC_ID,
        path: PATH,
        sha256: SHA.toUpperCase(),
        coLocatedHostId: null,
      }).success,
    ).toBe(false);
    expect(
      readEpicFileRequestSchema.safeParse({
        epicId: EPIC_ID,
        path: PATH,
        sha256: SHA.slice(0, 63),
        coLocatedHostId: null,
      }).success,
    ).toBe(false);
  });

  it("round-trips every kind of readEpicFileResponseSchema", () => {
    // No `local` arm: the client's only other byte channel is the asset
    // stream, keyed by workspace path, and nothing on this wire exposes the
    // epic root - so a co-located answer is always `loopback`, every size.
    expect(
      readEpicFileResponseSchema.safeParse({ kind: "local" }).success,
    ).toBe(false);

    const loopback = { kind: "loopback" as const, url: "http://127.0.0.1:1/x" };
    expect(readEpicFileResponseSchema.parse(loopback)).toEqual(loopback);

    const url = {
      kind: "url" as const,
      url: "https://cdn.example.com/x",
      expiresAt: 12345,
      mediaType: "video/mp4",
    };
    expect(readEpicFileResponseSchema.parse(url)).toEqual(url);

    const unavailable = {
      kind: "unavailable" as const,
      reason: "upload-pending" as const,
    };
    expect(readEpicFileResponseSchema.parse(unavailable)).toEqual(unavailable);
  });
});

describe("epic file manifest path validation shared by the request schemas", () => {
  it.each([
    "files/../etc/passwd",
    "/abs/x",
    ".file-staging/x.mp4",
    "files/.index.md",
  ])("rejects %s as not a manifest path", (path) => {
    expect(
      epicFileTombstoneRequestSchema.safeParse({ epicId: EPIC_ID, path })
        .success,
    ).toBe(false);
    expect(
      readEpicFileRequestSchema.safeParse({
        epicId: EPIC_ID,
        path,
        sha256: SHA,
        coLocatedHostId: null,
      }).success,
    ).toBe(false);
    expect(
      openEpicFileInBrowserRequestSchema.safeParse({ epicId: EPIC_ID, path })
        .success,
    ).toBe(false);
  });

  it("accepts an ordinary manifest key", () => {
    expect(
      epicFileTombstoneRequestSchema.safeParse({ epicId: EPIC_ID, path: PATH })
        .success,
    ).toBe(true);
  });
});

describe("epicFileTombstoneRequestSchema / epicFileTombstoneResponseSchema", () => {
  it("round-trips the shared delete/restore request", () => {
    const request = { epicId: EPIC_ID, path: PATH };
    expect(epicFileTombstoneRequestSchema.parse(request)).toEqual(request);
  });

  it("round-trips a resulting tombstone timestamp, and its null (live) state", () => {
    expect(
      epicFileTombstoneResponseSchema.parse({ deletedAt: 1700000000000 }),
    ).toEqual({ deletedAt: 1700000000000 });
    expect(epicFileTombstoneResponseSchema.parse({ deletedAt: null })).toEqual({
      deletedAt: null,
    });
  });
});

describe("openEpicFileInBrowserRequestSchema / openEpicFileInBrowserResponseSchema", () => {
  it("round-trips", () => {
    const request = { epicId: EPIC_ID, path: PATH };
    expect(openEpicFileInBrowserRequestSchema.parse(request)).toEqual(request);
    const response = { url: "http://127.0.0.1:1/x" };
    expect(openEpicFileInBrowserResponseSchema.parse(response)).toEqual(
      response,
    );
  });
});

describe("captureTabScreenshotRequestSchema / captureTabScreenshotResponseSchema", () => {
  it("round-trips the request", () => {
    const request = { epicId: EPIC_ID, tabId: "tab-1", save: true };
    expect(captureTabScreenshotRequestSchema.parse(request)).toEqual(request);
  });

  it("round-trips the saved-object response", () => {
    const response = { saved: { path: PATH, sha256: SHA } };
    expect(captureTabScreenshotResponseSchema.parse(response)).toEqual(
      response,
    );
  });

  it("round-trips the saved: null response (save was false)", () => {
    const response = { saved: null };
    expect(captureTabScreenshotResponseSchema.parse(response)).toEqual(
      response,
    );
  });
});

describe("startTabRecordingRequestSchema / startTabRecordingResponseSchema", () => {
  it("round-trips an explicit viewport", () => {
    const request = {
      epicId: EPIC_ID,
      tabId: "tab-1",
      viewport: { width: 1440, height: 900 },
    };
    expect(startTabRecordingRequestSchema.parse(request)).toEqual(request);
  });

  it("round-trips viewport: null (record the tab's live size)", () => {
    const request = { epicId: EPIC_ID, tabId: "tab-1", viewport: null };
    expect(startTabRecordingRequestSchema.parse(request)).toEqual(request);
  });

  it("round-trips both ok arms of the response", () => {
    const started = { ok: true as const, recordingId: "rec-1" };
    expect(startTabRecordingResponseSchema.parse(started)).toEqual(started);

    const refused = {
      ok: false as const,
      reason: "already-recording" as const,
    };
    expect(startTabRecordingResponseSchema.parse(refused)).toEqual(refused);
  });
});

describe("stopTabRecordingRequestSchema / stopTabRecordingResponseSchema", () => {
  it("round-trips", () => {
    const request = { epicId: EPIC_ID, recordingId: "rec-1" };
    expect(stopTabRecordingRequestSchema.parse(request)).toEqual(request);

    expect(stopTabRecordingResponseSchema.parse({ stopped: true })).toEqual({
      stopped: true,
    });
    expect(stopTabRecordingResponseSchema.parse({ stopped: false })).toEqual({
      stopped: false,
    });
  });
});

describe("epic.fileEvents@1.0 stream frames", () => {
  it("declares the method at 1.0", () => {
    expect(epicFileEventsV10.method).toBe("epic.fileEvents");
    expect(epicFileEventsV10.schemaVersion).toEqual({ major: 1, minor: 0 });
  });

  it("requires epicId on the open request", () => {
    expect(epicFileEventsOpenRequestSchema.parse({ epicId: EPIC_ID })).toEqual({
      epicId: EPIC_ID,
    });
    expect(epicFileEventsOpenRequestSchema.safeParse({}).success).toBe(false);
  });

  it("parses every server frame kind with hasBinaryPayload: false", () => {
    const refused = {
      kind: "refused" as const,
      path: ".env",
      reason: "secret-shaped" as const,
      hasBinaryPayload: false as const,
    };
    expect(epicFileEventsServerFrameSchema.parse(refused)).toEqual(refused);

    const recordingStarted = {
      kind: "recordingStarted" as const,
      recordingId: "rec-1",
      tabId: "tab-1",
      hasBinaryPayload: false as const,
    };
    expect(epicFileEventsServerFrameSchema.parse(recordingStarted)).toEqual(
      recordingStarted,
    );

    const recordingEnded = {
      kind: "recordingEnded" as const,
      recordingId: "rec-1",
      tabId: "tab-1",
      outcome: "saved" as const,
      hasBinaryPayload: false as const,
    };
    expect(epicFileEventsServerFrameSchema.parse(recordingEnded)).toEqual(
      recordingEnded,
    );

    const pong = { kind: "pong" as const, hasBinaryPayload: false as const };
    expect(epicFileEventsServerFrameSchema.parse(pong)).toEqual(pong);
  });

  it("rejects every server frame kind carrying hasBinaryPayload: true", () => {
    expect(
      epicFileEventsServerFrameSchema.safeParse({
        kind: "refused",
        path: ".env",
        reason: "secret-shaped",
        hasBinaryPayload: true,
      }).success,
    ).toBe(false);
    expect(
      epicFileEventsServerFrameSchema.safeParse({
        kind: "recordingStarted",
        recordingId: "rec-1",
        tabId: "tab-1",
        hasBinaryPayload: true,
      }).success,
    ).toBe(false);
    expect(
      epicFileEventsServerFrameSchema.safeParse({
        kind: "recordingEnded",
        recordingId: "rec-1",
        tabId: "tab-1",
        outcome: "saved",
        hasBinaryPayload: true,
      }).success,
    ).toBe(false);
    expect(
      epicFileEventsServerFrameSchema.safeParse({
        kind: "pong",
        hasBinaryPayload: true,
      }).success,
    ).toBe(false);
  });

  it("parses ping and nothing else on the client frame", () => {
    const ping = { kind: "ping" as const, hasBinaryPayload: false as const };
    expect(epicFileEventsClientFrameSchema.parse(ping)).toEqual(ping);
    expect(
      epicFileEventsClientFrameSchema.safeParse({
        kind: "ping",
        hasBinaryPayload: true,
      }).success,
    ).toBe(false);
    expect(
      epicFileEventsClientFrameSchema.safeParse({
        kind: "pong",
        hasBinaryPayload: false,
      }).success,
    ).toBe(false);
  });
});

describe("epic file plane registry posture: optional, not floor", () => {
  const UNARY_METHODS = [
    "epic.readFile",
    "epic.deleteFile",
    "epic.restoreFile",
    "epic.openFileInBrowser",
    "epic.captureTabScreenshot",
    "epic.startTabRecording",
    "epic.stopTabRecording",
  ] as const;

  it.each(UNARY_METHODS)(
    "%s is registered, unsupported-degrade, and off the released floor",
    (method) => {
      expect(Object.hasOwn(hostRpcRegistry, method)).toBe(true);
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
      expect(hostRpcRegistry[method].degrade).toEqual({
        kind: "unsupported",
      });
    },
  );

  it("wires each contract at the expected version", () => {
    expect(hostRpcRegistry["epic.readFile"][1].versions[0]?.contract).toBe(
      epicReadFileV10,
    );
    expect(hostRpcRegistry["epic.deleteFile"][1].versions[0]?.contract).toBe(
      epicDeleteFileV10,
    );
    expect(hostRpcRegistry["epic.restoreFile"][1].versions[0]?.contract).toBe(
      epicRestoreFileV10,
    );
    expect(
      hostRpcRegistry["epic.openFileInBrowser"][1].versions[0]?.contract,
    ).toBe(epicOpenFileInBrowserV10);
    expect(
      hostRpcRegistry["epic.captureTabScreenshot"][1].versions[0]?.contract,
    ).toBe(epicCaptureTabScreenshotV10);
    expect(
      hostRpcRegistry["epic.startTabRecording"][1].versions[0]?.contract,
    ).toBe(epicStartTabRecordingV10);
    expect(
      hostRpcRegistry["epic.stopTabRecording"][1].versions[0]?.contract,
    ).toBe(epicStopTabRecordingV10);
  });

  it("registers epic.fileEvents on the stream registry at major 1, latestMinor 0", () => {
    expect(Object.hasOwn(hostStreamRpcRegistry, "epic.fileEvents")).toBe(true);
    expect(hostStreamRpcRegistry["epic.fileEvents"][1].latestMinor).toBe(0);
    expect(
      hostStreamRpcRegistry["epic.fileEvents"][1].versions[0]?.contract,
    ).toBe(epicFileEventsV10);
  });

  it("never registers a listFiles verb - the manifest is a doc-replica projection", () => {
    expect(Object.hasOwn(hostRpcRegistry, "epic.listFiles")).toBe(false);
    expect(Object.hasOwn(hostRpcRegistry, "epic.listEpicFiles")).toBe(false);
    expect(Object.hasOwn(hostStreamRpcRegistry, "epic.listFiles")).toBe(false);
    expect(Object.hasOwn(hostStreamRpcRegistry, "epic.listEpicFiles")).toBe(
      false,
    );
  });
});
