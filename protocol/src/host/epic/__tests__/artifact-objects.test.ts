import { describe, expect, it } from "vitest";

import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

import {
  EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES,
  epicReadArtifactObjectV10,
} from "@traycer/protocol/host/epic/artifact-objects";

/**
 * `epic.readArtifactObject`'s wire shapes: the sha-addressed read request and
 * its text/bytes/url/unavailable/downloading answer arms.
 *
 * Every assertion is at a parse boundary - what a peer may send and what a
 * reader must refuse - because the object is addressed by content and
 * rendered by clients.
 */

const SHA = "a".repeat(64);

describe("epic.readArtifactObject", () => {
  const request = epicReadArtifactObjectV10.requestSchema;
  const body = { epicId: "epic-1", sha256: SHA, want: { kind: "text" } };

  it("is an optional method: registered at 1.0, degrading as unsupported, and off the released floor", () => {
    // A name on the released floor is handshake-fatal against every released
    // peer, so a method added later has to degrade instead.
    const entry = hostRpcRegistry["epic.readArtifactObject"];
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract).toBe(epicReadArtifactObjectV10);
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "epic.readArtifactObject",
    );
  });

  it("addresses the object by epic and sha alone, with no path and no via hint", () => {
    expect(request.safeParse(body).success).toBe(true);
    const parsed = request.parse({
      ...body,
      path: "files/pages/report-1.html",
      via: null,
    });
    expect(parsed).toEqual(body);
  });

  it.each([
    ["text", { kind: "text" }],
    ["url", { kind: "url" }],
    ["range", { kind: "range", offset: 0, length: 1024 }],
  ])("accepts a %s read", (_label, want) => {
    expect(request.safeParse({ ...body, want }).success).toBe(true);
  });

  it("caps a range read at 4 MiB, inclusive", () => {
    const at = {
      ...body,
      want: {
        kind: "range",
        offset: 0,
        length: EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES,
      },
    };
    const over = {
      ...body,
      want: {
        kind: "range",
        offset: 0,
        length: EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES + 1,
      },
    };
    expect(EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES).toBe(4 * 1024 * 1024);
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
    expect(request.safeParse({ ...body, want }).success).toBe(false);
  });

  it("rejects a sha that is not 64 lowercase hex characters, and an empty epicId", () => {
    for (const sha256 of ["A".repeat(64), "a".repeat(63), `${SHA}0`, ""]) {
      expect(request.safeParse({ ...body, sha256 }).success).toBe(false);
    }
    expect(request.safeParse({ ...body, epicId: "" }).success).toBe(false);
  });

  describe("answer", () => {
    const response = epicReadArtifactObjectV10.responseSchema;

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

    it("answers unavailable for the three reasons a sha-addressed read can hit, and no others", () => {
      for (const reason of ["missing", "not-downloaded", "failed"]) {
        expect(
          response.safeParse({ kind: "unavailable", reason }).success,
        ).toBe(true);
      }
      // These two belong to a path-addressed read: there is no upload queue or
      // local-only copy to name when the caller holds only a sha.
      for (const reason of ["upload-pending", "local-only"]) {
        expect(
          response.safeParse({ kind: "unavailable", reason }).success,
        ).toBe(false);
      }
      expect(
        response.safeParse({ kind: "unavailable", reason: "timeout" }).success,
      ).toBe(false);
    });

    it("reports download progress, and refuses progress that exceeds its total", () => {
      expect(
        response.safeParse({
          kind: "downloading",
          receivedBytes: 5,
          totalBytes: 10,
        }).success,
      ).toBe(true);
      expect(
        response.safeParse({
          kind: "downloading",
          receivedBytes: 11,
          totalBytes: 10,
        }).success,
      ).toBe(false);
    });

    it.each([
      ["negative receivedBytes", { receivedBytes: -1, totalBytes: 10 }],
      ["negative totalBytes", { receivedBytes: 0, totalBytes: -1 }],
      ["fractional receivedBytes", { receivedBytes: 1.5, totalBytes: 10 }],
      ["fractional totalBytes", { receivedBytes: 1, totalBytes: 10.5 }],
    ])("refuses downloading progress with %s", (_label, progress) => {
      expect(
        response.safeParse({ kind: "downloading", ...progress }).success,
      ).toBe(false);
    });

    it("accepts zero progress and progress equal to its total", () => {
      for (const progress of [
        { receivedBytes: 0, totalBytes: 0 },
        { receivedBytes: 10, totalBytes: 10 },
      ]) {
        expect(
          response.safeParse({ kind: "downloading", ...progress }).success,
        ).toBe(true);
      }
    });
  });
});
