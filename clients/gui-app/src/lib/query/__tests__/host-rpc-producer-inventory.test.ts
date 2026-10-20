import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Static inventory for observer-free host writers and preserved non-condition
 * retry policy. The coordinator cannot see pure `fetchQuery` producers, so
 * this suite is their stated coverage boundary (T4).
 */
const guiAppSrc = path.resolve(import.meta.dirname, "../../..");

const FILE_ARTIFACT_VIEWER_WRITER =
  "components/epic-canvas/renderers/file-artifact-viewer.tsx";
const GIT_REFRESH_WRITER = "hooks/git/use-git-submodule-snapshot-refresh.ts";
const RATE_LIMIT_WRITER = "lib/rate-limits/provider-rate-limit-fetch.ts";
// In the order the source scan discovers them.
const OBSERVER_FREE_FETCH_QUERY_WRITERS = [
  FILE_ARTIFACT_VIEWER_WRITER,
  GIT_REFRESH_WRITER,
  RATE_LIMIT_WRITER,
] as const;

const CONDITION_RETRY_FALSE_PRODUCERS = [
  {
    path: "hooks/git/use-git-list-changed-files-with-submodules.ts",
    method: "git.listChangedFiles",
  },
  {
    path: "hooks/git/use-git-submodule-snapshot-refresh.ts",
    method: "git.listChangedFiles",
  },
] as const;

const NONCONDITION_RETRY_CALLSITES = [
  {
    path: "lib/host/compatibility-state.ts",
    method: "host.status",
    pattern: /retry:\s*\(failureCount,\s*error\)[\s\S]*?retryDelay:\s*0/,
  },
  {
    path: "components/chat/segments/autonomous-resume-segment.tsx",
    method: "workspace.readFile",
    pattern: /method:\s*"workspace\.readFile"[\s\S]*?retry:\s*false/,
  },
  {
    path: "hooks/agent/use-agent-plan-query.ts",
    method: "agent.gui.getPlan",
    pattern: /method:\s*"agent\.gui\.getPlan"[\s\S]*?retry:\s*false/,
  },
  {
    path: "hooks/git/use-git-capabilities-query.ts",
    method: "git.getCapabilities",
    pattern: /method:\s*"git\.getCapabilities"[\s\S]*?retry:\s*false/,
  },
  {
    path: "hooks/snapshots/use-snapshot-diff-query.ts",
    method: "snapshots.readSnapshotDiff",
    pattern: /method:\s*"snapshots\.readSnapshotDiff"[\s\S]*?retry:\s*false/,
  },
  {
    path: "hooks/host/provider-rate-limit-query-options.ts",
    method: "host.getRateLimitUsage",
    pattern: /retry:\s*false/,
  },
  {
    path: "hooks/host/use-host-rate-limit-usage-query.ts",
    method: "host.getRateLimitUsage",
    pattern: /method:\s*"host\.getRateLimitUsage"[\s\S]*?retry:\s*false/,
  },
  {
    path: "hooks/epic/use-task-delete-worktree-candidates-query.ts",
    method: "worktree.listAllForHost",
    pattern: /"worktree\.listAllForHost"[\s\S]*?retry:\s*false/,
  },
] as const;

describe("observer-free host fetchQuery producer inventory", () => {
  it("covers only the file viewer's full-save read, git manual refresh and the provider rate-limit fetch writer", () => {
    const productionSources = sourceFiles(guiAppSrc).filter(
      (relativePath) => !relativePath.includes("__tests__"),
    );

    const stampedFetchQueryWriters = productionSources.filter(
      (relativePath) => {
        const source = readFileSync(path.join(guiAppSrc, relativePath), "utf8");
        return (
          /\.fetchQuery\s*\(/.test(source) &&
          /stampHostRpcMethod\s*\(/.test(source)
        );
      },
    );

    expect(stampedFetchQueryWriters).toEqual([
      ...OBSERVER_FREE_FETCH_QUERY_WRITERS,
    ]);
  });

  it("stamps each observer-free writer with its host method", () => {
    const gitRefresh = readFileSync(
      path.join(guiAppSrc, GIT_REFRESH_WRITER),
      "utf8",
    );
    expect(gitRefresh).toMatch(
      /\.fetchQuery\s*\([\s\S]*stampHostRpcMethod\(undefined,\s*"git\.listChangedFiles"\)/,
    );
    expect(gitRefresh).toMatch(/retry:\s*false/);

    const providerRateLimitFetch = readFileSync(
      path.join(guiAppSrc, RATE_LIMIT_WRITER),
      "utf8",
    );
    expect(providerRateLimitFetch).toMatch(
      /\.fetchQuery\s*\([\s\S]*stampHostRpcMethod\(undefined,\s*"host\.getRateLimitUsage"\)/,
    );

    const fileViewer = readFileSync(
      path.join(guiAppSrc, FILE_ARTIFACT_VIEWER_WRITER),
      "utf8",
    );
    expect(fileViewer).toMatch(
      /stampHostRpcMethod\(undefined,\s*"epic\.readArtifactObject"\)[\s\S]*\.fetchQuery\s*\(|\.fetchQuery\s*\([\s\S]*stampHostRpcMethod\(undefined,\s*"epic\.readArtifactObject"\)/,
    );
  });

  it("forces retry:false on condition producers outside the builders", () => {
    for (const producer of CONDITION_RETRY_FALSE_PRODUCERS) {
      const source = readFileSync(path.join(guiAppSrc, producer.path), "utf8");
      expect(source).toMatch(
        new RegExp(
          `stampHostRpcMethod\\(undefined,\\s*"${producer.method.replaceAll(".", "\\.")}"\\)[\\s\\S]*retry:\\s*false`,
        ),
      );
    }
  });

  it("keeps the eight non-condition retry callsites explicit", () => {
    expect(NONCONDITION_RETRY_CALLSITES).toHaveLength(8);

    for (const callsite of NONCONDITION_RETRY_CALLSITES) {
      const source = readFileSync(path.join(guiAppSrc, callsite.path), "utf8");
      expect(source, callsite.path).toMatch(callsite.pattern);
    }
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "node_modules"
        ? []
        : sourceFiles(absolutePath);
    }
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [path.relative(guiAppSrc, absolutePath)];
  });
}
