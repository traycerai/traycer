import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  resolve,
  win32,
} from "node:path";
import { z } from "zod";
import {
  sha256Digest,
  type ExternalAction,
  type ObjectFingerprint,
} from "@traycer/protocol/config/data-migration-contracts";
import {
  dataRootPlatformOf,
  type DataRootPlatform,
} from "@traycer/protocol/config/data-root";
import { isErrnoException } from "../../runner/errors";
import { runCommand, type RunResult } from "../../service/process-runner";
import {
  ExternalActionConflictError,
  compareAndSetFileImage,
  decodeImage,
  externalActionId,
  pathInsideRoot,
  presentFingerprint,
  readFileImage,
  rebaseRootPath,
  type ExternalActionBlocker,
  type ExternalActionPlan,
} from "./ledger";
import type { DataRootPair } from "./windows-task-actions";

/**
 * Managed Git worktrees moved with the data root.
 *
 * The host creates them with `git worktree add` at
 * `<root>/worktrees/<group>/<slug>` (`managedWorktreesRoot()` in the host's
 * `managed-worktree-path.ts`), so each one is a LINKED worktree whose `.git`
 * file names an admin entry `<common>/worktrees/<id>/` inside the user's own
 * repository, and that entry's `gitdir` file names the worktree back. The
 * copy carries the worktree's bytes (dirty and untracked files included);
 * this adapter fixes the one link outside the data root, through Git's own
 * mechanism: `git worktree repair` run inside the destination copy.
 *
 * What that repair can write, and how each is covered. Every byte is
 * recorded durably in the ledger BEFORE the command runs; nothing relies on
 * an in-memory comparison:
 * - `<admin>/gitdir` (the back link): the effect. Before and after are EXACT
 *   bytes; the after bytes are Git's own serialization, predicted as the real
 *   path of the destination `.git` (forward slashes on Windows) plus a
 *   newline. The inverse writes the recorded before bytes back, only while
 *   the file holds exactly the recorded after bytes.
 * - the worktree's `.git` file: Git 2.48+ rewrites it on every repair, as
 *   `gitdir: <real path of the admin entry>` - so planning requires the copy
 *   to already hold exactly those bytes (`git-link-not-canonical` otherwise),
 *   and the effect leaves it byte-identical. Its exact bytes are in both
 *   images.
 * - `<admin>/commondir`: never written by repair; exact bytes in both images.
 * - every OTHER linked worktree's `.git` and `gitdir`, and `<common>/config`:
 *   `repair` also visits every sibling. Planning refuses a repository with a
 *   sibling it would rewrite, and records one digest of all of their exact
 *   bytes in both images. Several managed worktrees of one repository are
 *   normal: each has its own action over its own entry, and each action's
 *   sibling digest leaves out the entries this migration moves
 *   (`migratedAdmins`), so repairing one never changes another's images; the
 *   safety check below still covers them, and a moved sibling's links are
 *   consistent both before and after its own repair. `apply` re-reads them and re-runs that check
 *   immediately before invoking Git and refuses on any difference; a sibling
 *   write that still happened shows on the next observation (after a crash
 *   too) as a conflict, never as `applied`.
 * - the copy's `.git` must be byte-identical to the source's and name the
 *   recorded admin entry, so the command cannot reach another repository.
 *
 * Planning refuses, before any effect: no Git or a Git older than 2.29 (no
 * `worktree repair`); a missing admin entry or common directory; a back link
 * that does not name the source copy; a relative `.git` link; a common
 * directory inside the data root; a locked worktree; submodules; any nested
 * `.git` below the worktree; a standalone repository with linked worktrees
 * or alternates; a worktree that is itself a link. A standalone repository
 * (its own `.git` directory) without those is self-contained: the copy alone
 * moves it, so it has no action.
 */
export const GIT_WORKTREE_LINK_ADAPTER = "git-worktree-link";

const MANAGED_WORKTREES_DIRNAME = "worktrees";

const snapshotSchema = z.strictObject({
  head: z.string().nullable(),
  statusDigest: z.string().min(1),
  /** Each dirty/untracked path (relative, `/`-separated) -> its content digest. */
  files: z.record(z.string(), z.string().nullable()),
});
export type GitWorktreeSnapshot = z.infer<typeof snapshotSchema>;

export const gitWorktreeForwardSchema = z.strictObject({
  adapter: z.literal(GIT_WORKTREE_LINK_ADAPTER),
  version: z.literal(1),
  stage: z.literal("prepare"),
  sourceWorktree: z.string().min(1),
  destinationWorktree: z.string().min(1),
  adminDir: z.string().min(1),
  commonDir: z.string().min(1),
  /** Base64 of the `.git` file the copy holds; the effect leaves it as is. */
  dotGit: z.string().min(1),
  /** Base64 of the `<admin>/gitdir` bytes Git writes (predicted). */
  gitdirAfter: z.string().min(1),
  /**
   * Every admin entry of this repository that this migration moves (this one
   * included). Each has its own action; they are left out of `siblings`.
   */
  migratedAdmins: z.array(z.string().min(1)).min(1),
  /**
   * Digest of every OTHER sibling link and the common config
   * (`siblingsDigest`, without `migratedAdmins`).
   */
  siblings: z.string().min(1),
  /** The SOURCE worktree as planning read it, for destination verification. */
  snapshot: snapshotSchema,
});

export const gitWorktreeInverseSchema = z.strictObject({
  adapter: z.literal(GIT_WORKTREE_LINK_ADAPTER),
  version: z.literal(1),
  /** Base64 of the exact `<admin>/gitdir` bytes before the effect. */
  gitdir: z.string().min(1),
});

type Forward = z.infer<typeof gitWorktreeForwardSchema>;

export type GitRunner = (
  args: readonly string[],
  options: { readonly tolerateNonZeroExit: boolean },
) => Promise<RunResult>;

const GIT_TIMEOUT_MS = 120_000;

/** `git` with every inherited `GIT_*` variable removed and prompts off. */
const runGit: GitRunner = (args, options) => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^GIT_/iu.test(name)) env[name] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return runCommand("git", args, {
    env,
    cwd: undefined,
    timeoutMs: GIT_TIMEOUT_MS,
    tolerateNonZeroExit: options.tolerateNonZeroExit,
  });
};

let gitOverride: GitRunner | null = null;

/** Test-only replacement for the `git` runner; `null` restores it. */
export function setGitRunnerForTests(runner: GitRunner | null): void {
  gitOverride = runner;
}

function git(): GitRunner {
  return gitOverride ?? runGit;
}

function platform(): DataRootPlatform {
  return dataRootPlatformOf(process.platform);
}

function pathApi(): typeof win32 {
  return platform() === "win32" ? win32 : posix;
}

function comparable(value: string): string {
  const resolved = pathApi()
    .resolve(value)
    .replace(/[\\/]+$/u, "");
  return platform() === "win32"
    ? resolved.replace(/\//gu, "\\").toLowerCase()
    : resolved;
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---- Link files ---------------------------------------------------------------

/** The path a `gitdir: <path>` file names, as written; `null` if not that shape. */
function parseGitdirFile(bytes: Buffer): string | null {
  const match = /^gitdir: (.+?)\r?\n?$/u.exec(bytes.toString("utf8"));
  return match === null ? null : (match[1] ?? null);
}

/** The single path line of `<admin>/gitdir` or `<admin>/commondir`. */
function parsePathLine(bytes: Buffer): string | null {
  const text = bytes.toString("utf8").replace(/\r?\n$/u, "");
  return text.length === 0 || /[\r\n]/u.test(text) ? null : text;
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFileImage(path);
  } catch (cause) {
    if (cause instanceof ExternalActionConflictError) return null;
    throw cause;
  }
}

/**
 * A location as Git compares it: the real path when it exists (Git writes
 * real paths - a temp folder behind a symlink, a Windows short name), the
 * lexical one otherwise; folded for comparison.
 */
async function canonicalLocation(path: string): Promise<string> {
  try {
    return comparable(await realpath(path));
  } catch {
    return comparable(path);
  }
}

/** A path as Git writes it into a link file (forward slashes on Windows). */
function gitPath(value: string): string {
  return platform() === "win32" ? value.replace(/\\/gu, "/") : value;
}

function digestOf(bytes: Buffer | null): string | null {
  return bytes === null ? null : sha256Hex(bytes);
}

/**
 * The fingerprint projection - exact bytes throughout: the destination
 * `.git`, the admin entry's `gitdir` and `commondir`, and the digest of every
 * sibling link plus the common config.
 */
async function observeProjection(forward: Forward): Promise<{
  readonly dotGit: string | null;
  readonly gitdir: string | null;
  readonly commondir: string | null;
  readonly siblings: string;
}> {
  return {
    dotGit: digestOf(
      await readOptional(join(forward.destinationWorktree, ".git")),
    ),
    gitdir: digestOf(await readOptional(join(forward.adminDir, "gitdir"))),
    commondir: digestOf(
      await readOptional(join(forward.adminDir, "commondir")),
    ),
    siblings: await siblingsDigest(forward.commonDir, forward.migratedAdmins),
  };
}

export async function observeGitWorktree(
  action: ExternalAction,
): Promise<ObjectFingerprint> {
  const forward = gitWorktreeForwardSchema.parse(action.forward);
  return presentFingerprint(await observeProjection(forward));
}

// ---- Sibling guard -------------------------------------------------------------

async function isSameEntry(left: string, right: string): Promise<boolean> {
  return (await canonicalLocation(left)) === (await canonicalLocation(right));
}

async function isMigrated(
  admin: string,
  migratedAdmins: readonly string[],
): Promise<boolean> {
  for (const migrated of migratedAdmins) {
    if (await isSameEntry(admin, migrated)) return true;
  }
  return false;
}

/**
 * One digest of the exact bytes of every OTHER linked worktree's `gitdir` and
 * `.git`, and of `<common>/config`: what `git worktree repair` must leave
 * alone. Keyed by admin entry name, so the digest is stable across spellings
 * of the common directory.
 */
async function siblingsDigest(
  commonDir: string,
  migratedAdmins: readonly string[],
): Promise<string> {
  const entries: Record<string, string | null> = {
    config: digestOf(await readOptional(join(commonDir, "config"))),
  };
  for (const admin of await listAdminEntries(commonDir)) {
    if (await isMigrated(admin, migratedAdmins)) continue;
    const name = basename(admin);
    const gitdir = await readOptional(join(admin, "gitdir"));
    entries[`${name}/gitdir`] = digestOf(gitdir);
    const target = gitdir === null ? null : parsePathLine(gitdir);
    if (target !== null) {
      entries[`${name}/.git`] = digestOf(
        await readOptional(resolve(admin, target)),
      );
    }
  }
  return sha256Digest(entries);
}

/**
 * Whether `repair` would leave every sibling alone: each one whose worktree
 * exists has absolute links in both directions that name each other (Git
 * skips a sibling whose worktree is gone).
 */
async function siblingsSafeForRepair(
  commonDir: string,
  adminDir: string,
): Promise<boolean> {
  for (const sibling of await listAdminEntries(commonDir)) {
    if (await isSameEntry(sibling, adminDir)) continue;
    const gitdir = await readOptional(join(sibling, "gitdir"));
    const target = gitdir === null ? null : parsePathLine(gitdir);
    if (target === null || !isAbsolute(target)) return false;
    if (!(await exists(dirname(resolve(sibling, target))))) continue;
    const dotGit = await readOptional(resolve(sibling, target));
    const back = dotGit === null ? null : parseGitdirFile(dotGit);
    if (
      back === null ||
      !isAbsolute(back) ||
      !(await isSameEntry(back, sibling))
    ) {
      return false;
    }
  }
  return true;
}

async function listAdminEntries(commonDir: string): Promise<string[]> {
  const root = join(commonDir, "worktrees");
  try {
    const names = await readdir(root, { withFileTypes: true });
    return names
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch (cause) {
    if (isErrnoException(cause) && cause.code === "ENOENT") return [];
    throw cause;
  }
}

// ---- Adapter ---------------------------------------------------------------------

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null || right === null ? left === right : left.equals(right);
}

/**
 * Re-checks, immediately before Git runs, everything the ledger recorded the
 * command may touch: the copy's `.git` (so Git can reach only the recorded
 * admin entry), the admin `gitdir`, the siblings and the common config, and
 * that no sibling has become one repair would rewrite. Any difference refuses
 * before the command runs.
 */
export async function applyGitWorktree(action: ExternalAction): Promise<void> {
  const forward = gitWorktreeForwardSchema.parse(action.forward);
  const inverse = gitWorktreeInverseSchema.parse(action.inverse);
  const refuse = (message: string): never => {
    throw new ExternalActionConflictError(forward.adminDir, message);
  };
  const dotGit = await readOptional(join(forward.destinationWorktree, ".git"));
  if (!sameBytes(dotGit, decodeImage(forward.dotGit))) {
    refuse(
      "the destination worktree's .git link changed since the migration recorded it",
    );
  }
  const gitdir = await readOptional(join(forward.adminDir, "gitdir"));
  if (!sameBytes(gitdir, decodeImage(inverse.gitdir))) {
    refuse(
      "the repository's link to this worktree changed since the migration recorded it",
    );
  }
  if (
    (await siblingsDigest(forward.commonDir, forward.migratedAdmins)) !==
      forward.siblings ||
    !(await siblingsSafeForRepair(forward.commonDir, forward.adminDir))
  ) {
    refuse(
      "another worktree of this repository or its config changed since the migration recorded it",
    );
  }
  await git()(
    [
      "-c",
      "worktree.useRelativePaths=false",
      "-C",
      forward.destinationWorktree,
      "worktree",
      "repair",
    ],
    { tolerateNonZeroExit: false },
  );
}

/**
 * The inverse: the recorded before bytes of `<admin>/gitdir`, a
 * compare-and-set against the recorded AFTER bytes - never against whatever
 * is there now. The other recorded files are byte-identical in both images,
 * so there is nothing else to write back.
 */
export async function invertGitWorktree(action: ExternalAction): Promise<void> {
  const forward = gitWorktreeForwardSchema.parse(action.forward);
  const inverse = gitWorktreeInverseSchema.parse(action.inverse);
  await compareAndSetFileImage(
    join(forward.adminDir, "gitdir"),
    decodeImage(forward.gitdirAfter),
    decodeImage(inverse.gitdir),
  );
}

// ---- Verification ------------------------------------------------------------------

async function headOf(worktree: string): Promise<string | null> {
  const result = await git()(
    [
      "--no-optional-locks",
      "-C",
      worktree,
      "rev-parse",
      "--verify",
      "-q",
      "HEAD",
    ],
    { tolerateNonZeroExit: true },
  );
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function statusOf(worktree: string): Promise<string> {
  const result = await git()(
    [
      "--no-optional-locks",
      "-C",
      worktree,
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--ignored=no",
    ],
    { tolerateNonZeroExit: false },
  );
  return result.stdout;
}

/** The worktree-relative paths a `--porcelain=v2 -z` status names. */
export function porcelainV2Paths(status: string): string[] {
  const records = status.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length === 0) continue;
    const kind = record[0];
    // Field counts before the path: ordinary 8, rename/copy 9 (its original
    // path follows as the next record), unmerged 10, untracked/ignored 1.
    const fields =
      kind === "1"
        ? 8
        : kind === "2"
          ? 9
          : kind === "u"
            ? 10
            : kind === "?" || kind === "!"
              ? 1
              : -1;
    if (fields < 0) continue;
    const parts = record.split(" ");
    paths.push(parts.slice(fields).join(" "));
    if (kind === "2") index += 1;
  }
  return paths;
}

async function contentDigest(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return `link:${sha256Hex(await readlink(path))}`;
    if (info.isFile()) return `file:${sha256Hex(await readFile(path))}`;
    return "other";
  } catch (cause) {
    if (isErrnoException(cause) && cause.code === "ENOENT") return null;
    throw cause;
  }
}

async function snapshotWorktree(
  worktree: string,
): Promise<GitWorktreeSnapshot> {
  const status = await statusOf(worktree);
  const files: Record<string, string | null> = {};
  for (const relative of porcelainV2Paths(status)) {
    files[relative] = await contentDigest(
      join(worktree, ...relative.split("/")),
    );
  }
  return {
    head: await headOf(worktree),
    statusDigest: `sha256:${sha256Hex(status)}`,
    files,
  };
}

export type GitWorktreeVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly mismatches: readonly string[] };

/**
 * Destination checks after the link is repaired, reading only the copy and
 * the common directory (`--no-optional-locks`: no index refresh is written):
 * the same HEAD and the same status as planning recorded from the source,
 * every dirty/untracked file's bytes unchanged, and the repository's worktree
 * list naming the destination and not the source.
 */
export async function verifyGitWorktreeCopy(
  action: ExternalAction,
): Promise<GitWorktreeVerification> {
  const forward = gitWorktreeForwardSchema.parse(action.forward);
  const { destinationWorktree: dest, snapshot } = forward;
  const mismatches: string[] = [];
  if ((await headOf(dest)) !== snapshot.head) mismatches.push("HEAD differs");
  const status = await statusOf(dest);
  if (`sha256:${sha256Hex(status)}` !== snapshot.statusDigest) {
    mismatches.push("git status differs");
  }
  for (const [relative, digest] of Object.entries(snapshot.files)) {
    const actual = await contentDigest(join(dest, ...relative.split("/")));
    if (actual !== digest) mismatches.push(`content differs: ${relative}`);
  }
  const list = await git()(
    [
      "--no-optional-locks",
      "-C",
      dest,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ],
    { tolerateNonZeroExit: false },
  );
  const listed = list.stdout
    .split("\0")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => comparable(line.slice("worktree ".length)));
  if (!listed.includes(await canonicalLocation(dest))) {
    mismatches.push("the worktree list does not name the destination");
  }
  if (listed.includes(await canonicalLocation(forward.sourceWorktree))) {
    mismatches.push("the worktree list still names the source");
  }
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}

// ---- Planning ------------------------------------------------------------------------

async function gitSupportsRepair(): Promise<boolean> {
  let result: RunResult;
  try {
    result = await git()(["--version"], { tolerateNonZeroExit: true });
  } catch {
    return false;
  }
  const match = /git version (\d+)\.(\d+)/u.exec(result.stdout);
  if (result.exitCode !== 0 || match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 29);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (isErrnoException(cause) && cause.code === "ENOENT") return false;
    throw cause;
  }
}

/** Whether any `.git` entry exists below `worktree` other than its own. */
async function hasNestedGit(worktree: string): Promise<boolean> {
  const stack = [worktree];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const isGit =
        platform() === "win32"
          ? entry.name.toLowerCase() === ".git"
          : entry.name === ".git";
      if (isGit) {
        if (dir === worktree) continue;
        return true;
      }
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
    }
  }
  return false;
}

async function listSubdirectories(dir: string): Promise<{
  readonly directories: string[];
  readonly links: string[];
}> {
  const directories: string[] = [];
  const links: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    if (isErrnoException(cause) && cause.code === "ENOENT") {
      return { directories, links };
    }
    throw cause;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) links.push(path);
    else if (entry.isDirectory()) directories.push(path);
  }
  return { directories, links };
}

type Classified =
  | { readonly kind: "none" }
  | {
      readonly kind: "blocked";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "linked";
      readonly adminDir: string;
      readonly commonDir: string;
    };

async function classifyWorktree(
  worktree: string,
  roots: DataRootPair,
): Promise<Classified> {
  const blocked = (code: string, message: string): Classified => ({
    kind: "blocked",
    code,
    message,
  });
  const dotGit = join(worktree, ".git");
  let info: Stats;
  try {
    info = await lstat(dotGit);
  } catch (cause) {
    if (isErrnoException(cause) && cause.code === "ENOENT")
      return { kind: "none" };
    throw cause;
  }
  if (await exists(join(worktree, ".gitmodules"))) {
    return blocked("git-submodules", "the worktree has submodules");
  }
  if (await hasNestedGit(worktree)) {
    return blocked(
      "git-nested-repository",
      "a Git repository or worktree is nested inside this worktree",
    );
  }
  if (info.isDirectory()) {
    if ((await listAdminEntries(dotGit)).length > 0) {
      return blocked(
        "git-main-worktree",
        "this repository has linked worktrees of its own",
      );
    }
    if (
      (await exists(join(dotGit, "objects", "info", "alternates"))) ||
      (await exists(join(dotGit, "modules")))
    ) {
      return blocked(
        "git-external-objects",
        "this repository uses alternates or submodules",
      );
    }
    return { kind: "none" };
  }
  if (!info.isFile()) {
    return blocked("git-link-unsupported", "the worktree's .git is not a file");
  }
  const target = parseGitdirFile(await readFile(dotGit));
  if (target === null) {
    return blocked(
      "git-link-unsupported",
      "the worktree's .git file is not a gitdir link",
    );
  }
  if (!isAbsolute(target) && !win32.isAbsolute(target)) {
    return blocked(
      "git-relative-link",
      "the worktree uses a relative gitdir link, which a move to another folder breaks",
    );
  }
  const adminDir = resolve(target);
  if (!(await isDirectory(adminDir))) {
    return blocked(
      "git-missing-common-dir",
      "the worktree's Git admin entry is missing",
    );
  }
  const commondirBytes = await readOptional(join(adminDir, "commondir"));
  const commonTarget =
    commondirBytes === null ? null : parsePathLine(commondirBytes);
  if (commonTarget === null) {
    return blocked(
      "git-missing-common-dir",
      "the worktree's commondir file is missing",
    );
  }
  const commonDir = resolve(adminDir, commonTarget);
  if (!(await isDirectory(commonDir))) {
    return blocked(
      "git-missing-common-dir",
      "the worktree's common Git directory is missing",
    );
  }
  for (const dir of [adminDir, commonDir]) {
    if (pathInsideRoot(dir, roots.sourceRoot, platform()) !== null) {
      return blocked(
        "git-common-dir-inside-data-root",
        "the worktree's repository lives inside the data folder",
      );
    }
  }
  const gitdirBytes = await readOptional(join(adminDir, "gitdir"));
  const backLink = gitdirBytes === null ? null : parsePathLine(gitdirBytes);
  if (
    backLink === null ||
    (await canonicalLocation(resolve(adminDir, backLink))) !==
      (await canonicalLocation(dotGit))
  ) {
    return blocked(
      "git-stale-link",
      "the repository's admin entry does not name this worktree",
    );
  }
  if (await exists(join(adminDir, "locked"))) {
    return blocked("git-locked-worktree", "the worktree is locked");
  }
  if (await exists(join(adminDir, "modules"))) {
    return blocked("git-submodules", "the worktree has submodules");
  }
  // `repair` also visits every sibling entry: one it would rewrite is a write
  // outside this action, so refuse it here (and again right before the effect).
  if (!(await siblingsSafeForRepair(commonDir, adminDir))) {
    return blocked(
      "git-sibling-needs-repair",
      "another worktree of this repository has a link git worktree repair would rewrite",
    );
  }
  // Git 2.48+ rewrites the worktree's `.git` on repair, as the real path of
  // the admin entry. Only a link already in that form stays byte-identical.
  const canonicalDotGit = `gitdir: ${gitPath(await realpath(adminDir))}\n`;
  if (!(await readFile(dotGit)).equals(Buffer.from(canonicalDotGit, "utf8"))) {
    return blocked(
      "git-link-not-canonical",
      "the worktree's .git link is not in the form git worktree repair writes; run `git worktree repair` in the source worktree first",
    );
  }
  return { kind: "linked", adminDir, commonDir };
}

/**
 * Plans one action per managed linked worktree, once the destination copy
 * exists (the before image includes the copied `.git`). Run against a
 * quiesced source: the snapshot it records from the source is what the
 * destination is later verified against.
 */
export async function planGitWorktreeRelocation(input: {
  readonly roots: DataRootPair;
}): Promise<ExternalActionPlan> {
  const { roots } = input;
  const actions: ExternalAction[] = [];
  const blockers: ExternalActionBlocker[] = [];
  const managed = join(roots.sourceRoot, MANAGED_WORKTREES_DIRNAME);
  const groups = await listSubdirectories(managed);
  const worktrees: string[] = [];
  const links = [...groups.links];
  for (const group of groups.directories) {
    const slugs = await listSubdirectories(group);
    worktrees.push(...slugs.directories);
    links.push(...slugs.links);
  }
  for (const link of links) {
    blockers.push({
      code: "git-worktree-is-link",
      object: link,
      message:
        "a managed worktree folder is a link, which the migration does not follow",
    });
  }
  const candidates: {
    readonly worktree: string;
    readonly destination: string;
    readonly classified: Extract<Classified, { kind: "linked" }>;
    readonly copiedDotGit: Buffer;
  }[] = [];
  let gitChecked: boolean | null = null;
  for (const worktree of worktrees) {
    const classified = await classifyWorktree(worktree, roots);
    if (classified.kind === "none") continue;
    if (classified.kind === "blocked") {
      blockers.push({
        code: classified.code,
        object: worktree,
        message: classified.message,
      });
      continue;
    }
    gitChecked ??= await gitSupportsRepair();
    if (!gitChecked) {
      blockers.push({
        code: "git-unsupported",
        object: worktree,
        message: "Git 2.29 or newer (with `git worktree repair`) is required",
      });
      continue;
    }
    const destination = rebaseRootPath(
      worktree,
      roots.sourceRoot,
      roots.destinationRoot,
      platform(),
    );
    const sourceDotGit = await readFile(join(worktree, ".git"));
    const copiedDotGit =
      destination === null
        ? null
        : await readOptional(join(destination, ".git"));
    if (destination === null || copiedDotGit === null) {
      blockers.push({
        code: "git-copy-missing",
        object: worktree,
        message: "the worktree's destination copy has no .git link",
      });
      continue;
    }
    // The copy must name exactly the admin entry the source does: Git follows
    // the copy's link, and the ledger covers only this repository.
    if (!copiedDotGit.equals(sourceDotGit)) {
      blockers.push({
        code: "git-copy-link-mismatch",
        object: worktree,
        message: "the destination copy's .git link differs from the source's",
      });
      continue;
    }
    candidates.push({ worktree, destination, classified, copiedDotGit });
  }
  // Every worktree of one repository moved by this plan, by repository: each
  // action leaves the others out of its sibling digest (each has its own
  // action and image), while the pre-repair safety check still requires
  // their links to be consistent - before or after their own repair - so
  // `repair` writes nothing to them.
  const migratedByRepository = new Map<string, string[]>();
  for (const candidate of candidates) {
    const key = await canonicalLocation(candidate.classified.commonDir);
    const admins = migratedByRepository.get(key) ?? [];
    admins.push(candidate.classified.adminDir);
    migratedByRepository.set(key, admins);
  }
  for (const {
    worktree,
    destination,
    classified,
    copiedDotGit,
  } of candidates) {
    const migratedAdmins = migratedByRepository.get(
      await canonicalLocation(classified.commonDir),
    ) ?? [classified.adminDir];
    const gitdirBefore = await readFile(join(classified.adminDir, "gitdir"));
    const gitdirAfter = Buffer.from(
      `${gitPath(await realpath(join(destination, ".git")))}\n`,
      "utf8",
    );
    const forward: Forward = {
      adapter: GIT_WORKTREE_LINK_ADAPTER,
      version: 1,
      stage: "prepare",
      sourceWorktree: worktree,
      destinationWorktree: destination,
      adminDir: classified.adminDir,
      commonDir: classified.commonDir,
      dotGit: copiedDotGit.toString("base64"),
      gitdirAfter: gitdirAfter.toString("base64"),
      migratedAdmins,
      siblings: await siblingsDigest(classified.commonDir, migratedAdmins),
      snapshot: await snapshotWorktree(worktree),
    };
    const before = await observeProjection(forward);
    if (before.siblings !== forward.siblings) {
      blockers.push({
        code: "git-repository-changing",
        object: classified.commonDir,
        message:
          "the repository's worktree metadata changed while the migration read it",
      });
      continue;
    }
    actions.push({
      id: externalActionId("git", classified.adminDir),
      kind: "git-metadata",
      object: classified.adminDir,
      before: presentFingerprint(before),
      after: presentFingerprint({ ...before, gitdir: sha256Hex(gitdirAfter) }),
      forward,
      inverse: {
        adapter: GIT_WORKTREE_LINK_ADAPTER,
        version: 1,
        gitdir: gitdirBefore.toString("base64"),
      },
      state: "planned",
    });
  }
  return { actions, blockers };
}
