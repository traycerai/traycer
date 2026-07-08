/**
 * Pure view-model for Git Diff submodule presentation: workspace switcher
 * summaries, parent gitlink reference descriptors, and grouped module bodies.
 *
 * The host returns one nested `git.listChangedFiles@1.1` snapshot per root repo
 * (the parent changeset - each parent file carrying a nullable `gitlink`
 * descriptor - plus a `submodules[]` array of working-tree changesets, no
 * commits-ahead). This module turns that snapshot into:
 *
 * - a split of the parent's files into ordinary text-diff files and gitlink
 *   pointer files (deduped by path - a dual-stage `MM S.M.` gitlink emits two
 *   rows sharing one descriptor);
 * - one parent-reference descriptor per gitlink, reading pins/flags straight off
 *   the enriched pointer (no join) and carrying the matching submodule section
 *   when the host supplied one;
 * - one summary node per initialized submodule for workspace rows and module
 *   groups (working-tree file count, an "unavailable" flag, branch/HEAD label,
 *   and whether the module has any visible non-clean state).
 *
 * Framework-free so the rules are exhaustively unit-testable; the React
 * components are thin renderers over this output.
 */
import type {
  GitChangedFileV11,
  RepoMode,
  RepoState,
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
  /** Parent files with gitlink rows removed from ordinary file rendering. */
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
 * Parent gitlink reference facts used to annotate the owning submodule module
 * header. `pointer` carries the raw pointer facts (enriched pins + flags, or
 * the conflict base/ours/theirs triple) read straight off the parent row - no
 * join. `repoRoot` is the matching submodule section when present, or `null`
 * when there is no matching section (a conflicted pointer earns none; an old
 * host downgraded to `submodules: []` returns none). `divergence` surfaces the
 * enriched `pointer.diverged` fact as human copy so the user need not compare
 * SHAs (`null` for a conflicted pointer, which has no single pin).
 * `detailsUnavailable` flags a "dirty pointer but no usable details" degrade -
 * the section is either missing (old-host downgrade / partial failure) or
 * present-but-`unavailable`.
 */
export interface SubmoduleParentReferenceView {
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
 * user need not compare SHAs. `null` for a conflicted pointer (no single pin)
 * and for an unenriched pointer (`submoduleHeadSha` unknown — the host never
 * read the submodule HEAD, so `diverged: false` is a parser default, not a
 * verified match).
 */
function pointerDivergence(
  pointer: SubmodulePointer,
): "diverged" | "matches" | null {
  if (pointer.kind !== "normal") return null;
  if (pointer.diverged) return "diverged";
  return pointer.submoduleHeadSha === null ? null : "matches";
}

/** A `normal` gitlink pointer is dirty when any of its `<sub>` flags are set. */
export function submodulePointerIsDirty(pointer: SubmodulePointer): boolean {
  return (
    pointer.kind === "normal" &&
    (pointer.commitChanged ||
      pointer.modifiedContent ||
      pointer.untrackedContent)
  );
}

function parentReferenceSummary(pointer: SubmodulePointer): string {
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
 * Build parent-reference descriptors from the parent's gitlink files, joining
 * each to its submodule section by `path` <-> `parentPath`.
 */
export function buildSubmoduleParentReferences(
  gitlinkFiles: ReadonlyArray<GitChangedFileV11>,
  submodules: ReadonlyArray<SubmoduleChangeset>,
): ReadonlyArray<SubmoduleParentReferenceView> {
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
        summary: parentReferenceSummary(pointer),
        divergence: pointerDivergence(pointer),
        repoRoot: changeset === null ? null : changeset.repoRoot,
        // A conflicted pointer is intentionally section-less (pointer-only), so a
        // missing section is expected there, not a degrade. A dirty `normal`
        // pointer degrades when the host surfaced no usable details: either no
        // section (old-host downgrade / partial failure) or a section the host
        // could not inspect (`availability: unavailable`).
        detailsUnavailable:
          submodulePointerIsDirty(pointer) &&
          (changeset === null ||
            changeset.availability.state === "unavailable"),
      },
    ];
  });
}

/**
 * One initialized submodule summary. `changeCount` is the submodule's own
 * working-tree file count, while `hasChanges` also includes pointer-only
 * states such as parent-reference mismatch or conflicts so workspace row subtext
 * can say a module changed without inflating the changed-file badge.
 * `unavailable` marks a submodule the host could not inspect.
 */
export interface GitSubmoduleSummary {
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
): GitSubmoduleSummary {
  const unavailable = changeset.availability.state === "unavailable";
  const headSha =
    changeset.pointer.kind === "normal"
      ? changeset.pointer.submoduleHeadSha
      : null;
  const changeCount = changeset.files.length;
  const hasPointerChange =
    changeset.pointer.kind === "conflicted" ||
    submodulePointerIsDirty(changeset.pointer);
  return {
    repoRoot: changeset.repoRoot,
    parentPath: changeset.parentPath,
    // The submodule's parent-repo path is the label - the full path (not the
    // basename) so nested or duplicate-basename submodules stay unambiguous.
    label: changeset.parentPath,
    headLabel: formatRepoHeadLabel(changeset.branch, headSha),
    changeCount,
    hasChanges: changeCount > 0 || hasPointerChange,
    unavailable,
  };
}

export function buildSubmoduleNodes(
  submodules: ReadonlyArray<SubmoduleChangeset>,
): ReadonlyArray<GitSubmoduleSummary> {
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

export interface GitModuleRootInput {
  readonly repoRoot: string;
  readonly label: string;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly files: ReadonlyArray<GitChangedFileV11>;
  readonly repoState: RepoState | null;
  readonly repoMode: RepoMode | null;
}

export type GitModuleParentReferenceStatus =
  "differs" | "conflicted" | "dirty" | "unavailable";

export interface GitModuleParentReference {
  readonly status: GitModuleParentReferenceStatus;
  readonly summary: string;
}

export interface GitModuleGroup {
  readonly kind: "root" | "submodule";
  readonly key: string;
  readonly label: string;
  readonly repoRoot: string | null;
  readonly parentPath: string | null;
  readonly headLabel: string;
  readonly files: ReadonlyArray<GitChangedFileV11>;
  readonly repoState: RepoState | null;
  readonly repoMode: RepoMode | null;
  readonly unavailable: boolean;
  readonly clean: boolean;
  readonly defaultExpanded: boolean;
  readonly parentReference: GitModuleParentReference | null;
  readonly searchText: string;
}

export interface GitModuleGroupsModel {
  readonly modules: ReadonlyArray<GitModuleGroup>;
  readonly hiddenCleanModuleCount: number;
}

export interface GitModuleGroupsInput {
  readonly root: GitModuleRootInput;
  readonly submodules: ReadonlyArray<SubmoduleChangeset>;
}

function searchableText(parts: ReadonlyArray<string | null>): string {
  return parts
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" ")
    .toLowerCase();
}

function parentReferenceStatus(
  reference: SubmoduleParentReferenceView | null,
  pointer: SubmodulePointer,
): GitModuleParentReference | null {
  if (reference?.detailsUnavailable === true) {
    return { status: "unavailable", summary: reference.summary };
  }
  if (reference?.isConflicted === true) {
    return { status: "conflicted", summary: reference.summary };
  }
  if (reference?.divergence === "diverged") {
    return { status: "differs", summary: reference.summary };
  }
  if (submodulePointerIsDirty(pointer)) {
    return {
      status: "dirty",
      summary: reference?.summary ?? "submodule working tree is dirty",
    };
  }
  return null;
}

function submoduleGroupClean(args: {
  readonly files: ReadonlyArray<GitChangedFileV11>;
  readonly repoState: RepoState;
  readonly unavailable: boolean;
  readonly parentReference: GitModuleParentReference | null;
}): boolean {
  return (
    args.files.length === 0 &&
    args.repoState.kind === "clean" &&
    !args.unavailable &&
    args.parentReference === null
  );
}

function buildSubmoduleGroup(args: {
  readonly changeset: SubmoduleChangeset;
  readonly reference: SubmoduleParentReferenceView | null;
}): GitModuleGroup {
  const { changeset, reference } = args;
  const unavailable = changeset.availability.state === "unavailable";
  const parentReference = parentReferenceStatus(reference, changeset.pointer);
  const clean = submoduleGroupClean({
    files: changeset.files,
    repoState: changeset.repoState,
    unavailable,
    parentReference,
  });
  const headSha =
    changeset.pointer.kind === "normal"
      ? changeset.pointer.submoduleHeadSha
      : null;
  const headLabel = formatRepoHeadLabel(changeset.branch, headSha);

  return {
    kind: "submodule",
    key: `submodule:${changeset.parentPath}`,
    label: changeset.parentPath,
    repoRoot: changeset.repoRoot,
    parentPath: changeset.parentPath,
    headLabel,
    files: changeset.files,
    repoState: changeset.repoState,
    repoMode: null,
    unavailable,
    clean,
    defaultExpanded: !clean,
    parentReference,
    searchText: searchableText([
      changeset.parentPath,
      changeset.repoRoot,
      headLabel,
      unavailable ? "unavailable submodule details unavailable" : null,
      parentReference?.status ?? null,
      parentReference?.summary ?? null,
      clean ? "clean" : "changed dirty",
    ]),
  };
}

function buildPointerOnlySubmoduleGroup(
  reference: SubmoduleParentReferenceView,
): GitModuleGroup {
  const parentReference = parentReferenceStatus(reference, reference.pointer);
  const unavailable = parentReference?.status === "unavailable";
  return {
    kind: "submodule",
    key: `submodule:${reference.parentPath}`,
    label: reference.label,
    repoRoot: null,
    parentPath: reference.parentPath,
    headLabel: "reference",
    files: [],
    repoState: null,
    repoMode: null,
    unavailable,
    clean: false,
    defaultExpanded: true,
    parentReference,
    searchText: searchableText([
      reference.label,
      reference.parentPath,
      reference.summary,
      parentReference?.status ?? null,
      unavailable ? "unavailable submodule details unavailable" : null,
    ]),
  };
}

export function buildGitModuleGroups(
  input: GitModuleGroupsInput,
): GitModuleGroupsModel {
  const split = splitParentFiles(input.root.files);
  const parentReferences = buildSubmoduleParentReferences(
    split.gitlinkFiles,
    input.submodules,
  );
  const referenceByPath = new Map(
    parentReferences.map((reference) => [reference.parentPath, reference]),
  );
  const submoduleGroups = input.submodules.map((changeset) =>
    buildSubmoduleGroup({
      changeset,
      reference: referenceByPath.get(changeset.parentPath) ?? null,
    }),
  );
  const submodulePathSet = new Set(
    input.submodules.map((changeset) => changeset.parentPath),
  );
  const pointerOnlyGroups = parentReferences
    .filter((reference) => !submodulePathSet.has(reference.parentPath))
    .map(buildPointerOnlySubmoduleGroup);
  const rootHeadLabel = formatRepoHeadLabel(
    input.root.branch,
    input.root.headSha,
  );
  const rootModule: GitModuleGroup = {
    kind: "root",
    key: "root",
    label: input.root.label,
    repoRoot: input.root.repoRoot,
    parentPath: null,
    headLabel: rootHeadLabel,
    files: split.ordinaryFiles,
    repoState: input.root.repoState,
    repoMode: input.root.repoMode,
    unavailable: false,
    clean:
      split.ordinaryFiles.length === 0 &&
      (input.root.repoState === null || input.root.repoState.kind === "clean"),
    defaultExpanded: true,
    parentReference: null,
    searchText: searchableText([
      input.root.label,
      input.root.repoRoot,
      rootHeadLabel,
      split.ordinaryFiles.length === 0 ? "clean" : "changed dirty",
    ]),
  };
  const modules = [rootModule, ...submoduleGroups, ...pointerOnlyGroups];
  return {
    modules,
    hiddenCleanModuleCount: submoduleGroups.filter((module) => module.clean)
      .length,
  };
}
