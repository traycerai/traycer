/**
 * Query key builders for Git host RPC methods.
 * All keys are prefixed with hostQueryKeys.scope(hostId) to enable
 * broad invalidation by host scope, per ADR-0006.
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
   * Query key for the submodule-aware `git.listChangedFiles@1.1` nested
   * snapshot (parent changeset + `submodules[]`). A distinct slot from
   * `listChangedFiles` so the frozen v1.0 `subscribeStatus` stream, which feeds
   * the v1.0 slot, never clobbers the richer nested snapshot. Both the passive
   * fetch and the manual/bounded refresh write this stable slot (the
   * `refreshRelations` flag is a request detail, not part of cache identity).
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
   * Query key for an **epoch-scoped** submodule-aware snapshot: the same
   * `git.listChangedFiles@1.1` data, but keyed additionally by the parent
   * `epoch` (the parent subscription fingerprint). A previous-epoch snapshot
   * therefore lives under a different key, so a consumer that must never act on
   * stale metadata - the ahead-of-pin diff tile, whose pin may have moved - is
   * simply `data === undefined` (pending) until the CURRENT epoch's fetch lands.
   * Distinct from `listChangedFilesWithSubmodules` (the panel's stable shared
   * slot) via the `"epoch"` segment, so neither the panel poll nor the manual
   * refresh writes into this key.
   */
  submoduleSnapshotAtEpoch: (
    hostId: string | null,
    runningDir: string,
    ignoreWhitespace: boolean,
    epoch: string,
  ) =>
    [
      ...hostQueryKeys.scope(hostId),
      "git",
      "listChangedFilesWithSubmodules",
      "epoch",
      runningDir,
      ignoreWhitespace,
      epoch,
    ] as const,

  /**
   * Query key for git.getFileDiff RPC.
   * Scope: single host, single file, with all diff parameters.
   * Parameters include running directory, file path, previous path, stage, and OIDs for cache invalidation.
   *
   * `runningDir` is the owning repo root (the parent worktree for ordinary files,
   * the submodule `repoRoot` for a submodule's own files), so a submodule diff can
   * never collide with the parent's. `compareFromSha` is the v1.1 ahead-of-pin
   * base (`null` for ordinary stage-based diffs): it is part of cache identity so a
   * submodule's ahead-of-pin diff (`compareFromSha = <pin>`) can never collide with
   * that same path's working-tree diff (`compareFromSha = null`).
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
    compareFromSha: string | null,
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
      compareFromSha,
    ] as const,

  /**
   * Prefix for `fileDiff` queries under a (host, runningDir) scope. Used to
   * narrow `invalidateQueries({ predicate })` without reaching into the key
   * array shape at call sites.
   */
  fileDiffPrefix: (hostId: string | null, runningDir: string) =>
    [...hostQueryKeys.scope(hostId), "git", "fileDiff", runningDir] as const,

  /**
   * Predicate matching `fileDiff` queries under a (host, runningDir) scope,
   * optionally narrowed to a set of file paths.
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
};
