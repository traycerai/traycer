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
  parseCanonicalHostResponse,
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
    const parsed = parseCanonicalHostResponse(
      "comments.listThreads",
      commentsListThreadsResponseSchema,
      result,
    );
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
    const parsed = parseCanonicalHostResponse(
      "comments.setThreadStatus",
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

/**
 * Absolute in, absolute out - unconditionally.
 *
 * This used to resolve a relative path only when the result existed on disk,
 * and otherwise forwarded the caller's relative string untouched. That made the
 * request shape depend on the filesystem: the same `comments list docs/a.md`
 * sent an absolute path when the file was there and a relative one when it was
 * not, and the host has no way to resolve the second - it does not know the
 * caller's working directory. A typo'd path therefore failed as "no threads"
 * rather than as the missing artifact it is.
 *
 * Resolving every relative path against `process.cwd()` is also what the help
 * text now promises, so the declared contract and the wire shape agree. No
 * existence check: whether an artifact exists is the host's answer to give, and
 * asking here would only reintroduce a filesystem-dependent request.
 */
function normalizeCliArtifactPath(value: string): string {
  return path.resolve(value);
}
