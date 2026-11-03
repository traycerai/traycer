// The build lane pays for a task only when that task's own inputs changed.
// Protocol's test target reads every client source file, and the legacy
// affected mode then builds every target of a touched project, so a gui-app
// change used to compile protocol before desktop. Desktop compiles protocol
// from source, and gui-app has no build script, so neither task belongs on
// that run. Protocol's build still runs when a protocol input changes.

import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..");
const require = createRequire(import.meta.url);

const nxSrc = join(REPO_ROOT, "node_modules/nx/dist/src");
const { createProjectGraphAsync } = require(
  join(nxSrc, "project-graph/project-graph.js"),
);
const { readNxJson } = require(join(nxSrc, "config/nx-json.js"));
const { calculateFileChanges } = require(
  join(nxSrc, "project-graph/file-utils.js"),
);
const { computeAffectedTasks } = require(
  join(nxSrc, "project-graph/affected/affected-tasks.js"),
);

process.env.NX_DAEMON = "false";
process.env.NX_LEGACY_AFFECTED = "false";

const graphPromise = createProjectGraphAsync({ exitOnError: true });

async function scheduledBuilds(files) {
  const graph = await graphPromise;
  const touchedFiles = calculateFileChanges(files, { files });
  const result = await computeAffectedTasks({
    projectGraph: graph,
    nxJson: readNxJson(),
    targets: ["build"],
    touchedFiles,
    fileChangeArgs: { files },
    explain: false,
    ultracacheConfigurationOutcome: null,
    selectivelyHashTsConfig: false,
  });
  return result.taskSelection.taskIds;
}

describe("pre-commit build lane", () => {
  it("runs task-based affected only on the build lane", () => {
    const workflow = parse(
      readFileSync(join(REPO_ROOT, ".github/workflows/pre-commit.yml"), "utf8"),
    );
    const step = workflow.jobs["workspace-checks"].steps.find(
      (candidate) => candidate.name === "Run ${{ matrix.lane }} checks",
    );
    expect(step.env.NX_LEGACY_AFFECTED).toBe(
      "${{ matrix.lane == 'build' && 'false' || 'true' }}",
    );
  });

  it("a gui-app source change builds desktop and nothing else", async () => {
    const tasks = await scheduledBuilds([
      "clients/gui-app/src/components/auth/user-menu.tsx",
    ]);
    expect(tasks).toEqual(["@traycer-clients/desktop:build"]);
  }, 60_000);

  it("a desktop source change still builds desktop", async () => {
    const tasks = await scheduledBuilds([
      "clients/desktop/src/electron-main/main-process.ts",
    ]);
    expect(tasks).toEqual(["@traycer-clients/desktop:build"]);
  }, 60_000);

  it("a protocol input change still builds protocol", async () => {
    const tasks = await scheduledBuilds(["protocol/package.json"]);
    expect(tasks).toContain("@traycer/protocol:build");
  }, 60_000);

  it("a script change builds nothing", async () => {
    const tasks = await scheduledBuilds(["scripts/ci-last-green-sha.sh"]);
    expect(tasks).toEqual([]);
  }, 60_000);
});
