/**
 * Resolves the set of released baselines the protocol must stay compatible
 * with: every stable `host-v*` / `cli-v*` / `desktop-v*` tag on the remote at
 * or above the support floor, deduplicated by commit (host and clients often
 * release from the same commit). Prints JSON:
 *
 *   { "baselines": [ { "sha": "...", "tags": ["host-v1.1.4", "cli-v1.1.4"] } ] }
 *
 * The tag list comes from `git ls-remote` at run time - never from a file in
 * the tree - so a PR cannot shrink the protected set. The only in-tree knob is
 * `support-floor.json` (CODEOWNERS-gated, tripwired).
 *
 *   bun run protocol/scripts/compat/resolve-baselines.ts [<remote-or-url>]
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const supportFloorSchema = z.object({
  supportFloor: z.string().regex(/^\d+\.\d+\.\d+$/),
  includeReleaseCandidates: z.boolean(),
});

const floorConfig = supportFloorSchema.parse(
  JSON.parse(
    readFileSync(join(import.meta.dirname, "support-floor.json"), "utf8"),
  ),
);

const remote = process.argv[2] ?? "origin";
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

const stableTagPattern = /^refs\/tags\/(host|cli|desktop)-v(\d+)\.(\d+)\.(\d+)$/;
const rcTagPattern =
  /^refs\/tags\/(host|cli|desktop)-v(\d+)\.(\d+)\.(\d+)-rc\.\d+$/;

function versionAtOrAboveFloor(parts: readonly number[]): boolean {
  const floor = floorConfig.supportFloor.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] > floor[index]) return true;
    if (parts[index] < floor[index]) return false;
  }
  return true;
}

const tagsBySha = new Map<string, string[]>();
for (const line of lsRemote.stdout.split("\n")) {
  const [sha, ref] = line.split("\t");
  if (sha === undefined || ref === undefined) continue;
  const match =
    stableTagPattern.exec(ref) ??
    (floorConfig.includeReleaseCandidates ? rcTagPattern.exec(ref) : null);
  if (match === null) continue;
  const parts = [Number(match[2]), Number(match[3]), Number(match[4])];
  if (!versionAtOrAboveFloor(parts)) continue;
  const tag = ref.replace("refs/tags/", "");
  const existing = tagsBySha.get(sha);
  if (existing === undefined) {
    tagsBySha.set(sha, [tag]);
  } else {
    existing.push(tag);
  }
}

const baselines = [...tagsBySha.entries()]
  .map(([sha, tags]) => ({ sha, tags: tags.sort() }))
  .sort((a, b) => a.tags[0].localeCompare(b.tags[0]));

if (baselines.length === 0) {
  console.error(
    `No release tags at or above support floor ${floorConfig.supportFloor} found on '${remote}'.`,
  );
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({ baselines }, null, 2)}\n`);
