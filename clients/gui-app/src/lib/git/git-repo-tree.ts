/**
 * Pure view-model for the Git Diff panel's repo tree and the demoted gitlink
 * "submodule reference" rows.
 *
 * The host returns one nested `git.listChangedFiles@1.1` snapshot per root repo
 * (the parent changeset - each parent file carrying a nullable `gitlink`
 * descriptor - plus a `submodules[]` array of working-tree changesets, no
 * commits-ahead). This module turns that snapshot into:
 *
 * - a split of the parent's files into ordinary text-diff files and the demoted
 *   gitlink pointer rows (deduped by path - a dual-stage `MM S.M.` gitlink emits
 *   two rows sharing one descriptor);
 * - one "Submodule reference" summary row per gitlink, reading pins/flags
 *   straight off the enriched pointer (no join) and carrying the `repoRoot` of
 *   the matching submodule node so the row can select it;
 * - one tree node per dirty submodule (working-tree change count, an
 *   "unavailable" flag, branch/HEAD label).
 *
 * Framework-free so the rules are exhaustively unit-testable; the React
 * components are thin renderers over this output.
 */
import type {
  GitChangedFileV11,
  SubmoduleChangeset,
  SubmodulePointer,
} from "@traycer/protocol/host";

const SHORT_SHA_LENGTH = 7;

function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

/**
 * `branch` when the checkout is on a branch, else `detached @ <short-sha>`, else
 * `detached` (an unborn/unknown HEAD).
 */
export function formatRepoHeadLabel(
  branch: string | null,
  headSha: string | null,
): string {
  if (branch !== null && branch.length > 0) return branch;
  if (headSha !== null && headSha.length > 0) {
    return `detached @ ${shortSha(headSha)}`;
  }
  return "detached";
}

export interface ParentFileSplit {
  /** Parent files with the demoted gitlink rows removed. */
  readonly ordinaryFiles: ReadonlyArray<GitChangedFileV11>;
  /** The gitlink pointer rows, deduped by path (dual-stage rows collapse). */
  readonly gitlinkFiles: ReadonlyArray<GitChangedFileV11>;
}

/**
 * Separate ordinary text-diff files from the parent's gitlink pointer rows. A
 * gitlink may appear twice (staged + unstaged) with one identical descriptor, so
 * gitlink rows dedup by path while ordinary files pass through untouched.
 */
export function splitParentFiles(
  files: ReadonlyArray<GitChangedFileV11>,
): ParentFileSplit {
  const ordinaryFiles: GitChangedFileV11[] = [];
  const gitlinkFiles: GitChangedFileV11[] = [];
  const seenGitlinkPaths = new Set<string>();
  for (const file of files) {
    if (file.gitlink === null) {
      ordinaryFiles.push(file);
      continue;
    }
    if (seenGitlinkPaths.has(file.path)) continue;
    seenGitlinkPaths.add(file.path);
    gitlinkFiles.push(file);
  }
  return { ordinaryFiles, gitlinkFiles };
}

/**
 * A parent gitlink row demoted to a "Submodule reference" summary. `pointer`
 * carries the raw pointer facts (enriched pins + flags, or the conflict
 * base/ours/theirs triple) read straight off the parent row - no join. `repoRoot`
 * is the matching submodule node this reference selects, or `null` when there is
 * no matching section (a conflicted pointer earns none; an old host that
 * downgraded to `submodules: []` returns none). `divergence` surfaces the
 * enriched `pointer.diverged` fact as human copy so the user need not compare
 * SHAs (`null` for a conflicted pointer, which has no single pin). `detailsUnavailable`
 * flags a "dirty pointer but no usable details" degrade - the section is either
 * missing (old-host downgrade / partial failure) or present-but-`unavailable` -
 * so the reference row shows the warning instead of reading as a normal edit.
 */
export interface SubmoduleReferenceRowView {
  readonly parentPath: string;
  readonly label: string;
  readonly pointer: SubmodulePointer;
  readonly isConflicted: boolean;
  readonly summary: string;
  readonly divergence: "diverged" | "matches" | null;
  readonly repoRoot: string | null;
  readonly detailsUnavailable: boolean;
}

/**
 * Human-readable pin-vs-checkout divergence from the enriched pointer, so the
 * user need not compare SHAs. `null` for a conflicted pointer (no single pin).
 */
function pointerDivergence(
  pointer: SubmodulePointer,
): "diverged" | "matches" | null {
  if (pointer.kind !== "normal") return null;
  return pointer.diverged ? "diverged" : "matches";
}

/** A `normal` gitlink pointer is dirty when any of its `<sub>` flags are set. */
function normalPointerIsDirty(pointer: SubmodulePointer): boolean {
  return (
    pointer.kind === "normal" &&
    (pointer.commitChanged ||
      pointer.modifiedContent ||
      pointer.untrackedContent)
  );
}

function referenceRowSummary(pointer: SubmodulePointer): string {
  if (pointer.kind === "conflicted") {
    const parts = [
      pointer.baseSha === null ? null : `base ${shortSha(pointer.baseSha)}`,
      pointer.oursSha === null ? null : `ours ${shortSha(pointer.oursSha)}`,
      pointer.theirsSha === null
        ? null
        : `theirs ${shortSha(pointer.theirsSha)}`,
    ].filter((part): part is string => part !== null);
    const pins = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    return `merge conflict on the submodule pointer${pins}`;
  }
  const segments: string[] = [
    pointer.recordedPinSha === null
      ? "parent references (none)"
      : `parent references ${shortSha(pointer.recordedPinSha)}`,
  ];
  if (pointer.submoduleHeadSha !== null) {
    segments.push(`checkout at ${shortSha(pointer.submoduleHeadSha)}`);
  }
  return segments.join(" · ");
}

/**
 * Build the demoted "Submodule reference" rows from the parent's gitlink rows,
 * joining each to its submodule section by `path` <-> `parentPath` for the
 * node it navigates to.
 */
export function buildSubmoduleReferenceRows(
  gitlinkFiles: ReadonlyArray<GitChangedFileV11>,
  submodules: ReadonlyArray<SubmoduleChangeset>,
): ReadonlyArray<SubmoduleReferenceRowView> {
  const changesetByPath = new Map<string, SubmoduleChangeset>(
    submodules.map((changeset) => [changeset.parentPath, changeset]),
  );
  return gitlinkFiles.flatMap((file) => {
    if (file.gitlink === null) return [];
    const pointer = file.gitlink;
    const changeset = changesetByPath.get(file.path) ?? null;
    return [
      {
        parentPath: file.path,
        // Full gitlink path (not basename) to disambiguate nested submodules.
        label: file.path,
        pointer,
        isConflicted: pointer.kind === "conflicted",
        summary: referenceRowSummary(pointer),
        divergence: pointerDivergence(pointer),
        repoRoot: changeset === null ? null : changeset.repoRoot,
        // A conflicted pointer is intentionally section-less (pointer-only), so a
        // missing section is expected there, not a degrade. A dirty `normal`
        // pointer degrades when the host surfaced no usable details: either no
        // section (old-host downgrade / partial failure) or a section the host
        // could not inspect (`availability: unavailable`).
        detailsUnavailable:
          normalPointerIsDirty(pointer) &&
          (changeset === null ||
            changeset.availability.state === "unavailable"),
      },
    ];
  });
}

/**
 * One dirty submodule as a repo-tree node. `changeCount` is the submodule's own
 * working-tree file count (0 when the submodule is dirty only via a committed
 * pin move - a "dimmed" node with no viewable working-tree changes).
 * `unavailable` marks a submodule the host could not inspect.
 */
export interface RepoTreeSubmoduleNode {
  readonly repoRoot: string;
  readonly parentPath: string;
  readonly label: string;
  readonly headLabel: string;
  readonly changeCount: number;
  readonly hasChanges: boolean;
  readonly unavailable: boolean;
}

function buildSubmoduleNode(
  changeset: SubmoduleChangeset,
): RepoTreeSubmoduleNode {
  const unavailable = changeset.availability.state === "unavailable";
  const headSha =
    changeset.pointer.kind === "normal"
      ? changeset.pointer.submoduleHeadSha
      : null;
  const changeCount = changeset.files.length;
  return {
    repoRoot: changeset.repoRoot,
    parentPath: changeset.parentPath,
    // The submodule's parent-repo path is the label - the full path (not the
    // basename) so nested or duplicate-basename submodules stay unambiguous.
    label: changeset.parentPath,
    headLabel: formatRepoHeadLabel(changeset.branch, headSha),
    changeCount,
    hasChanges: changeCount > 0,
    unavailable,
  };
}

export function buildSubmoduleNodes(
  submodules: ReadonlyArray<SubmoduleChangeset>,
): ReadonlyArray<RepoTreeSubmoduleNode> {
  return submodules.map(buildSubmoduleNode);
}

export function findSubmoduleChangeset(
  submodules: ReadonlyArray<SubmoduleChangeset>,
  repoRoot: string,
): SubmoduleChangeset | null {
  return (
    submodules.find((changeset) => changeset.repoRoot === repoRoot) ?? null
  );
}
