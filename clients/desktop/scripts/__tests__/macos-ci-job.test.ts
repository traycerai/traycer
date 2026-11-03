// @vitest-environment node
//
// Pins what keeps the macOS job in `.github/workflows/test.yml` honest now that
// it runs the pack and a named list of test files instead of this whole suite,
// and skips any push its filter says cannot change them. A darwin-gated block
// in a file the list does not name runs nowhere: every other job skips it and
// reports a pass. A named file that imports past the filter loses its macOS run
// on exactly the change that could break it.
//
// It lives in this project, not in the repo-root `scripts` one, because Nx
// replays a project's test result until that project's inputs change: a new
// test here must re-run it. `package.json` adds the workflow to those inputs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { describe, expect, it } from "vitest";

const DESKTOP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPO_ROOT = path.resolve(DESKTOP_ROOT, "..", "..");
const SHARED_ROOT = path.join(REPO_ROOT, "clients", "shared");
const PROTOCOL_ROOT = path.join(REPO_ROOT, "protocol");

const workflow = readFileSync(
  path.join(REPO_ROOT, ".github", "workflows", "test.yml"),
  "utf8",
);

function firstGroup(pattern: RegExp): string {
  const match = pattern.exec(workflow);
  if (match === null) {
    throw new Error(`test.yml no longer matches ${String(pattern)}`);
  }
  return match[1];
}

const desktopFiles = firstGroup(
  /name: Desktop darwin-only test files\n[\s\S]*?bunx vitest run\n([\s\S]*?)\n\s*(?:#|- )/,
)
  .trim()
  .split(/\s+/);

const sharedFile = path.join(
  SHARED_ROOT,
  firstGroup(
    /working-directory: clients\/shared\n\s*run: bunx vitest run (\S+)/,
  ),
);

// Runs the filter's real awk program over paths and answers the ones it keeps.
function filterKeeps(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const { status, stdout } = spawnSync(
    "awk",
    [firstGroup(/\| awk '([\s\S]*?)'/)],
    { input: `${paths.join("\n")}\n`, encoding: "utf8" },
  );
  expect(status).toBe(0);
  return stdout.split("\n").filter((line) => line !== "");
}

// What a checkout does not track, and what the pack itself writes.
const NOT_SOURCE = new Set(["node_modules", "dist", "release"]);

function testFilesUnder(directory: string): ReadonlyArray<string> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return NOT_SOURCE.has(entry.name) ? [] : testFilesUnder(entryPath);
    }
    return /\.test\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

// The workspace's protocol alias, the way `vitest.config.ts` maps it.
const protocolAlias: Plugin = {
  name: "protocol-alias",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@traycer\/protocol\// }, (args) => {
      const subpath = args.path.slice("@traycer/protocol/".length);
      return pluginBuild.resolve(
        `./${subpath.startsWith("utils/") ? subpath : `src/${subpath}`}`,
        { resolveDir: PROTOCOL_ROOT, kind: args.kind },
      );
    });
  },
};

// Every repository file the entry points import, as a repo-relative path.
async function importClosure(
  entryPoints: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  const { metafile } = await build({
    entryPoints: [...entryPoints],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    packages: "external",
    logLevel: "silent",
    absWorkingDir: REPO_ROOT,
    outdir: "unused",
    alias: {
      "@traycer-clients/shared": SHARED_ROOT,
      "@traycer-clients/desktop": path.join(DESKTOP_ROOT, "src"),
    },
    plugins: [protocolAlias],
  });
  return Object.keys(metafile.inputs);
}

describe("the macOS job's named test files", () => {
  it("names only files that exist", () => {
    const named = desktopFiles.map((file) => path.join(DESKTOP_ROOT, file));
    expect(named.filter((file) => !existsSync(file))).toEqual([]);
    expect(existsSync(sharedFile)).toBe(true);
  });

  it("names every test file with a darwin-gated block, because no other job runs one", () => {
    const gated = testFilesUnder(DESKTOP_ROOT)
      .filter((file) => !file.includes("__integration_tests__"))
      .filter((file) =>
        /\.(?:skipIf|runIf)\(\s*process\.platform\s*[!=]==\s*"darwin"\s*\)/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => path.relative(DESKTOP_ROOT, file));
    expect(gated).toContain(
      "scripts/prepack/__tests__/inject-host-launch-agent.test.ts",
    );
    expect(gated.filter((file) => !desktopFiles.includes(file))).toEqual([]);
  });
});

describe("the macOS job's filter", () => {
  it("keeps everything the named test files import from outside this workspace", async () => {
    // The exec-sync test runs its production code through these workers in a
    // real subprocess, so its import graph starts at them.
    const sharedWorkers = [
      "exec-sync-stderr-worker.ts",
      "exec-sync-stderr-raw-control-worker.ts",
    ].map((worker) => path.join(SHARED_ROOT, "__tests__", "fixtures", worker));
    const closure = await importClosure([
      ...desktopFiles.map((file) => path.join(DESKTOP_ROOT, file)),
      sharedFile,
      ...sharedWorkers,
    ]);
    const outside = closure.filter(
      (file) =>
        !file.startsWith("node_modules/") &&
        !file.startsWith("clients/desktop/"),
    );
    expect(outside).toContain("clients/shared/host-lock/process-identity.ts");
    expect(outside).toContain("protocol/src/config/credentials-lock.ts");
    expect([...filterKeeps(outside)].sort()).toEqual([...outside].sort());
  });

  it("keeps what the pack reads and the pins it reads them through", () => {
    const paths = [
      "clients/desktop/README.md",
      "clients/desktop/package.json",
      "clients/desktop/scripts/prepack/inject-host-launch-agent.cjs",
      "clients/scripts/release-target-stamp.cjs",
      "patches/app-builder-lib@26.15.3.patch",
      "package.json",
      "bun.lock",
      ".github/workflows/test.yml",
    ];
    expect(filterKeeps(paths)).toEqual(paths);
  });

  it("skips what only feeds a bundle the Linux build lane builds", () => {
    expect(
      filterKeeps([
        "clients/gui-app/src/app.tsx",
        "clients/mobile/package.json",
        "clients/traycer-cli/src/index.ts",
        "protocol/src/host/rpc/registry.ts",
        "protocol/src/config/__tests__/adversarial-store-fuzz.test.ts",
        "patches/@tiptap%2Fcore@3.30.1.patch",
        "nx.json",
        "AGENTS.md",
      ]),
    ).toEqual([]);
  });
});
