import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { runCommand } from "../../../service/process-runner";
import {
  setGitRunnerForTests,
  type GitRunner,
} from "../../external-actions/git-worktree-actions";
import { rollbackMigration, startMigration } from "../migration-engine";
import {
  assertDone,
  captureSource,
  CrashError,
  crashAtCheckpoint,
  expectCompleted,
  expectRolledBack,
  harnessScope,
  readActiveJournal,
  type EngineHarness,
} from "./engine-fixtures";

/**
 * The engine moving a managed Git worktree with REAL git, in isolated temp
 * folders. HOME and the global/system git configuration are redirected for the
 * fixture's own git calls AND for the adapter's (through the runner below);
 * nothing here reads or writes a user repository.
 */

function gitSupportsRepair(): boolean {
  const result = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return false;
  const match = /(\d+)\.(\d+)/u.exec(result.stdout);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 29);
}

let gitHome = "";

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^GIT_/iu.test(name)) env[name] = value;
  }
  env.HOME = gitHome;
  env.USERPROFILE = gitHome;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = join(gitHome, "gitconfig");
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, env: gitEnv(), encoding: "utf8" },
  );
}

const isolatedRunner: GitRunner = (args, options) =>
  runCommand("git", args, {
    env: gitEnv(),
    cwd: undefined,
    timeoutMs: 60_000,
    tolerateNonZeroExit: options.tolerateNonZeroExit,
  });

const TRACKED_EDIT = "one\nTWO edited\n";
const UNTRACKED_TEXT = "untracked text\n";
const BINARY = Buffer.from([9, 0, 8, 255, 7]);

type GitFixture = {
  readonly repo: string;
  readonly sourceWorktree: string;
  readonly destinationWorktree: string;
  readonly adminGitdir: string;
};

/** An external repository with one linked worktree under the SOURCE root's managed folder, dirty and with untracked files. */
async function makeGitFixture(harness: EngineHarness): Promise<GitFixture> {
  const repo = join(harness.base, "repo");
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "tracked.txt"), "one\ntwo\n");
  await writeFile(join(repo, "other.bin"), Buffer.from([0, 1, 2, 255, 254]));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const sourceWorktree = join(harness.sourceRoot, "worktrees", "g1", "w1");
  await mkdir(join(harness.sourceRoot, "worktrees", "g1"), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", "feat", sourceWorktree);
  // A canonical `.git` link, the form the planner requires.
  git(sourceWorktree, "worktree", "repair");
  await writeFile(join(sourceWorktree, "tracked.txt"), TRACKED_EDIT);
  await mkdir(join(sourceWorktree, "sub dir"), { recursive: true });
  await writeFile(join(sourceWorktree, "sub dir", "ünï.txt"), UNTRACKED_TEXT);
  await writeFile(join(sourceWorktree, "blob.bin"), BINARY);
  return {
    repo,
    sourceWorktree,
    destinationWorktree: join(harness.destinationRoot, "worktrees", "g1", "w1"),
    adminGitdir: await realpath(
      join(repo, ".git", "worktrees", "w1", "gitdir"),
    ),
  };
}

describe.skipIf(process.platform === "win32" || !gitSupportsRepair())(
  "migration engine with real git",
  { timeout: 300_000 },
  () => {
    const scope = harnessScope();

    beforeAll(async () => {
      gitHome = await realpath(
        await mkdtemp(join(tmpdir(), "traycer-engine-githome-")),
      );
      await writeFile(join(gitHome, "gitconfig"), "");
    });

    afterAll(async () => {
      await rm(gitHome, { recursive: true, force: true });
    });

    beforeEach(() => {
      setGitRunnerForTests(isolatedRunner);
    });

    afterEach(() => {
      setGitRunnerForTests(null);
    });

    it("moves a dirty managed worktree: HEAD, status and dirty bytes equal, git names the destination", async () => {
      const harness = await scope.create();
      const fixture = await makeGitFixture(harness);
      const before = await captureSource(harness.sourceRoot);
      const headBefore = git(
        fixture.sourceWorktree,
        "rev-parse",
        "HEAD",
      ).trim();
      const statusBefore = git(
        fixture.sourceWorktree,
        "--no-optional-locks",
        "status",
        "--porcelain",
      );
      const gitdirBefore = await readFile(fixture.adminGitdir);
      expect(statusBefore).toContain("tracked.txt");
      expect(statusBefore).toContain("blob.bin");

      const journal = assertDone(
        await startMigration(harness.makeDeps({}), {
          destination: harness.destinationRoot,
          acceptedSessionImpactDigest: null,
          reviewImpact: false,
        }),
      );

      await expectCompleted(harness, journal, before);
      const gitActions = journal.actions.filter(
        (action) => action.kind === "git-metadata",
      );
      expect(gitActions).toHaveLength(1);
      expect(gitActions[0]?.state).toBe("applied");

      const destination = fixture.destinationWorktree;
      expect(git(destination, "rev-parse", "HEAD").trim()).toBe(headBefore);
      expect(
        git(
          destination,
          "--no-optional-locks",
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ).trim(),
      ).toBe("feat");
      expect(
        git(destination, "--no-optional-locks", "status", "--porcelain"),
      ).toBe(statusBefore);
      expect(await readFile(join(destination, "tracked.txt"), "utf8")).toBe(
        TRACKED_EDIT,
      );
      expect(
        await readFile(join(destination, "sub dir", "ünï.txt"), "utf8"),
      ).toBe(UNTRACKED_TEXT);
      expect(await readFile(join(destination, "blob.bin"))).toEqual(BINARY);

      const list = git(
        fixture.repo,
        "--no-optional-locks",
        "worktree",
        "list",
        "--porcelain",
      );
      expect(list).toContain(`worktree ${destination}`);
      expect(list).not.toContain(`worktree ${fixture.sourceWorktree}`);
      // Exactly the admin entry's gitdir moved; the repository's other files did not.
      expect(await readFile(fixture.adminGitdir, "utf8")).toBe(
        `${join(destination, ".git")}\n`,
      );
      expect(await readFile(fixture.adminGitdir)).not.toEqual(gitdirBefore);
    });

    describe("rollback restores the repository's admin entry byte for byte", () => {
      it.each([
        { point: "before-journal:ready", phase: "preparing-external" },
        { point: "after-journal:ready", phase: "ready" },
        { point: "after-journal:switched", phase: "switched" },
      ])("from $phase", async ({ point, phase }) => {
        const harness = await scope.create();
        const fixture = await makeGitFixture(harness);
        const before = await captureSource(harness.sourceRoot);
        const statusBefore = git(
          fixture.sourceWorktree,
          "--no-optional-locks",
          "status",
          "--porcelain",
        );
        const gitdirBefore = await readFile(fixture.adminGitdir);

        const crash = crashAtCheckpoint({
          target: point,
          occurrence: 1,
          normalize: harness.normalizeCheckpoint,
        });
        await expect(
          startMigration(harness.makeDeps({ checkpoint: crash.checkpoint }), {
            destination: harness.destinationRoot,
            acceptedSessionImpactDigest: null,
            reviewImpact: false,
          }),
        ).rejects.toBeInstanceOf(CrashError);
        expect(readActiveJournal(harness.bootstrapDir).phase).toBe(phase);
        // The git action was applied before the halt: the admin entry names the destination.
        expect(await readFile(fixture.adminGitdir)).not.toEqual(gitdirBefore);

        const journal = assertDone(
          await rollbackMigration(harness.makeDeps({})),
        );

        await expectRolledBack(harness, journal, before);
        expect(await readFile(fixture.adminGitdir)).toEqual(gitdirBefore);
        expect(
          git(
            fixture.sourceWorktree,
            "--no-optional-locks",
            "status",
            "--porcelain",
          ),
        ).toBe(statusBefore);
        const list = git(
          fixture.repo,
          "--no-optional-locks",
          "worktree",
          "list",
          "--porcelain",
        );
        expect(list).toContain(`worktree ${fixture.sourceWorktree}`);
        expect(list).not.toContain(`worktree ${fixture.destinationWorktree}`);
      });
    });
  },
);
