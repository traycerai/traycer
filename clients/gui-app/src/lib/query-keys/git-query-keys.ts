/**
 * Query key builders for Git host RPC methods.
 * All keys are prefixed with hostQueryKeys.scope(hostId) to enable broad invalidation by host scope, per ADR-0006.
 */

import type { GitStage } from "@traycer/protocol/host";
import { hostQueryKeys } from "./host-query-keys";

export const gitQueryKeys = {
  /**
   * Query key for git.getCapabilities RPC.
   * Scope: single host, single running directory.
   */
  capabilities: (hostId: string | null, runningDir: string) =>
    [
      ...hostQueryKeys.scope(hostId),
      "git",
      "capabilities",
      runningDir,
    ] as const,

  /**
   * Query key for git.listChangedFiles RPC.
   * Scope: single host, single running directory, with whitespace-ignore flag.
   */
  listChangedFiles: (
    hostId: string | null,
    runningDir: string,
    ignoreWhitespace: boolean,
  ) =>
    [
      ...hostQueryKeys.scope(hostId),
      "git",
      "listChangedFiles",
      runningDir,
      ignoreWhitespace,
    ] as const,

  /**
   * Query key for the submodule-aware nested snapshot (parent changeset + `submodules[]`) - the RICH slot.
   * A distinct slot from `listChangedFiles` so a minor-0 `subscribeStatus` frame (which feeds the v1.0 slot) never clobbers the richer nested snapshot.
   */
  listChangedFilesWithSubmodules: (
    hostId: string | null,
    runningDir: string,
    ignoreWhitespace: boolean,
  ) =>
    [
      ...hostQueryKeys.scope(hostId),
      "git",
      "listChangedFilesWithSubmodules",
      runningDir,
      ignoreWhitespace,
    ] as const,

  /**
   * Query key for git.getFileDiff RPC.
   * Scope: single host, single file, with all diff parameters.
   */
  // eslint-disable-next-line max-params -- All parameters are semantically distinct and required for cache identity.
  fileDiff: (
    hostId: string | null,
    runningDir: string,
    filePath: string,
    previousPath: string | null,
    stage: GitStage,
    headSha: string,
    stagedOid: string | null,
    worktreeOid: string | null,
    ignoreWhitespace: boolean,
    byteBudget: number | null,
  ) =>
    [
      ...hostQueryKeys.scope(hostId),
      "git",
      "fileDiff",
      runningDir,
      filePath,
      previousPath,
      stage,
      headSha,
      stagedOid,
      worktreeOid,
      ignoreWhitespace,
      byteBudget,
    ] as const,

  /** Prefix for `fileDiff` queries under a (host, runningDir) scope. */
  fileDiffPrefix: (hostId: string | null, runningDir: string) =>
    [...hostQueryKeys.scope(hostId), "git", "fileDiff", runningDir] as const,

  /**
   * Predicate matching `fileDiff` queries under a (host, runningDir) scope, optionally narrowed to a set of file paths.
   */
  matchFileDiff(
    queryKey: ReadonlyArray<unknown>,
    hostId: string | null,
    runningDir: string,
    paths: ReadonlySet<string> | null,
  ): boolean {
    const prefix = gitQueryKeys.fileDiffPrefix(hostId, runningDir);
    if (queryKey.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (queryKey[i] !== prefix[i]) return false;
    }
    if (paths === null) return true;
    const path = queryKey[prefix.length];
    return typeof path === "string" && paths.has(path);
  },

  /**
   * Matches Git capability probes across both the legacy custom key and the generic host RPC key used by `useGitCapabilitiesQuery`.
   */
  matchGitCapabilitiesQuery(queryKey: ReadonlyArray<unknown>): boolean {
    return queryKey.some(
      (part, index) =>
        part === "git.getCapabilities" ||
        (part === "git" && queryKey[index + 1] === "capabilities"),
    );
  },
};
