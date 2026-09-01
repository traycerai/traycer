import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { agentArchiveV10 } from "@traycer/protocol/host/agent/archive";
import {
  hostDirectoryListV10,
  hostFileCopyCancelV10,
  hostFileCopyStartV10,
  hostFileCopyStatusV10,
  hostFileTransferCloseV10,
  hostFileTransferEnumerateV10,
  hostFileTransferOpenV10,
  hostFileTransferReadChunkV10,
  hostOneOffShellRunV10,
  hostResolveRepoPathsV10,
} from "@traycer/protocol/host/host-agent-capabilities";
import {
  managedCommandConfigureV10,
  managedCommandCreateV10,
  managedCommandListV10,
  managedCommandRestartV10,
  managedCommandViewV10,
} from "@traycer/protocol/host/managed-command/contracts";

const NEW_METHODS = [
  agentArchiveV10.method,
  managedCommandCreateV10.method,
  managedCommandListV10.method,
  managedCommandViewV10.method,
  managedCommandConfigureV10.method,
  managedCommandRestartV10.method,
  hostResolveRepoPathsV10.method,
  hostOneOffShellRunV10.method,
  hostDirectoryListV10.method,
  hostFileCopyStartV10.method,
  hostFileCopyStatusV10.method,
  hostFileCopyCancelV10.method,
  hostFileTransferEnumerateV10.method,
  hostFileTransferOpenV10.method,
  hostFileTransferReadChunkV10.method,
  hostFileTransferCloseV10.method,
] as const;

describe("host-agent capability contracts", () => {
  it("registers every new method off the released floor with an unsupported degrade", () => {
    for (const method of NEW_METHODS) {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
      const entry = hostRpcRegistry[method];
      expect(entry).toBeDefined();
      expect(entry.degrade).toEqual({ kind: "unsupported" });
    }
  });

  it("projects a directory entry without the dialer's key material", () => {
    const parsed = hostDirectoryListV10.responseSchema.parse({
      hosts: [
        {
          hostId: "host-b",
          displayName: "Studio",
          platform: "darwin",
          appVersion: "1.2.3",
          relayAttached: true,
          busy: false,
          // A server that volunteers key material must not have it survive
          // into the agent-facing value; the closed schema strips it.
          publicKey: "MUST-NOT-SURVIVE",
        },
      ],
    });
    expect(parsed.hosts[0]).not.toHaveProperty("publicKey");
    expect(parsed.hosts[0]?.platform).toBe("darwin");
  });

  it("parses a one-off shell result", () => {
    expect(
      hostOneOffShellRunV10.responseSchema.parse({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputLimitExceeded: false,
        outputBytes: 2,
      }).exitCode,
    ).toBe(0);
  });

  it("requires a discriminated repo identity", () => {
    expect(
      hostResolveRepoPathsV10.requestSchema.safeParse({
        epicId: "epic-1",
        identity: { kind: "remote-url", remoteUrl: "https://example/r.git" },
      }).success,
    ).toBe(true);
    expect(
      hostResolveRepoPathsV10.requestSchema.safeParse({
        epicId: "epic-1",
        identity: { kind: "workspace" },
      }).success,
    ).toBe(false);
  });

  it("represents same-host copy without a sentinel and defaults overwrite mode", () => {
    expect(
      hostFileCopyStartV10.requestSchema.parse({
        sourceHostId: null,
        sourcePath: "/source",
        destinationPath: "/destination",
        exclude: [],
      }),
    ).toEqual({
      sourceHostId: null,
      sourcePath: "/source",
      destinationPath: "/destination",
      exclude: [],
      overwrite: "overwrite",
    });
  });

  it("strips byte-carrying fields from enumeration entries", () => {
    const parsed = hostFileTransferEnumerateV10.responseSchema.parse({
      entries: [
        {
          kind: "file",
          relativePath: "src/index.ts",
          mode: 0o644,
          mtimeMs: 1_700_000_000_000,
          sizeBytes: 3,
          bytesBase64: "YWJj",
        },
      ],
      nextCursor: null,
      content: "MUST-NOT-SURVIVE",
    });

    expect(parsed.entries[0]).not.toHaveProperty("bytesBase64");
    expect(parsed).not.toHaveProperty("content");
  });

  it("strips byte-carrying fields from the terminal manifest", () => {
    const parsed = hostFileCopyStatusV10.responseSchema.parse({
      state: "completed",
      progress: { filesCompleted: 1, bytesTransferred: 3 },
      manifest: {
        summary: {
          filesCopied: 1,
          directoriesCreated: 0,
          symlinksCreated: 0,
          bytesCopied: 3,
          replacements: 0,
          skippedExisting: 0,
        },
        failureCount: 0,
        failures: [],
        failuresOmitted: 0,
        skippedUnsafeSymlinkCount: 0,
        skippedUnsafeSymlinks: [],
        skippedUnsafeSymlinksOmitted: 0,
        bytesBase64: "YWJj",
        content: "MUST-NOT-SURVIVE",
      },
    });

    if (parsed.state !== "completed") {
      throw new Error("expected completed copy status");
    }
    expect(parsed.manifest).not.toHaveProperty("bytesBase64");
    expect(parsed.manifest).not.toHaveProperty("content");
  });
});
