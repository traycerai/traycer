import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { agentArchiveV10 } from "@traycer/protocol/host/agent/archive";
import {
  HOST_FILE_COPY_MANIFEST_PATH_MAX_LENGTH,
  HOST_FILE_TRANSFER_MAX_CHUNK_BASE64_CHARS,
  HOST_FILE_TRANSFER_MAX_CHUNK_BYTES,
  HOST_FILE_TRANSFER_UNREADABLE_MESSAGE_MAX_LENGTH,
  hostDirectoryListV10,
  hostFileCopyCancelV10,
  hostFileCopyFailureSchema,
  hostFileCopyManifestSchema,
  hostFileCopySkippedUnsafeSymlinkSchema,
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
        epicId: "epic-1",
        sourceHostId: null,
        sourcePath: "/source",
        destinationPath: "/destination",
        exclude: [],
      }),
    ).toEqual({
      epicId: "epic-1",
      sourceHostId: null,
      sourcePath: "/source",
      destinationPath: "/destination",
      exclude: [],
      overwrite: "overwrite",
    });
  });

  it("requires epic scope only at path authorization boundaries", () => {
    expect(
      hostFileCopyStartV10.requestSchema.safeParse({
        sourceHostId: null,
        sourcePath: "/source",
        destinationPath: "/destination",
        exclude: [],
      }).success,
    ).toBe(false);
    expect(
      hostFileTransferEnumerateV10.requestSchema.safeParse({
        sourcePath: "/source",
        exclude: [],
        cursor: null,
      }).success,
    ).toBe(false);
    expect(
      hostFileTransferOpenV10.requestSchema.safeParse({
        sourcePath: "/source",
        relativePath: "src/index.ts",
      }).success,
    ).toBe(false);

    expect(
      hostFileCopyStatusV10.requestSchema.safeParse({ jobId: "job-1" }).success,
    ).toBe(true);
    expect(
      hostFileCopyCancelV10.requestSchema.safeParse({ jobId: "job-1" }).success,
    ).toBe(true);
    expect(
      hostFileTransferReadChunkV10.requestSchema.safeParse({
        handleId: "handle-1",
        offset: 0,
        length: 1,
      }).success,
    ).toBe(true);
    expect(
      hostFileTransferCloseV10.requestSchema.safeParse({
        handleId: "handle-1",
      }).success,
    ).toBe(true);
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
        {
          kind: "unreadable",
          relativePath: "src/private.ts",
          operation: "stat",
          message: "permission denied",
          bytesBase64: "YWJj",
          content: "MUST-NOT-SURVIVE",
        },
      ],
      nextCursor: null,
      content: "MUST-NOT-SURVIVE",
    });

    expect(parsed.entries[0]).not.toHaveProperty("bytesBase64");
    expect(parsed.entries[1]).not.toHaveProperty("bytesBase64");
    expect(parsed.entries[1]).not.toHaveProperty("content");
    expect(parsed).not.toHaveProperty("content");
  });

  it("preserves bounded per-entry enumeration failures", () => {
    for (const operation of ["stat", "readlink", "readdir"] as const) {
      const parsed = hostFileTransferEnumerateV10.responseSchema.parse({
        entries: [
          {
            kind: "unreadable",
            relativePath: "src/private.ts",
            operation,
            message: "permission denied",
          },
        ],
        nextCursor: null,
      });
      expect(parsed.entries[0]).toEqual({
        kind: "unreadable",
        relativePath: "src/private.ts",
        operation,
        message: "permission denied",
      });
    }

    expect(
      hostFileTransferEnumerateV10.responseSchema.safeParse({
        entries: [
          {
            kind: "unreadable",
            relativePath: "src/private.ts",
            operation: "stat",
            message: "x".repeat(
              HOST_FILE_TRANSFER_UNREADABLE_MESSAGE_MAX_LENGTH + 1,
            ),
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      hostFileTransferEnumerateV10.responseSchema.safeParse({
        entries: [
          {
            kind: "unreadable",
            relativePath: "src/private.ts",
            operation: "write",
            message: "destination-only operation must reject",
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it("keeps failed-job reasons bounded and out of other terminal states", () => {
    const terminalFields = {
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
        failureCount: 1,
        failures: [
          {
            relativePath: "src/private.ts",
            operation: "stat",
            message: "permission denied",
          },
        ],
        failuresOmitted: 0,
        skippedUnsafeSymlinkCount: 0,
        skippedUnsafeSymlinks: [],
        skippedUnsafeSymlinksOmitted: 0,
        bytesBase64: "YWJj",
        content: "MUST-NOT-SURVIVE",
      },
    };
    const parsed = hostFileCopyStatusV10.responseSchema.parse({
      state: "failed",
      ...terminalFields,
      reason: {
        operation: "enumerate",
        message: "source host unreachable",
        bytesBase64: "YWJj",
        content: "MUST-NOT-SURVIVE",
      },
    });

    if (parsed.state !== "failed") {
      throw new Error("expected failed copy status");
    }
    expect(parsed.manifest.failures[0]?.operation).toBe("stat");
    expect(parsed.manifest).not.toHaveProperty("bytesBase64");
    expect(parsed.manifest).not.toHaveProperty("content");
    expect(parsed.reason).toEqual({
      operation: "enumerate",
      message: "source host unreachable",
    });
    expect(parsed.reason).not.toHaveProperty("bytesBase64");
    expect(parsed.reason).not.toHaveProperty("content");

    expect(
      hostFileCopyStatusV10.responseSchema.safeParse({
        state: "failed",
        ...terminalFields,
        reason: {
          operation: "enumerate",
          message: "x".repeat(
            HOST_FILE_TRANSFER_UNREADABLE_MESSAGE_MAX_LENGTH + 1,
          ),
        },
      }).success,
    ).toBe(false);
    expect(
      hostFileCopyStatusV10.responseSchema.safeParse({
        state: "completed",
        ...terminalFields,
        reason: {
          operation: "enumerate",
          message: "must not be accepted",
        },
      }).success,
    ).toBe(false);
  });

  it("bounds host-to-host readChunk payloads independently", () => {
    expect(
      hostFileTransferReadChunkV10.responseSchema.safeParse({
        bytesBase64: "YQ==",
        bytesRead: 1,
        eof: true,
      }).success,
    ).toBe(true);
    expect(
      hostFileTransferReadChunkV10.responseSchema.safeParse({
        bytesBase64: "YQ==",
        bytesRead: HOST_FILE_TRANSFER_MAX_CHUNK_BYTES + 1,
        eof: false,
      }).success,
    ).toBe(false);
    expect(
      hostFileTransferReadChunkV10.responseSchema.safeParse({
        bytesBase64: "A".repeat(HOST_FILE_TRANSFER_MAX_CHUNK_BASE64_CHARS + 4),
        bytesRead: 1,
        eof: false,
      }).success,
    ).toBe(false);
  });

  it("rejects manifests whose counts disagree with sampled items", () => {
    const consistent = {
      summary: {
        filesCopied: 1,
        directoriesCreated: 0,
        symlinksCreated: 0,
        bytesCopied: 3,
        replacements: 0,
        skippedExisting: 0,
      },
      failureCount: 1,
      failures: [
        {
          relativePath: "src/private.ts",
          operation: "stat",
          message: "permission denied",
        },
      ],
      failuresOmitted: 0,
      skippedUnsafeSymlinkCount: 0,
      skippedUnsafeSymlinks: [],
      skippedUnsafeSymlinksOmitted: 0,
    };
    expect(hostFileCopyManifestSchema.safeParse(consistent).success).toBe(true);
    expect(
      hostFileCopyManifestSchema.safeParse({
        ...consistent,
        failureCount: 2,
      }).success,
    ).toBe(false);
    expect(
      hostFileCopyManifestSchema.safeParse({
        ...consistent,
        skippedUnsafeSymlinkCount: 1,
      }).success,
    ).toBe(false);
  });

  it("bounds sampled manifest item strings", () => {
    expect(
      hostFileCopyFailureSchema.safeParse({
        relativePath: "a".repeat(HOST_FILE_COPY_MANIFEST_PATH_MAX_LENGTH),
        operation: "stat",
        message: "x".repeat(HOST_FILE_TRANSFER_UNREADABLE_MESSAGE_MAX_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      hostFileCopyFailureSchema.safeParse({
        relativePath: "src/private.ts",
        operation: "stat",
        message: "x".repeat(
          HOST_FILE_TRANSFER_UNREADABLE_MESSAGE_MAX_LENGTH + 1,
        ),
      }).success,
    ).toBe(false);
    expect(
      hostFileCopyFailureSchema.safeParse({
        relativePath: "a".repeat(HOST_FILE_COPY_MANIFEST_PATH_MAX_LENGTH + 1),
        operation: "stat",
        message: "permission denied",
      }).success,
    ).toBe(false);

    expect(
      hostFileCopySkippedUnsafeSymlinkSchema.safeParse({
        relativePath: "a".repeat(HOST_FILE_COPY_MANIFEST_PATH_MAX_LENGTH),
        target: "b".repeat(HOST_FILE_COPY_MANIFEST_PATH_MAX_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      hostFileCopySkippedUnsafeSymlinkSchema.safeParse({
        relativePath: "link",
        target: "b".repeat(HOST_FILE_COPY_MANIFEST_PATH_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      hostFileCopySkippedUnsafeSymlinkSchema.safeParse({
        relativePath: "a".repeat(HOST_FILE_COPY_MANIFEST_PATH_MAX_LENGTH + 1),
        target: "../escape",
      }).success,
    ).toBe(false);
  });
});
