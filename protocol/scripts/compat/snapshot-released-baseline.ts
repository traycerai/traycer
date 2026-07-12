/**
 * Snapshot the newest released baseline's protocol surface into the in-tree
 * fixture used by `released-baseline-compat.test.ts`.
 *
 *   bun run protocol/scripts/compat/snapshot-released-baseline.ts [<remote-or-url>]
 *
 * Resolves the protected baseline set the same way `resolve-baselines.ts` does
 * (remote tags at/above the support floor), picks the newest version, dumps
 * that tag's surface via a detached worktree with the same dump-script
 * injection the protocol-compat workflow uses, and writes
 * `protocol/src/host/__tests__/__fixtures__/released-baseline-surface.json`
 * deterministically (`buildProtocolSurface` already stable-sorts keys; trailing
 * newline enforced).
 *
 * That fixture is the same artifact releases publish as `protocol-surface.json`.
 * The companion unit test is a fast local tripwire; the authoritative gate is
 * the protocol-compat workflow whose baselines come from immutable remote tags,
 * so editing this fixture cannot fool CI.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const SUPPORT_FLOOR_SCHEMA = z.object({
  supportFloor: z.string().regex(/^\d+\.\d+\.\d+$/),
  includeReleaseCandidates: z.boolean(),
});

const floorConfig = SUPPORT_FLOOR_SCHEMA.parse(
  JSON.parse(
    readFileSync(join(import.meta.dirname, "support-floor.json"), "utf8"),
  ),
);

const remote = process.argv[2] ?? "origin";
const FIXTURE_PATH = join(
  import.meta.dirname,
  "../../src/host/__tests__/__fixtures__/released-baseline-surface.json",
);

const STABLE_TAG_PATTERN =
  /^refs\/tags\/(host|cli|desktop)-v(\d+)\.(\d+)\.(\d+)$/;
const RC_TAG_PATTERN =
  /^refs\/tags\/(host|cli|desktop)-v(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/;

function versionAtOrAboveFloor(parts: readonly number[]): boolean {
  const floor = floorConfig.supportFloor.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] > floor[index]) return true;
    if (parts[index] < floor[index]) return false;
  }
  return true;
}

function compareVersions(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

/**
 * SemVer-style precedence for one tag: major/minor/patch, then stable over
 * any release candidate at the same version, then the numeric RC ordinal
 * (so rc.10 outranks rc.9). `rcOrdinal` is 0 for stable tags.
 */
type TagPrecedence = {
  readonly version: readonly number[];
  readonly stable: boolean;
  readonly rcOrdinal: number;
};

function comparePrecedence(left: TagPrecedence, right: TagPrecedence): number {
  const byVersion = compareVersions(left.version, right.version);
  if (byVersion !== 0) return byVersion;
  if (left.stable !== right.stable) return left.stable ? 1 : -1;
  return left.rcOrdinal - right.rcOrdinal;
}

type Candidate = {
  readonly sha: string;
  readonly tags: string[];
  readonly precedence: TagPrecedence;
};

const lsRemote = spawnSync("git", ["ls-remote", "--tags", remote], {
  encoding: "utf8",
  timeout: 30_000,
  maxBuffer: 16 * 1024 * 1024,
});
if (lsRemote.error !== undefined) {
  console.error(`Failed to spawn 'git ls-remote': ${lsRemote.error.message}`);
  process.exit(1);
}
if (lsRemote.status !== 0) {
  console.error(lsRemote.stderr);
  process.exit(lsRemote.status ?? 1);
}

const tagsBySha = new Map<string, string[]>();
const precedenceBySha = new Map<string, TagPrecedence>();
for (const line of lsRemote.stdout.split("\n")) {
  const [sha, ref] = line.split("\t");
  if (sha === undefined || ref === undefined) continue;
  const stableMatch = STABLE_TAG_PATTERN.exec(ref);
  const rcMatch =
    stableMatch !== null || !floorConfig.includeReleaseCandidates
      ? null
      : RC_TAG_PATTERN.exec(ref);
  const match = stableMatch ?? rcMatch;
  if (match === null) continue;
  const precedence: TagPrecedence = {
    version: [Number(match[2]), Number(match[3]), Number(match[4])],
    stable: stableMatch !== null,
    rcOrdinal: rcMatch === null ? 0 : Number(rcMatch[5]),
  };
  if (!versionAtOrAboveFloor(precedence.version)) continue;
  const tag = ref.replace("refs/tags/", "");
  const existing = tagsBySha.get(sha);
  if (existing === undefined) {
    tagsBySha.set(sha, [tag]);
    precedenceBySha.set(sha, precedence);
  } else {
    existing.push(tag);
    const current = precedenceBySha.get(sha);
    if (current !== undefined && comparePrecedence(precedence, current) > 0) {
      precedenceBySha.set(sha, precedence);
    }
  }
}

const candidates: Candidate[] = [...tagsBySha.entries()].map(([sha, tags]) => ({
  sha,
  tags: tags.sort(),
  precedence: precedenceBySha.get(sha) ?? {
    version: [0, 0, 0],
    stable: false,
    rcOrdinal: 0,
  },
}));

if (candidates.length === 0) {
  console.error(
    `No release tags at or above support floor ${floorConfig.supportFloor} found on '${remote}'.`,
  );
  process.exit(1);
}

candidates.sort((left, right) => {
  const byPrecedence = comparePrecedence(left.precedence, right.precedence);
  if (byPrecedence !== 0) return byPrecedence;
  return left.tags[0].localeCompare(right.tags[0]);
});

const newest = candidates[candidates.length - 1];
const label =
  newest.tags.find((tag) => tag.startsWith("cli-v")) ??
  newest.tags.find((tag) => tag.startsWith("desktop-v")) ??
  newest.tags[0];

console.error(
  `Newest released baseline: ${label} (${newest.sha}) tags=[${newest.tags.join(", ")}]`,
);

const repoRoot = join(import.meta.dirname, "../../..");
const worktreeParent = mkdtempSync(join(tmpdir(), "released-baseline-"));
const worktreePath = join(worktreeParent, `baseline-${label}`);

function run(
  command: string,
  args: readonly string[],
  options: {
    cwd: string | undefined;
    stdio: "inherit" | "pipe";
  },
): string {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  if (result.error !== undefined) {
    throw new Error(`Failed to spawn '${command}': ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr =
      typeof result.stderr === "string" ? result.stderr : String(result.stderr);
    throw new Error(
      `'${command} ${args.join(" ")}' failed (exit ${result.status ?? 1}): ${stderr}`,
    );
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}

function injectIfMissing(source: string, destination: string): void {
  try {
    writeFileSync(destination, readFileSync(source), { flag: "wx" });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : null;
    if (code !== "EEXIST") {
      throw error;
    }
    // The baseline ships its own copy of the dump tooling; keep it.
  }
}

try {
  run("git", ["fetch", "--no-tags", remote, newest.sha], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  run("git", ["worktree", "add", "--detach", worktreePath, newest.sha], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  mkdirSync(join(worktreePath, "protocol/scripts/compat"), { recursive: true });
  mkdirSync(join(worktreePath, "protocol/src/framework"), { recursive: true });

  const dumpScriptSrc = join(import.meta.dirname, "dump-protocol-surface.ts");
  const surfaceBuildSrc = join(
    import.meta.dirname,
    "../../src/framework/surface-build.ts",
  );
  const dumpScriptDest = join(
    worktreePath,
    "protocol/scripts/compat/dump-protocol-surface.ts",
  );
  const surfaceBuildDest = join(
    worktreePath,
    "protocol/src/framework/surface-build.ts",
  );

  // Same injection rule as protocol-compat.yml: only copy when the baseline
  // predates the dump tooling. `wx` makes the existence check and the write a
  // single exclusive-create syscall, so there is no check-to-use window.
  injectIfMissing(dumpScriptSrc, dumpScriptDest);
  injectIfMissing(surfaceBuildSrc, surfaceBuildDest);

  run("bun", ["install"], { cwd: worktreePath, stdio: "inherit" });
  const dump = run(
    "bun",
    ["run", "protocol/scripts/compat/dump-protocol-surface.ts"],
    { cwd: worktreePath, stdio: "pipe" },
  );

  // Re-parse + pretty-print to guarantee valid JSON, stable dump formatting,
  // and a trailing newline. Key order is already stable from buildProtocolSurface.
  const parsed: unknown = JSON.parse(dump);
  const stable = `${JSON.stringify(parsed, null, 2)}\n`;
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, stable);
  console.error(`Wrote ${FIXTURE_PATH} (${stable.length} bytes) from ${label}`);
} finally {
  spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  rmSync(worktreeParent, { recursive: true, force: true });
}
