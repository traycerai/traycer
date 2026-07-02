/**
 * Host-composed group-by-repo view model for the Git Diff panel.
 *
 * The host returns one nested `git.listChangedFiles@1.1` snapshot (a single
 * epoch): the parent changeset (v1.1 files, each with a nullable `gitlink`
 * descriptor) plus a `submodules[]` array. This module turns that snapshot into
 * `repos = [ parent, ...submodules ]` for rendering, and owns every UX rule the
 * ticket locks in:
 *
 * - The parent's gitlink rows are demoted to selectable "Submodule reference"
 *   summary rows (deduped by path - a dual-stage `MM S.M.` gitlink emits two
 *   rows sharing one descriptor), never text-diff file rows. Counts separate
 *   "N files" from "M submodule references".
 * - A submodule's checkout↔pin relation collapses to three presentations:
 *   an ahead group ("Committed changes not recorded by parent"), a
 *   "Checkout differs from parent reference" bucket (behind / diverged /
 *   equal-with-WT), or a "Reference needs attention" bucket (unknown), with
 *   detail copy preserving the exact git facts. `unknown` always reads as a
 *   local-comparability limit, never a host failure.
 * - A dirty parent gitlink with no matching submodule details (an old host that
 *   downgraded to `submodules: []`) is surfaced explicitly, never omitted.
 *
 * Pure and framework-free so the rules are exhaustively unit-testable; the
 * React components are thin renderers over this output.
 */
import type {
  CommitAheadFile,
  GitChangedFileV11,
  RepoState,
  SubmoduleChangeset,
  SubmodulePointer,
  SubmoduleRelation,
} from "@traycer/protocol/host";
const SHORT_SHA_LENGTH = 7;

function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

/**
 * A parent gitlink row demoted to a "Submodule reference" summary. `pointer`
 * carries the raw pointer facts (pins + flags, or the conflict base/ours/theirs
 * triple). `checkoutHeadSha` is joined from the matching submodule changeset's
 * relation when available (the parent porcelain alone doesn't know the
 * submodule's HEAD). `detailsAvailable` is false when the host returned no
 * matching submodule section; `detailsUnavailable` narrows that to the specific
 * "dirty pointer but no details" case (an old host that downgraded, or a partial
 * per-submodule failure) so the UI can offer a targeted affordance instead of
 * silently dropping the row.
 */
export interface SubmoduleReferenceRowView {
  readonly parentPath: string;
  readonly label: string;
  readonly pointer: SubmodulePointer;
  readonly checkoutHeadSha: string | null;
  readonly detailsAvailable: boolean;
  readonly detailsUnavailable: boolean;
  readonly summary: string;
}

export interface ParentRepoView {
  readonly runningDir: string;
  readonly label: string;
  readonly branch: string | null;
  readonly headSha: string;
  readonly headLabel: string;
  readonly repoState: RepoState;
  /** Parent files with the demoted gitlink rows removed. */
  readonly files: ReadonlyArray<GitChangedFileV11>;
  readonly referenceRows: ReadonlyArray<SubmoduleReferenceRowView>;
  readonly fileCount: number;
  readonly referenceCount: number;
  readonly countsLabel: string;
}

/**
 * The relation axis collapsed to one of three renderable presentations. The
 * `ahead` bucket is the only one that carries a file group (the commits the
 * submodule holds beyond the parent-recorded pin); the other two are summary
 * banners with no relation-derived file group (the submodule's own worktree
 * files render separately, regardless of relation).
 */
export type SubmoduleRelationPresentation =
  | {
      readonly bucket: "ahead";
      readonly heading: string;
      readonly commitCount: number;
      readonly files: ReadonlyArray<CommitAheadFile>;
      readonly detail: string;
    }
  | {
      readonly bucket: "checkout-differs";
      readonly heading: string;
      readonly detail: string;
    }
  | {
      readonly bucket: "needs-attention";
      readonly heading: string;
      readonly detail: string;
    };

export interface SubmoduleRepoView {
  readonly repoRoot: string;
  readonly parentPath: string;
  readonly label: string;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly headLabel: string;
  readonly repoState: RepoState;
  readonly relation: SubmoduleRelation;
  readonly presentation: SubmoduleRelationPresentation;
  /** The submodule's own worktree / index / untracked / conflicted files. */
  readonly files: ReadonlyArray<GitChangedFileV11>;
}

export interface GitReposComposition {
  readonly parent: ParentRepoView;
  readonly submodules: ReadonlyArray<SubmoduleRepoView>;
  /**
   * True when the group-by-repo layout should engage: there is at least one
   * submodule section OR at least one demoted parent gitlink reference row. When
   * false the panel renders exactly as the single-repo case does today.
   */
  readonly hasSubmoduleContent: boolean;
}

const CHECKOUT_DIFFERS_HEADING = "Checkout differs from parent reference";
const NEEDS_ATTENTION_HEADING = "Reference needs attention";

/**
 * `branch` when the checkout is on a branch, else `detached @ <short-sha>`. When
 * neither is known (an unborn/broken submodule HEAD) falls back to `detached`.
 */
export function formatHeadLabel(
  branch: string | null,
  headSha: string | null,
): string {
  if (branch !== null && branch.length > 0) return branch;
  if (headSha !== null && headSha.length > 0) {
    return `detached @ ${shortSha(headSha)}`;
  }
  return "detached";
}

function formatCounts(fileCount: number, referenceCount: number): string {
  const filesPart = `${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  if (referenceCount === 0) return filesPart;
  const referencesPart = `${referenceCount} submodule ${
    referenceCount === 1 ? "reference" : "references"
  }`;
  return `${filesPart} · ${referencesPart}`;
}

function referenceRowSummary(
  pointer: SubmodulePointer,
  checkoutHeadSha: string | null,
): string {
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
  const segments: string[] = [];
  segments.push(
    pointer.recordedPinSha === null
      ? "parent references (none)"
      : `parent references ${shortSha(pointer.recordedPinSha)}`,
  );
  if (
    pointer.stagedPinSha !== null &&
    pointer.stagedPinSha !== pointer.recordedPinSha
  ) {
    segments.push(`staged ${shortSha(pointer.stagedPinSha)}`);
  }
  if (checkoutHeadSha !== null) {
    segments.push(`checkout at ${shortSha(checkoutHeadSha)}`);
  }
  return segments.join(", ");
}

/**
 * Classify a computed relation into its renderable presentation. `equal` and
 * `behind`/`diverged` all collapse to the "Checkout differs from parent
 * reference" bucket (equal means the checkout matches the pin but the working
 * tree carries uncommitted changes); `unknown` collapses to "Reference needs
 * attention" and always reads as a local-comparability limit.
 */
export function classifyRelationPresentation(
  relation: SubmoduleRelation,
): SubmoduleRelationPresentation {
  switch (relation.state) {
    case "ahead": {
      const count = relation.commitsAhead.count;
      return {
        bucket: "ahead",
        heading: `Committed changes not recorded by parent (${count} ${
          count === 1 ? "commit" : "commits"
        })`,
        commitCount: count,
        files: relation.commitsAhead.files,
        detail: `${count} ${
          count === 1 ? "commit is" : "commits are"
        } present in this checkout but not recorded by the parent (parent references ${shortSha(
          relation.recordedPinSha,
        )}, checkout at ${shortSha(relation.submoduleHeadSha)}).`,
      };
    }
    case "behind":
      return {
        bucket: "checkout-differs",
        heading: CHECKOUT_DIFFERS_HEADING,
        detail: `The checkout is behind the parent reference (parent references ${shortSha(
          relation.recordedPinSha,
        )}, checkout at ${shortSha(relation.submoduleHeadSha)}).`,
      };
    case "diverged":
      return {
        bucket: "checkout-differs",
        heading: CHECKOUT_DIFFERS_HEADING,
        detail: `The checkout and the parent reference have diverged (parent references ${shortSha(
          relation.recordedPinSha,
        )}, checkout at ${shortSha(relation.submoduleHeadSha)}).`,
      };
    case "equal":
      return {
        bucket: "checkout-differs",
        heading: CHECKOUT_DIFFERS_HEADING,
        detail: `The checkout matches the parent reference (${shortSha(
          relation.recordedPinSha,
        )}); the working tree has uncommitted changes.`,
      };
    case "unknown":
      return {
        bucket: "needs-attention",
        heading: NEEDS_ATTENTION_HEADING,
        detail: unknownRelationDetail(relation),
      };
    default: {
      const exhaustive: never = relation;
      void exhaustive;
      return {
        bucket: "needs-attention",
        heading: NEEDS_ATTENTION_HEADING,
        detail: "Not comparable locally.",
      };
    }
  }
}

function unknownRelationDetail(
  relation: Extract<SubmoduleRelation, { state: "unknown" }>,
): string {
  switch (relation.reason) {
    case "missing-pin-object":
      return relation.recordedPinSha === null
        ? "Not comparable locally — the parent reference is not present in this submodule checkout."
        : `Not comparable locally — the parent reference (${shortSha(
            relation.recordedPinSha,
          )}) is not present in this submodule checkout.`;
    case "unborn-head":
      return "Not comparable locally — the submodule has no commits yet (unborn HEAD).";
    case "git-error":
      return "Not comparable locally — the reference comparison could not be completed.";
    default: {
      const exhaustive: never = relation.reason;
      void exhaustive;
      return "Not comparable locally.";
    }
  }
}

function buildSubmoduleView(changeset: SubmoduleChangeset): SubmoduleRepoView {
  const headSha = changeset.relation.submoduleHeadSha;
  return {
    repoRoot: changeset.repoRoot,
    parentPath: changeset.parentPath,
    // The submodule's parent-repo path is the label - the full path (not the
    // basename) so nested or duplicate-basename submodules stay unambiguous.
    label: changeset.parentPath,
    branch: changeset.branch,
    headSha,
    headLabel: formatHeadLabel(changeset.branch, headSha),
    repoState: changeset.repoState,
    relation: changeset.relation,
    presentation: classifyRelationPresentation(changeset.relation),
    files: changeset.files,
  };
}

/** A `normal` gitlink pointer earns a submodule section only if it is dirty. */
function normalPointerIsDirty(pointer: SubmodulePointer): boolean {
  return (
    pointer.kind === "normal" &&
    (pointer.commitChanged ||
      pointer.modifiedContent ||
      pointer.untrackedContent)
  );
}

/**
 * Compose the group-by-repo view model from the nested v1.1 snapshot.
 *
 * A `normal` gitlink pointer that is dirty but has no matching submodule
 * changeset is flagged `detailsUnavailable` (an old host stripped it, or a
 * partial per-submodule failure) so the row surfaces an explicit affordance
 * rather than being dropped. A `conflicted` pointer is intentionally
 * changeset-less (pointer-only) and is never treated as a degrade.
 */
export function composeGitRepos(snapshot: {
  readonly runningDir: string;
  readonly label: string;
  readonly branch: string | null;
  readonly headSha: string;
  readonly repoState: RepoState;
  readonly files: ReadonlyArray<GitChangedFileV11>;
  readonly submodules: ReadonlyArray<SubmoduleChangeset>;
}): GitReposComposition {
  const changesetByPath = new Map<string, SubmoduleChangeset>();
  for (const changeset of snapshot.submodules) {
    changesetByPath.set(changeset.parentPath, changeset);
  }

  // Separate ordinary text-diff files from the gitlink pointer rows. A gitlink
  // may appear twice (staged + unstaged) with one identical descriptor, so
  // reference rows dedup by path while ordinary files pass through untouched.
  const files: GitChangedFileV11[] = [];
  const seenGitlinkPaths = new Set<string>();
  const referenceRows: SubmoduleReferenceRowView[] = [];
  for (const file of snapshot.files) {
    if (file.gitlink === null) {
      files.push(file);
      continue;
    }
    if (seenGitlinkPaths.has(file.path)) continue;
    seenGitlinkPaths.add(file.path);
    const changeset = changesetByPath.get(file.path) ?? null;
    const checkoutHeadSha =
      changeset === null ? null : changeset.relation.submoduleHeadSha;
    const detailsAvailable = changeset !== null;
    // A conflicted pointer is intentionally pointer-only (no changeset section),
    // so its missing details are expected, not a degrade. A dirty `normal`
    // pointer with no changeset means the host surfaced the pointer but no
    // details (old-host downgrade or a partial per-submodule failure).
    const detailsUnavailable =
      !detailsAvailable && normalPointerIsDirty(file.gitlink);
    referenceRows.push({
      parentPath: file.path,
      // Full gitlink path (not basename) to disambiguate nested submodules.
      label: file.path,
      pointer: file.gitlink,
      checkoutHeadSha,
      detailsAvailable,
      detailsUnavailable,
      summary: referenceRowSummary(file.gitlink, checkoutHeadSha),
    });
  }

  const parent: ParentRepoView = {
    runningDir: snapshot.runningDir,
    label: snapshot.label,
    branch: snapshot.branch,
    headSha: snapshot.headSha,
    headLabel: formatHeadLabel(snapshot.branch, snapshot.headSha),
    repoState: snapshot.repoState,
    files,
    referenceRows,
    fileCount: files.length,
    referenceCount: referenceRows.length,
    countsLabel: formatCounts(files.length, referenceRows.length),
  };

  const submodules = snapshot.submodules.map(buildSubmoduleView);

  return {
    parent,
    submodules,
    hasSubmoduleContent: submodules.length > 0 || referenceRows.length > 0,
  };
}
