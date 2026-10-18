import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { ExternalAction } from "@traycer/protocol/config/data-migration-contracts";
import { runCommand } from "../../../service/process-runner";
import {
  applyGitWorktree,
  gitWorktreeForwardSchema,
  invertGitWorktree,
  planGitWorktreeRelocation,
  porcelainV2Paths,
  setGitRunnerForTests,
  verifyGitWorktreeCopy,
  type GitRunner,
} from "../git-worktree-actions";
import { isExternalActionConflictError } from "../ledger";
import {
  reconcileExternalAction,
  verifySettledExternalActions,
} from "../reconcile";

// REAL git in isolated temp folders. Nothing here touches a user repository:
// HOME and the global/system git config are redirected for the fixture's own
// git calls AND for the adapter's (through the recording runner below).

let base = "";
let home = "";
const savedHome = process.env.HOME;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^GIT_/iu.test(name)) env[name] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
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

const recorded: string[][] = [];
const recordingRunner: GitRunner = (args, options) => {
  recorded.push([...args]);
  return runCommand("git", args, {
    env: gitEnv(),
    cwd: undefined,
    timeoutMs: 60_000,
    tolerateNonZeroExit: options.tolerateNonZeroExit,
  });
};

function repairRuns(): string[][] {
  return recorded.filter((argv) => argv.includes("repair"));
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "traycer-git-actions-")));
  home = join(base, "home");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "gitconfig"), "");
  process.env.HOME = home;
});

afterAll(async () => {
  if (savedHome === undefined) Reflect.deleteProperty(process.env, "HOME");
  else process.env.HOME = savedHome;
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  recorded.length = 0;
  setGitRunnerForTests(recordingRunner);
});

afterEach(() => {
  setGitRunnerForTests(null);
});

// ---- Exact-bytes capture -------------------------------------------------------

type Tree = ReadonlyMap<string, string>;

/** Every file under `root` (relative path -> sha256 of its bytes). */
async function readTree(root: string): Promise<Tree> {
  const tree = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        tree.set(`${key}/`, "dir");
        await walk(path, key);
      } else if (entry.isFile()) {
        tree.set(
          key,
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        );
      }
    }
  };
  await walk(root, "");
  return tree;
}

function changedPaths(before: Tree, after: Tree): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort();
}

// ---- Fixture -------------------------------------------------------------------

type Fixture = {
  readonly root: string;
  readonly repoA: string;
  readonly repoB: string;
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly sourceWorktree: string;
  readonly destinationWorktree: string;
  readonly adminDir: string;
  /** Linked worktree of repository B, an unrelated repository. */
  readonly bAdminDir: string;
};

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  await writeFile(join(path, "tracked.txt"), "one\ntwo\n");
  await writeFile(join(path, "other.bin"), Buffer.from([0, 1, 2, 255, 254]));
  git(path, "add", ".");
  git(path, "commit", "-q", "-m", "init");
}

/**
 * Repository A with one managed linked worktree under `<root>/src`, dirty
 * (tracked edit + untracked files), plus an unrelated repository B with a
 * linked worktree of its own. The destination copy is made by `copyAfter`
 * (default: right away), so a case can change the source first.
 */
async function makeFixture(options: {
  readonly mutateSource: (fixture: Fixture) => Promise<void>;
}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(base, "case-")));
  const repoA = join(root, "repoA");
  const repoB = join(root, "repoB");
  const sourceRoot = join(root, "src");
  const destinationRoot = join(root, "dest");
  const sourceWorktree = join(sourceRoot, "worktrees", "g", "s");
  const destinationWorktree = join(destinationRoot, "worktrees", "g", "s");
  await initRepo(repoA);
  await initRepo(repoB);
  await mkdir(join(sourceRoot, "worktrees", "g"), { recursive: true });
  git(repoA, "worktree", "add", "-q", "-b", "feat", sourceWorktree);
  const bWorktree = join(root, "b-wt");
  git(repoB, "worktree", "add", "-q", "-b", "bfeat", bWorktree);
  // Dirty tracked edit + untracked files (spaces, Unicode, binary bytes).
  await writeFile(join(sourceWorktree, "tracked.txt"), "one\nTWO edited\n");
  await mkdir(join(sourceWorktree, "sub dir"), { recursive: true });
  await writeFile(
    join(sourceWorktree, "sub dir", "ünï.txt"),
    "untracked text\n",
  );
  await writeFile(
    join(sourceWorktree, "blob.bin"),
    Buffer.from([9, 0, 8, 255, 7]),
  );
  const adminDir = join(repoA, ".git", "worktrees", "s");
  const fixture: Fixture = {
    root,
    repoA,
    repoB,
    sourceRoot,
    destinationRoot,
    sourceWorktree,
    destinationWorktree,
    adminDir: await realpath(adminDir),
    bAdminDir: await realpath(join(repoB, ".git", "worktrees", "b-wt")),
  };
  await options.mutateSource(fixture);
  await mkdir(join(destinationRoot, "worktrees", "g"), { recursive: true });
  await cp(sourceWorktree, destinationWorktree, {
    recursive: true,
    verbatimSymlinks: true,
  });
  return fixture;
}

const noMutation = async (): Promise<void> => undefined;

type Snapshot = {
  readonly repoAGit: Tree;
  readonly repoB: Tree;
  readonly source: Tree;
  readonly destination: Tree;
  readonly bWorktree: Tree;
};

async function capture(fixture: Fixture): Promise<Snapshot> {
  return {
    repoAGit: await readTree(join(fixture.repoA, ".git")),
    repoB: await readTree(fixture.repoB),
    source: await readTree(fixture.sourceWorktree),
    destination: await readTree(fixture.destinationWorktree),
    bWorktree: await readTree(join(fixture.root, "b-wt")),
  };
}

function plan(fixture: Fixture) {
  return planGitWorktreeRelocation({
    roots: {
      sourceRoot: fixture.sourceRoot,
      destinationRoot: fixture.destinationRoot,
    },
  });
}

async function planned(fixture: Fixture): Promise<ExternalAction> {
  const result = await plan(fixture);
  expect(result.blockers).toEqual([]);
  expect(result.actions).toHaveLength(1);
  return result.actions[0] as ExternalAction;
}

// ---- Happy path ----------------------------------------------------------------

describe(
  "git worktree relocation against real git",
  { timeout: 120_000 },
  () => {
    it("plans one git-metadata action and changes exactly the admin gitdir, reversibly", async () => {
      const fixture = await makeFixture({ mutateSource: noMutation });
      const initial = await capture(fixture);
      const action = await planned(fixture);
      expect(action.kind).toBe("git-metadata");
      const forward = gitWorktreeForwardSchema.parse(action.forward);
      expect(forward.adminDir).toBe(fixture.adminDir);
      expect(forward.destinationWorktree).toBe(fixture.destinationWorktree);
      const gitdirAfter = Buffer.from(forward.gitdirAfter, "base64").toString(
        "utf8",
      );
      if (process.platform !== "win32") {
        expect(gitdirAfter).toBe(
          `${join(fixture.destinationWorktree, ".git")}\n`,
        );
      }

      // Planning is read-only.
      expect(await capture(fixture)).toEqual(initial);
      const adminId = basename(fixture.adminDir);

      const applied = await reconcileExternalAction(action, "forward", [
        action,
      ]);
      expect(applied.kind).toBe("settled");
      if (applied.kind !== "settled") return;
      expect(applied.action.state).toBe("applied");
      expect(repairRuns()).toHaveLength(1);
      expect(repairRuns()[0]).toEqual([
        "-c",
        "worktree.useRelativePaths=false",
        "-C",
        fixture.destinationWorktree,
        "worktree",
        "repair",
      ]);

      const afterApply = await capture(fixture);
      // Only the admin entry's gitdir changed in repository A's .git ...
      expect(changedPaths(initial.repoAGit, afterApply.repoAGit)).toEqual([
        `worktrees/${adminId}/gitdir`,
      ]);
      expect(
        (await readFile(join(fixture.adminDir, "gitdir"))).toString("utf8"),
      ).toBe(gitdirAfter);
      // ... and nothing else moved: the copy (its .git and every dirty/untracked
      // file), the source worktree, and the unrelated repository B.
      expect(afterApply.destination).toEqual(initial.destination);
      expect(afterApply.source).toEqual(initial.source);
      expect(afterApply.repoB).toEqual(initial.repoB);
      expect(afterApply.bWorktree).toEqual(initial.bWorktree);

      expect(await verifyGitWorktreeCopy(applied.action)).toEqual({ ok: true });
      const list = git(
        fixture.destinationWorktree,
        "--no-optional-locks",
        "worktree",
        "list",
        "--porcelain",
      );
      expect(list).toContain(`worktree ${fixture.destinationWorktree}`);
      expect(list).not.toContain(`worktree ${fixture.sourceWorktree}`);

      const inverted = await reconcileExternalAction(
        applied.action,
        "inverse",
        [applied.action],
      );
      expect(inverted.kind).toBe("settled");
      if (inverted.kind !== "settled") return;
      expect(inverted.action.state).toBe("inverted");
      expect(await capture(fixture)).toEqual(initial);
      // The source worktree works again.
      const status = git(
        fixture.sourceWorktree,
        "--no-optional-locks",
        "status",
        "--porcelain",
      );
      expect(status).toContain("tracked.txt");
      expect(status).toContain("blob.bin");
      expect(
        git(
          fixture.sourceWorktree,
          "--no-optional-locks",
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ).trim(),
      ).toBe("feat");
    });

    it("verifyGitWorktreeCopy reports a changed dirty file in the copy", async () => {
      const fixture = await makeFixture({ mutateSource: noMutation });
      const action = await planned(fixture);
      const applied = await reconcileExternalAction(action, "forward", [
        action,
      ]);
      if (applied.kind !== "settled") throw new Error("apply failed");
      await writeFile(join(fixture.destinationWorktree, "blob.bin"), "changed");
      const result = await verifyGitWorktreeCopy(applied.action);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.mismatches).toContain("content differs: blob.bin");
      }
    });

    it("a crash after the effect, before the receipt, is recorded applied without running git again", async () => {
      const fixture = await makeFixture({ mutateSource: noMutation });
      const action = await planned(fixture);
      await applyGitWorktree(action);
      recorded.length = 0;
      const outcome = await reconcileExternalAction(action, "forward", [
        action,
      ]);
      expect(outcome.kind).toBe("settled");
      if (outcome.kind === "settled")
        expect(outcome.decision).toBe("record-applied");
      expect(repairRuns()).toHaveLength(0);
    });
  },
);

// ---- Another repository is never reachable -----------------------------------------

describe(
  "the command can reach only the recorded repository",
  { timeout: 120_000 },
  () => {
    it("blocks a copy whose .git names another repository's admin entry", async () => {
      const fixture = await makeFixture({ mutateSource: noMutation });
      await writeFile(
        join(fixture.destinationWorktree, ".git"),
        `gitdir: ${fixture.bAdminDir}\n`,
      );
      const before = await capture(fixture);
      const result = await plan(fixture);
      expect(result.actions).toEqual([]);
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0]).toMatchObject({
        code: "git-copy-link-mismatch",
        object: fixture.sourceWorktree,
      });
      expect(repairRuns()).toHaveLength(0);
      expect(await capture(fixture)).toEqual(before);
    });

    it("conflicts, without running git, when the copy's .git is repointed after planning", async () => {
      const fixture = await makeFixture({ mutateSource: noMutation });
      const action = await planned(fixture);
      await writeFile(
        join(fixture.destinationWorktree, ".git"),
        `gitdir: ${fixture.bAdminDir}\n`,
      );
      const before = await capture(fixture);
      recorded.length = 0;

      const outcome = await reconcileExternalAction(action, "forward", [
        action,
      ]);
      expect(outcome.kind).toBe("conflict");
      expect(repairRuns()).toHaveLength(0);

      // The write itself refuses too (the apply recheck), still without git.
      const failure = await applyGitWorktree(action).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(isExternalActionConflictError(failure)).toBe(true);
      expect(repairRuns()).toHaveLength(0);

      const after = await capture(fixture);
      expect(after.repoAGit).toEqual(before.repoAGit);
      expect(after.repoB).toEqual(before.repoB);
      expect(after.bWorktree).toEqual(before.bWorktree);
      expect(after.destination).toEqual(before.destination);
    });
  },
);

// ---- Siblings and concurrent edits ---------------------------------------------------

describe(
  "recorded metadata is rechecked before git runs",
  { timeout: 120_000 },
  () => {
    it("conflicts, without running git, when the common config changed after planning", async () => {
      const fixture = await makeFixture({ mutateSource: noMutation });
      const action = await planned(fixture);
      const config = join(fixture.repoA, ".git", "config");
      await writeFile(
        config,
        `${await readFile(config, "utf8")}[traycer]\n\ttest = 1\n`,
      );
      const before = await capture(fixture);
      recorded.length = 0;

      expect(
        (await reconcileExternalAction(action, "forward", [action])).kind,
      ).toBe("conflict");
      const failure = await applyGitWorktree(action).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(isExternalActionConflictError(failure)).toBe(true);
      expect(repairRuns()).toHaveLength(0);
      expect(await capture(fixture)).toEqual(before);
    });

    it("conflicts, without running git, when a sibling worktree's link changed after planning", async () => {
      const fixture = await makeFixture({ mutateSource: noMutation });
      const sibling = join(fixture.root, "sibling-wt");
      git(fixture.repoA, "worktree", "add", "-q", "-b", "sib", sibling);
      const action = await planned(fixture);
      // A sibling whose worktree link now names the wrong entry: repair would rewrite it.
      await writeFile(join(sibling, ".git"), `gitdir: ${fixture.adminDir}\n`);
      const before = await capture(fixture);
      recorded.length = 0;

      expect(
        (await reconcileExternalAction(action, "forward", [action])).kind,
      ).toBe("conflict");
      const failure = await applyGitWorktree(action).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(isExternalActionConflictError(failure)).toBe(true);
      expect(repairRuns()).toHaveLength(0);
      expect(await capture(fixture)).toEqual(before);
    });

    it("an inverse conflicts, leaving the file alone, when the admin gitdir was edited after apply (same target, different spelling)", async () => {
      const fixture = await makeFixture({ mutateSource: noMutation });
      const action = await planned(fixture);
      const applied = await reconcileExternalAction(action, "forward", [
        action,
      ]);
      if (applied.kind !== "settled") throw new Error("apply failed");
      const gitdir = join(fixture.adminDir, "gitdir");
      const respelled = `${fixture.destinationRoot}/./worktrees/g/../g/s/.git\n`;
      await writeFile(gitdir, respelled);
      const before = await capture(fixture);

      const outcome = await reconcileExternalAction(applied.action, "inverse", [
        applied.action,
      ]);
      expect(outcome.kind).toBe("conflict");
      const failure = await invertGitWorktree(applied.action).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(isExternalActionConflictError(failure)).toBe(true);
      expect(await readFile(gitdir, "utf8")).toBe(respelled);
      expect(await capture(fixture)).toEqual(before);
    });
  },
);

// ---- Blockers ----------------------------------------------------------------------------

describe("planning refuses before any effect", { timeout: 120_000 }, () => {
  async function expectBlocked(
    mutateSource: (fixture: Fixture) => Promise<void>,
    code: string,
  ): Promise<void> {
    const fixture = await makeFixture({ mutateSource });
    const before = await capture(fixture);
    const result = await plan(fixture);
    expect(result.actions).toEqual([]);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([code]);
    expect(repairRuns()).toHaveLength(0);
    expect(await capture(fixture)).toEqual(before);
  }

  it("a locked worktree", async () => {
    await expectBlocked(async (f) => {
      git(f.repoA, "worktree", "lock", f.sourceWorktree);
    }, "git-locked-worktree");
  });

  it("submodules (.gitmodules present)", async () => {
    await expectBlocked(async (f) => {
      await writeFile(
        join(f.sourceWorktree, ".gitmodules"),
        '[submodule "x"]\n',
      );
    }, "git-submodules");
  });

  it("a nested .git directory", async () => {
    await expectBlocked(async (f) => {
      await mkdir(join(f.sourceWorktree, "vendor", "lib", ".git"), {
        recursive: true,
      });
    }, "git-nested-repository");
  });

  it("a relative gitdir link", async () => {
    await expectBlocked(async (f) => {
      await writeFile(
        join(f.sourceWorktree, ".git"),
        "gitdir: ../../../../repoA/.git/worktrees/s\n",
      );
    }, "git-relative-link");
  });

  it("a missing admin entry", async () => {
    await expectBlocked(async (f) => {
      await rm(f.adminDir, { recursive: true, force: true });
    }, "git-missing-common-dir");
  });

  it("a sibling worktree whose backlink is broken", async () => {
    await expectBlocked(async (f) => {
      const sibling = join(f.root, "sibling-wt");
      git(f.repoA, "worktree", "add", "-q", "-b", "sib", sibling);
      await writeFile(join(sibling, ".git"), `gitdir: ${f.adminDir}\n`);
    }, "git-sibling-needs-repair");
  });

  it("a source .git that is not in the form git worktree repair writes", async () => {
    await expectBlocked(async (f) => {
      await writeFile(
        join(f.sourceWorktree, ".git"),
        `gitdir: ${f.adminDir}/\n`,
      );
    }, "git-link-not-canonical");
  });
});

// ---- Several worktrees of one repository ----------------------------------------------------

type MultiFixture = {
  readonly root: string;
  readonly repoA: string;
  readonly repoB: string;
  readonly outside: string;
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly slugs: readonly string[];
};

async function makeMultiFixture(): Promise<MultiFixture> {
  const root = await realpath(await mkdtemp(join(base, "multi-")));
  const repoA = join(root, "repoA");
  const repoB = join(root, "repoB");
  const sourceRoot = join(root, "src");
  const destinationRoot = join(root, "dest");
  const outside = join(root, "outside-wt");
  const slugs = ["s", "t"];
  await initRepo(repoA);
  await initRepo(repoB);
  git(repoB, "worktree", "add", "-q", "-b", "bfeat", join(root, "b-wt"));
  git(repoA, "worktree", "add", "-q", "-b", "out", outside);
  await mkdir(join(sourceRoot, "worktrees", "g"), { recursive: true });
  await mkdir(join(destinationRoot, "worktrees", "g"), { recursive: true });
  for (const slug of slugs) {
    const worktree = join(sourceRoot, "worktrees", "g", slug);
    git(repoA, "worktree", "add", "-q", "-b", `feat-${slug}`, worktree);
    await writeFile(join(worktree, "tracked.txt"), `one\nedited by ${slug}\n`);
    await writeFile(
      join(worktree, `untracked ${slug}.txt`),
      `untracked ${slug}\n`,
    );
    await writeFile(
      join(worktree, "blob.bin"),
      Buffer.from([1, 2, 0, 255, slug.charCodeAt(0)]),
    );
    await cp(worktree, join(destinationRoot, "worktrees", "g", slug), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  return { root, repoA, repoB, outside, sourceRoot, destinationRoot, slugs };
}

type MultiSnapshot = {
  readonly repoAGit: Tree;
  readonly repoB: Tree;
  readonly bWorktree: Tree;
  readonly outside: Tree;
  readonly sources: readonly Tree[];
  readonly destinations: readonly Tree[];
};

async function captureMulti(f: MultiFixture): Promise<MultiSnapshot> {
  return {
    repoAGit: await readTree(join(f.repoA, ".git")),
    repoB: await readTree(f.repoB),
    bWorktree: await readTree(join(f.root, "b-wt")),
    outside: await readTree(f.outside),
    sources: await Promise.all(
      f.slugs.map((slug) =>
        readTree(join(f.sourceRoot, "worktrees", "g", slug)),
      ),
    ),
    destinations: await Promise.all(
      f.slugs.map((slug) =>
        readTree(join(f.destinationRoot, "worktrees", "g", slug)),
      ),
    ),
  };
}

describe(
  "two managed worktrees of one repository",
  { timeout: 120_000 },
  () => {
    async function planBoth(f: MultiFixture): Promise<ExternalAction[]> {
      const result = await planGitWorktreeRelocation({
        roots: { sourceRoot: f.sourceRoot, destinationRoot: f.destinationRoot },
      });
      expect(result.blockers).toEqual([]);
      expect(result.actions).toHaveLength(2);
      return [...result.actions];
    }

    function settle(
      ledger: readonly ExternalAction[],
      next: ExternalAction,
    ): ExternalAction[] {
      return ledger.map((entry) => (entry.id === next.id ? next : entry));
    }

    async function step(
      ledger: readonly ExternalAction[],
      action: ExternalAction,
      direction: "forward" | "inverse",
    ): Promise<{ ledger: ExternalAction[]; decision: string }> {
      const current = ledger.find(
        (entry) => entry.id === action.id,
      ) as ExternalAction;
      const outcome = await reconcileExternalAction(current, direction, ledger);
      if (outcome.kind !== "settled")
        throw new Error(`${action.id}: ${outcome.reason}`);
      return {
        ledger: settle(ledger, outcome.action),
        decision: outcome.decision,
      };
    }

    async function expectSourcesWork(f: MultiFixture): Promise<void> {
      for (const slug of f.slugs) {
        const status = git(
          join(f.sourceRoot, "worktrees", "g", slug),
          "--no-optional-locks",
          "status",
          "--porcelain",
        );
        expect(status).toContain("tracked.txt");
        expect(status).toContain(`untracked ${slug}.txt`);
      }
    }

    it("plans one action per worktree, each naming both admins as migrated", async () => {
      const f = await makeMultiFixture();
      const actions = await planBoth(f);
      const admins = actions
        .map(
          (action) => gitWorktreeForwardSchema.parse(action.forward).adminDir,
        )
        .sort();
      expect(new Set(admins).size).toBe(2);
      for (const action of actions) {
        expect(
          [
            ...gitWorktreeForwardSchema.parse(action.forward).migratedAdmins,
          ].sort(),
        ).toEqual(admins);
      }
    });

    it("applies both in turn, changing only the two admin gitdir files", async () => {
      const f = await makeMultiFixture();
      const initial = await captureMulti(f);
      const actions = await planBoth(f);
      expect(await captureMulti(f)).toEqual(initial);

      let ledger = [...actions];
      for (const action of actions) {
        const result = await step(ledger, action, "forward");
        expect(result.decision).toBe("apply");
        ledger = result.ledger;
      }
      expect(ledger.map((entry) => entry.state)).toEqual([
        "applied",
        "applied",
      ]);

      const after = await captureMulti(f);
      const expectedChanged = actions
        .map((action) => {
          const forward = gitWorktreeForwardSchema.parse(action.forward);
          return `worktrees/${basename(forward.adminDir)}/gitdir`;
        })
        .sort();
      expect(changedPaths(initial.repoAGit, after.repoAGit)).toEqual(
        expectedChanged,
      );
      for (const action of actions) {
        const forward = gitWorktreeForwardSchema.parse(action.forward);
        expect(
          (await readFile(join(forward.adminDir, "gitdir"))).toString("base64"),
        ).toBe(forward.gitdirAfter);
      }
      // The outside sibling, the common config (inside repoAGit, covered above), B and the copies.
      expect(after.outside).toEqual(initial.outside);
      expect(after.repoB).toEqual(initial.repoB);
      expect(after.bWorktree).toEqual(initial.bWorktree);
      expect(after.sources).toEqual(initial.sources);
      expect(after.destinations).toEqual(initial.destinations);

      for (const action of ledger)
        expect(await verifyGitWorktreeCopy(action)).toEqual({ ok: true });
      expect(await verifySettledExternalActions(ledger)).toEqual([]);
    });

    it("recovers a crash after the first action's effect and rolls both back to the exact bytes", async () => {
      const f = await makeMultiFixture();
      const initial = await captureMulti(f);
      const actions = await planBoth(f);
      const [first, second] = actions as [ExternalAction, ExternalAction];

      await applyGitWorktree(first); // effect on disk, no receipt
      recorded.length = 0;
      let ledger = [...actions];
      const one = await step(ledger, first, "forward");
      expect(one.decision).toBe("record-applied");
      expect(repairRuns()).toHaveLength(0);
      ledger = one.ledger;
      const two = await step(ledger, second, "forward");
      expect(two.decision).toBe("apply");
      ledger = two.ledger;
      expect(ledger.map((entry) => entry.state)).toEqual([
        "applied",
        "applied",
      ]);
      expect(await verifySettledExternalActions(ledger)).toEqual([]);

      for (const action of [second, first]) {
        const result = await step(ledger, action, "inverse");
        expect(result.decision).toBe("invert");
        ledger = result.ledger;
      }
      expect(ledger.map((entry) => entry.state)).toEqual([
        "inverted",
        "inverted",
      ]);
      expect(await captureMulti(f)).toEqual(initial);
      await expectSourcesWork(f);
    });
  },
);

// ---- porcelainV2Paths ------------------------------------------------------------------------

describe("porcelainV2Paths", () => {
  const H = "1111111111111111111111111111111111111111";
  const G = "2222222222222222222222222222222222222222";

  it("reads an ordinary change, keeping spaces in the name", () => {
    expect(
      porcelainV2Paths(
        `1 .M N... 100644 100644 100644 ${H} ${G} dir/a name.txt\0`,
      ),
    ).toEqual(["dir/a name.txt"]);
  });

  it("reads a rename and skips the original-path record", () => {
    expect(
      porcelainV2Paths(
        `2 R. N... 100644 100644 100644 ${H} ${G} R100 new name.txt\0old name.txt\0? after.txt\0`,
      ),
    ).toEqual(["new name.txt", "after.txt"]);
  });

  it("reads an unmerged entry", () => {
    expect(
      porcelainV2Paths(
        `u UU N... 100644 100644 100644 100644 ${H} ${G} ${H} conflicted file.txt\0`,
      ),
    ).toEqual(["conflicted file.txt"]);
  });

  it("reads untracked and ignored entries and skips headers", () => {
    expect(
      porcelainV2Paths(
        `# branch.oid ${H}\0# branch.head main\0? sub dir/ünï.txt\0! build/out.o\0`,
      ),
    ).toEqual(["sub dir/ünï.txt", "build/out.o"]);
  });

  it("returns nothing for an empty status", () => {
    expect(porcelainV2Paths("")).toEqual([]);
  });
});
