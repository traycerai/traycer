/**
 * Wire-compat pins for `editor.openPaths` 1.0 -> 1.1 (the `"system"` open
 * target). The 1.1 minor is a pure request-enum widening, so the guarantees
 * that keep mixed-version pairs safe are:
 *
 * - every 1.0-era request still parses under 1.1 (old client + new host);
 * - a 1.0 host hard-rejects `"system"` at parse - which proves the client's
 *   negotiated-version emission gate is load-bearing, not belt-and-braces;
 * - the upgrade transformer is the identity on both request and response;
 * - the registry advertises the new minor.
 */
import { describe, expect, it } from "vitest";
import {
  editorOpenPathsUpgradeV10ToV11,
  editorOpenPathsV10,
  editorOpenPathsV11,
} from "@traycer/protocol/host/editor/contracts";
import { hostRpcRegistry } from "@traycer/protocol/host/index";

const V10_REQUEST = {
  editorId: "vscode" as const,
  paths: ["/work/repo/src/index.ts"],
};

const SYSTEM_REQUEST = {
  editorId: "system",
  paths: ["/work/repo/docs/report.pdf"],
};

describe("editor.openPaths 1.0 -> 1.1 compatibility", () => {
  it("parses every 1.0-era request under the 1.1 schema", () => {
    for (const editorId of ["vscode", "cursor", "windsurf", "zed"]) {
      const result = editorOpenPathsV11.requestSchema.safeParse({
        ...V10_REQUEST,
        editorId,
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts the system target under 1.1", () => {
    const result = editorOpenPathsV11.requestSchema.safeParse(SYSTEM_REQUEST);
    expect(result.success).toBe(true);
  });

  it("rejects the system target under the frozen 1.0 schema", () => {
    // A 1.0 host would fail this exact parse - the client-side negotiated
    // version gate is what keeps "system" off 1.0 connections.
    const result = editorOpenPathsV10.requestSchema.safeParse(SYSTEM_REQUEST);
    expect(result.success).toBe(false);
  });

  it("upgrades 1.0 requests and responses by identity", () => {
    expect(editorOpenPathsUpgradeV10ToV11.upgradeRequest(V10_REQUEST)).toEqual(
      V10_REQUEST,
    );
    expect(editorOpenPathsUpgradeV10ToV11.upgradeResponse({})).toEqual({});
  });

  it("advertises latestMinor 1 with both minors registered", () => {
    const method = hostRpcRegistry["editor.openPaths"][1];
    expect(method.latestMinor).toBe(1);
    expect(method.versions[0]?.contract).toBe(editorOpenPathsV10);
    expect(method.versions[1]?.contract).toBe(editorOpenPathsV11);
  });
});
