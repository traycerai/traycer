import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  workspaceSubscribeFileListClientFrameSchema,
  workspaceSubscribeFileListServerFrameSchema,
  workspaceSubscribeFileListV10,
} from "@traycer/protocol/host/workspace/subscribe";

/**
 * `workspace.subscribeFileList@1.0` contract fixtures + registry membership.
 *
 * Guards the two properties the rest of the feature is built on: the frames are
 * single-level by construction (no depth field can be smuggled in), and the
 * method stays OFF the released floor so its degrade-to-`workspace.listFileTree`
 * story remains the only compatibility path.
 */

const ENTRY_FIXTURE = {
  path: "src/index.ts",
  name: "index.ts",
  kind: "file" as const,
  ignored: false,
};

describe("workspace.subscribeFileList@1.0 open request", () => {
  it("requires a workspacePath and carries no depth", () => {
    expect(
      workspaceSubscribeFileListV10.openRequestSchema.parse({
        workspacePath: "/repo",
        depth: 3,
      }),
    ).toEqual({ workspacePath: "/repo" });
    expect(() =>
      workspaceSubscribeFileListV10.openRequestSchema.parse({}),
    ).toThrow();
  });
});

describe("workspace.subscribeFileList@1.0 server frames", () => {
  it("parses a listing frame for the workspace root", () => {
    const parsed = workspaceSubscribeFileListServerFrameSchema.parse({
      kind: "listing",
      directoryPath: "",
      entries: [
        { path: "src/", name: "src", kind: "directory", ignored: false },
        ENTRY_FIXTURE,
        { path: "dist/", name: "dist", kind: "directory", ignored: true },
      ],
      truncated: false,
      hasBinaryPayload: false,
    });
    if (parsed.kind !== "listing") throw new Error("expected listing");
    expect(parsed.directoryPath).toBe("");
    expect(parsed.entries.map((entry) => entry.path)).toEqual([
      "src/",
      "src/index.ts",
      "dist/",
    ]);
    expect(parsed.entries[2].ignored).toBe(true);
  });

  it("parses a truncated listing for a nested directory", () => {
    const parsed = workspaceSubscribeFileListServerFrameSchema.parse({
      kind: "listing",
      directoryPath: "src/",
      entries: [ENTRY_FIXTURE],
      truncated: true,
      hasBinaryPayload: false,
    });
    if (parsed.kind !== "listing") throw new Error("expected listing");
    expect(parsed.truncated).toBe(true);
  });

  it("rejects an entry missing the ignored flag or carrying an unknown kind", () => {
    expect(() =>
      workspaceSubscribeFileListServerFrameSchema.parse({
        kind: "listing",
        directoryPath: "src/",
        entries: [{ path: "src/a.ts", name: "a.ts", kind: "file" }],
        truncated: false,
        hasBinaryPayload: false,
      }),
    ).toThrow();
    expect(() =>
      workspaceSubscribeFileListServerFrameSchema.parse({
        kind: "listing",
        directoryPath: "src/",
        entries: [{ ...ENTRY_FIXTURE, kind: "socket" }],
        truncated: false,
        hasBinaryPayload: false,
      }),
    ).toThrow();
  });

  it("parses a pruned frame for each reason and rejects unknown reasons", () => {
    for (const reason of ["missing", "limit", "error"]) {
      const parsed = workspaceSubscribeFileListServerFrameSchema.parse({
        kind: "pruned",
        directoryPaths: ["src/legacy/", "src/legacy/nested/"],
        reason,
        hasBinaryPayload: false,
      });
      if (parsed.kind !== "pruned") throw new Error("expected pruned");
      expect(parsed.reason).toBe(reason);
      expect(parsed.directoryPaths).toHaveLength(2);
    }
    expect(() =>
      workspaceSubscribeFileListServerFrameSchema.parse({
        kind: "pruned",
        directoryPaths: ["src/"],
        reason: "denied",
        hasBinaryPayload: false,
      }),
    ).toThrow();
  });

  it("parses a text-only pong frame and rejects a binary listing", () => {
    expect(
      workspaceSubscribeFileListServerFrameSchema.parse({
        kind: "pong",
        hasBinaryPayload: false,
      }).kind,
    ).toBe("pong");
    expect(() =>
      workspaceSubscribeFileListServerFrameSchema.parse({
        kind: "listing",
        directoryPath: "",
        entries: [],
        truncated: false,
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });
});

describe("workspace.subscribeFileList@1.0 client frames", () => {
  it("parses batched watch/unwatch frames without a depth field", () => {
    const watched = workspaceSubscribeFileListClientFrameSchema.parse({
      kind: "watch",
      directoryPaths: ["src/", "src/host/"],
      depth: 2,
      hasBinaryPayload: false,
    });
    if (watched.kind !== "watch") throw new Error("expected watch");
    expect(watched).toEqual({
      kind: "watch",
      directoryPaths: ["src/", "src/host/"],
      hasBinaryPayload: false,
    });

    const unwatched = workspaceSubscribeFileListClientFrameSchema.parse({
      kind: "unwatch",
      directoryPaths: ["src/"],
      hasBinaryPayload: false,
    });
    if (unwatched.kind !== "unwatch") throw new Error("expected unwatch");
    expect(unwatched.directoryPaths).toEqual(["src/"]);
  });

  it("parses a text-only ping frame", () => {
    expect(
      workspaceSubscribeFileListClientFrameSchema.parse({
        kind: "ping",
        hasBinaryPayload: false,
      }).kind,
    ).toBe("ping");
  });
});

describe("workspace.subscribeFileList@1.0 registry membership", () => {
  it("is registered on the stream registry at major 1 / minor 0", () => {
    const entry = hostStreamRpcRegistry["workspace.subscribeFileList"];
    expect(entry).toBeDefined();
    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract).toBe(workspaceSubscribeFileListV10);
    expect(workspaceSubscribeFileListV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
  });

  it("stays off the released unary floor so the fallback stays the contract", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "workspace.subscribeFileList",
    );
    expect(RELEASED_FLOOR_METHOD_NAMES).toContain("workspace.listFileTree");
  });
});
