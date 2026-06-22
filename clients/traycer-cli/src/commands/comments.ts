import { existsSync } from "node:fs";
import path from "node:path";
import {
  commentThreadStatusFilterSchema,
  commentThreadStatusSchema,
  commentsListThreadsResponseSchema,
  commentsSetThreadStatusResponseSchema,
} from "@traycer/protocol/host/comments";
import {
  formatCommentsListThreadsXml,
  formatCommentsSetThreadStatusResponse,
} from "@traycer/protocol/comments/comments-xml-formatting";
import {
  callHostRpc,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

export function buildCommentsListCommand(opts: {
  readonly epicId: string | null;
  readonly artifactPaths: readonly string[];
  readonly status: string | null;
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const status = parseUserInput(
      commentThreadStatusFilterSchema,
      opts.status ?? "all",
    );
    const artifactPaths =
      opts.artifactPaths.length === 0
        ? null
        : opts.artifactPaths.map(normalizeCliArtifactPath);
    const result = await toAgentCliError(
      callHostRpc("comments.listThreads", {
        epicId,
        artifactPaths,
        status,
      }),
    );
    const parsed = parseHostResponse(commentsListThreadsResponseSchema, result);
    return {
      data: parsed,
      human: formatCommentsListThreadsXml({
        response: parsed,
        platform: process.platform === "win32" ? "WINDOWS" : "POSIX",
        query: {
          artifactPaths,
          status,
        },
      }),
      exitCode: 0,
    };
  };
}

export function buildCommentsSetStatusCommand(opts: {
  readonly epicId: string | null;
  readonly artifactPath: string;
  readonly threadIds: readonly string[];
  readonly status: string;
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const status = parseUserInput(commentThreadStatusSchema, opts.status);
    const artifactPath = normalizeCliArtifactPath(opts.artifactPath);
    const result = await toAgentCliError(
      callHostRpc("comments.setThreadStatus", {
        epicId,
        updates: [
          {
            artifactPath,
            threadIds: [...opts.threadIds],
            status,
          },
        ],
      }),
    );
    const parsed = parseHostResponse(
      commentsSetThreadStatusResponseSchema,
      result,
    );
    return {
      data: parsed,
      human: formatCommentsSetThreadStatusResponse(parsed),
      exitCode: parsed.failed.length === 0 ? 0 : 1,
    };
  };
}

function normalizeCliArtifactPath(value: string): string {
  if (path.isAbsolute(value)) return value;
  const resolved = path.resolve(value);
  return existsSync(resolved) ? resolved : value;
}
