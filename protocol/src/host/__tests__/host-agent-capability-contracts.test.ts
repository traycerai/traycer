import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { agentArchiveV10 } from "@traycer/protocol/host/agent/archive";
import {
  hostFileReadV10,
  hostFileWriteV10,
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
  hostFileReadV10.method,
  hostFileWriteV10.method,
  hostOneOffShellRunV10.method,
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

  it("parses a host.file.read request and a one-off shell result", () => {
    expect(
      hostFileReadV10.requestSchema.parse({
        epicId: "epic-1",
        path: "/tmp/workspace/a.txt",
        encoding: "utf8",
      }).encoding,
    ).toBe("utf8");
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
});
