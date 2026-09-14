/**
 * Wire-compat pins for `editor.openPaths` 1.0 -> 1.1. The minor is a pure
 * request-enum widening, so the guarantees that keep mixed-version pairs safe
 * are:
 *
 * - every 1.0-era request still parses under 1.1 (old client + new host);
 * - a 1.0 host hard-rejects every target the widening added - which proves the
 *   client's negotiated-version emission gate is load-bearing, not
 *   belt-and-braces;
 * - adding an id to the live `EDITORS` registry does not widen the frozen 1.0
 *   request schema;
 * - the upgrade transformer is the identity on both request and response;
 * - the registry advertises the minor;
 * - 1.1's target enum is exactly the known set. Unlike 1.0 it is built from
 *   the LIVE `EDITORS` registry, so appending an editor widens it in place -
 *   the pin below is what turns that into a deliberate decision.
 *
 * 1.2 is a different animal: a BEHAVIOR minor that changes no schema at all.
 * A 1.1 host accepts the `"system"` target for `.pdf` paths only, a 1.2 host
 * also for `.docx`, and the bump exists purely so the client can tell the two
 * apart at the handshake. Its pins are therefore about sameness - the request
 * schema is the very same object 1.1 registers, and the upgrade is the
 * identity - because that sameness is the whole claim being made.
 */
import { describe, expect, it } from "vitest";
import {
  editorOpenPathsUpgradeV10ToV11,
  editorOpenPathsUpgradeV11ToV12,
  editorOpenPathsV10,
  editorOpenPathsV11,
  editorOpenPathsV12,
} from "@traycer/protocol/host/editor/contracts";
import { EDITORS } from "@traycer/protocol/host/editor/unary-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/index";

const V10_EDITOR_IDS = ["vscode", "cursor", "windsurf", "zed"];

const V10_REQUEST = {
  editorId: "vscode" as const,
  paths: ["/work/repo/src/index.ts"],
};

/** Every target legal only from 1.1: the two OS surfaces and the later editor. */
const V11_ONLY_TARGETS = ["system", "finder", "vscodium"];

describe("editor.openPaths 1.0 -> 1.1 compatibility", () => {
  it("parses every 1.0-era request under the 1.1 schema", () => {
    for (const editorId of V10_EDITOR_IDS) {
      const result = editorOpenPathsV11.requestSchema.safeParse({
        ...V10_REQUEST,
        editorId,
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts every target the widening added", () => {
    for (const editorId of V11_ONLY_TARGETS) {
      const result = editorOpenPathsV11.requestSchema.safeParse({
        ...V10_REQUEST,
        editorId,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects every added target under the frozen 1.0 schema", () => {
    // A 1.0 host fails these exact parses - the client-side negotiated version
    // gate is what keeps them off 1.0 connections. `"vscodium"` is the
    // registry half of that promise: adding an editor to `EDITORS` must not
    // widen a frozen minor.
    for (const editorId of V11_ONLY_TARGETS) {
      const result = editorOpenPathsV10.requestSchema.safeParse({
        ...V10_REQUEST,
        editorId,
      });
      expect(result.success).toBe(false);
    }
  });

  it("upgrades 1.0 requests and responses by identity", () => {
    expect(editorOpenPathsUpgradeV10ToV11.upgradeRequest(V10_REQUEST)).toEqual(
      V10_REQUEST,
    );
    expect(editorOpenPathsUpgradeV10ToV11.upgradeResponse({})).toEqual({});
  });

  it("pins 1.1's target enum to exactly the known set", () => {
    // 1.1's `editorId` is derived from the live `EDITORS` registry, so an
    // appended editor is accepted by 1.1 the moment it is added - silently
    // changing what a host advertising 1.1 must accept. Adding an editor is
    // therefore a WIRE decision, not a registry edit: freeze the current ids
    // into 1.1 the way 1.0 is frozen, mint 1.2 for the new one, and update
    // this list. Widening this expectation alone is the wrong fix.
    expect(EDITORS.map((editor) => editor.id)).toEqual([
      "vscode",
      "cursor",
      "windsurf",
      "zed",
      "vscodium",
    ]);

    // The two non-editor targets 1.1 adds on top of that registry, and the
    // proof the enum is closed rather than open-ended.
    for (const editorId of ["system", "finder"]) {
      expect(
        editorOpenPathsV11.requestSchema.safeParse({ ...V10_REQUEST, editorId })
          .success,
      ).toBe(true);
    }
    expect(
      editorOpenPathsV11.requestSchema.safeParse({
        ...V10_REQUEST,
        editorId: "not-a-real-target",
      }).success,
    ).toBe(false);
  });

  it("registers 1.0 and 1.1 on their own minors", () => {
    const method = hostRpcRegistry["editor.openPaths"][1];
    expect(method.versions[0]?.contract).toBe(editorOpenPathsV10);
    expect(method.versions[1]?.contract).toBe(editorOpenPathsV11);
  });
});

/** Every target 1.1 legalised, reused to prove 1.2 changed none of them. */
const V11_TARGETS = [
  "vscode",
  "cursor",
  "windsurf",
  "zed",
  "vscodium",
  "system",
  "finder",
];

const V11_SYSTEM_REQUEST = {
  editorId: "system" as const,
  paths: ["/work/repo/docs/spec.docx"],
};

describe("editor.openPaths 1.1 -> 1.2 compatibility", () => {
  it("reuses 1.1's request and response schema objects verbatim", () => {
    // Reference equality, not structural: 1.2 is a behavior minor, so the two
    // contracts must point at the SAME schema objects. A structurally equal
    // copy would still pass a shape comparison while quietly making the wire
    // schema forkable - the next edit to one would silently not reach the
    // other.
    expect(editorOpenPathsV12.requestSchema).toBe(
      editorOpenPathsV11.requestSchema,
    );
    expect(editorOpenPathsV12.responseSchema).toBe(
      editorOpenPathsV11.responseSchema,
    );
    expect(editorOpenPathsV12.schemaVersion).toEqual({ major: 1, minor: 2 });
  });

  it("accepts exactly the 1.1 target set under 1.2", () => {
    for (const editorId of V11_TARGETS) {
      expect(
        editorOpenPathsV12.requestSchema.safeParse({ ...V10_REQUEST, editorId })
          .success,
      ).toBe(true);
    }
    expect(
      editorOpenPathsV12.requestSchema.safeParse({
        ...V10_REQUEST,
        editorId: "not-a-real-target",
      }).success,
    ).toBe(false);
  });

  it("upgrades 1.1 requests and responses by identity", () => {
    // Same object back, not merely an equal one - there is nothing to
    // transform when the minor carries behavior rather than schema.
    expect(
      editorOpenPathsUpgradeV11ToV12.upgradeRequest(V11_SYSTEM_REQUEST),
    ).toBe(V11_SYSTEM_REQUEST);
    expect(
      editorOpenPathsUpgradeV11ToV12.upgradeRequest(V11_SYSTEM_REQUEST),
    ).toEqual(V11_SYSTEM_REQUEST);
    expect(editorOpenPathsUpgradeV11ToV12.upgradeResponse({})).toEqual({});
  });

  it("declares the minor pair it upgrades across", () => {
    expect(editorOpenPathsUpgradeV11ToV12.from).toEqual({ major: 1, minor: 1 });
    expect(editorOpenPathsUpgradeV11ToV12.to).toEqual({ major: 1, minor: 2 });
  });

  it("advertises latestMinor 2 with all three minors registered", () => {
    const method = hostRpcRegistry["editor.openPaths"][1];
    expect(method.latestMinor).toBe(2);
    expect(method.versions[2]?.contract).toBe(editorOpenPathsV12);
    expect(method.versions[2]?.upgradeFromPreviousVersion).toBe(
      editorOpenPathsUpgradeV11ToV12,
    );
  });
});
