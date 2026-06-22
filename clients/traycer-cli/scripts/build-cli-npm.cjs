"use strict";

// npm-publishable JS build for the Traycer CLI.
//
// Unlike `build-cli-sea.cjs` (which wraps the bundle in a Node SEA so it
// runs with no user-installed runtime), this target ships the CLI as a
// single self-contained JS file that runs on the *user's* Node via the
// `bin` entry. It is what backs the public `@traycerai/cli` npm package.
//
// Why bundle instead of `tsc` → dist: the CLI imports
//   - `@traycer-clients/shared/*` — a PRIVATE, unpublished workspace
//     package (cannot be an npm dependency), and
//   - `@traycer/protocol/*` — published as *extensionless, bundler-only*
//     ESM, so a raw `node` import of its subpaths fails
//     ERR_MODULE_NOT_FOUND (see protocol/README.md).
// A plain `tsc` emit would leave both as bare imports that break at
// `npx`/global-install runtime. esbuild inlines them (resolving the
// workspace path aliases from the CLI tsconfig, exactly like the SEA
// build) so the published bundle has ZERO runtime dependencies.
//
// Output (gitignored):
//   dist-npm/traycer        single bundled, extensionless CJS file
//                           + `#!/usr/bin/env node` (the basename MUST be
//                           `traycer` - see BUNDLE_BASENAME below)
//   dist-npm/package.json   GENERATED publish manifest (name: @traycerai/cli)
//
// The published name (`@traycerai/cli`) is decoupled from the workspace
// name (`@traycer-clients/traycer-cli`, a build label imported nowhere)
// so the monorepo-wide `bun run --filter` references stay untouched. The
// publish workflow runs `npm publish` from `dist-npm/`.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const workspaceRoot = path.resolve(__dirname, "..");
const distDir = path.join(workspaceRoot, "dist-npm");
const cliEntry = path.join(workspaceRoot, "src", "index.ts");
const cliTsconfig = path.join(workspaceRoot, "tsconfig.json");
// The bundle MUST be named `traycer` (no extension). The CLI entry's
// script-mode guard `isTraycerCliEntrypoint(process.argv[1])` only runs
// `parseAsync` when argv[1] basename is `index.ts`, `traycer`, or
// `traycer.exe` (see src/index.ts) - the same name the SEA binary uses.
// A `.cjs`/`.js` name silently fails that guard (no output, exit 0).
// Node runs the extensionless, `"use strict"` CJS bundle as CommonJS.
const BUNDLE_BASENAME = "traycer";
const outputBundle = path.join(distDir, BUNDLE_BASENAME);

// Published npm identity. Decoupled from the workspace package name on
// purpose — see the file header.
const PUBLISH_NAME = "@traycerai/cli";
// Broad runtime floor: the bundle only touches stable `node:` builtins
// (fs/net/http/child_process/crypto/os/path/url/util/events), so it runs
// on every active Node LTS. esbuild downlevels syntax to this target.
const NODE_TARGET = "node20";
const ENGINES_NODE = ">=20.18.0";

function resolveEsbuildBin() {
  return require.resolve("esbuild/bin/esbuild", { paths: [REPO_ROOT] });
}

function readWorkspaceManifest() {
  const raw = fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8");
  return JSON.parse(raw);
}

function main() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  const workspaceManifest = readWorkspaceManifest();

  // Version precedence: the release workflow injects TRAYCER_CLI_VERSION
  // (from the `cli-v<version>` tag); local builds fall back to the
  // workspace manifest version, then the shared `0.0.0-local` sentinel
  // (kept identical to LOCAL_CLI_VERSION in src/index.ts).
  const cliVersion =
    typeof process.env.TRAYCER_CLI_VERSION === "string" &&
    process.env.TRAYCER_CLI_VERSION.length > 0
      ? process.env.TRAYCER_CLI_VERSION
      : typeof workspaceManifest.version === "string" &&
          workspaceManifest.version.length > 0
        ? workspaceManifest.version
        : "0.0.0-local";

  // Bundle everything (no externals) so the published artifact resolves
  // nothing at the user's runtime. Node builtins are auto-externalised by
  // `--platform=node`.
  const args = [
    cliEntry,
    "--bundle",
    "--platform=node",
    `--target=${NODE_TARGET}`,
    "--format=cjs",
    `--outfile=${outputBundle}`,
    `--tsconfig=${cliTsconfig}`,
    // esbuild `--define` value must be a JS expression; a single
    // JSON.stringify yields the quoted string literal "1.5.0" (matches
    // build-cli-sea.cjs). Double-encoding would inject the quotes into
    // the value and break version resolution.
    `--define:process.env.TRAYCER_CLI_VERSION=${JSON.stringify(cliVersion)}`,
  ];
  execFileSync(resolveEsbuildBin(), args, {
    cwd: workspaceRoot,
    stdio: "inherit",
  });

  // The CLI entry (src/index.ts) carries its own `#!/usr/bin/env -S bun`
  // hashbang, which esbuild preserves verbatim on line 1. The npm bin
  // must launch on the user's *Node*, so strip whatever hashbang the
  // bundle starts with and pin the Node one. (A `--banner:js` shebang
  // would land on line 2, after the preserved bun hashbang, producing a
  // double-hashbang that fails to parse.)
  //
  // Version shim: the CLI resolves `traycer --version` from
  // process.env.TRAYCER_CLI_VERSION at RUNTIME - src reads it via
  // `readonlyEnv()` (which returns process.env), so the esbuild
  // build-time `--define` above cannot bake it through that indirection
  // (verified: esbuild substitutes only direct `process.env.X` accesses,
  // not aliased reads). Set the env var to the built version before any CLI
  // logic runs so ambient shell state cannot make the published bin report a
  // local/dev version.
  let code = fs.readFileSync(outputBundle, "utf8");
  code = code.replace(/^#![^\n]*\n/, "");
  const versionShim = `process.env.TRAYCER_CLI_VERSION=${JSON.stringify(cliVersion)};`;
  const distributionShim = `process.env.TRAYCER_CLI_DISTRIBUTION="npm";`;
  code = `#!/usr/bin/env node\n"use strict";${versionShim}${distributionShim}\n${code}`;
  fs.writeFileSync(outputBundle, code);

  // Mark the bundle executable so the published `bin` works on
  // POSIX hosts without an extra chmod by the consumer.
  fs.chmodSync(outputBundle, 0o755);

  // Derive the command name from the workspace `bin` map (single
  // "traycer" entry) so the published command stays in lockstep.
  const binCommand =
    Object.keys(workspaceManifest.bin || { traycer: "" })[0] || "traycer";

  const publishManifest = {
    name: PUBLISH_NAME,
    version: cliVersion,
    description:
      workspaceManifest.description ||
      "Traycer CLI - host supervisor, auth, and config surface",
    // No "type": the single extensionless `traycer` bundle is CommonJS (it
    // opens with `"use strict";`); omitting the field keeps the manifest
    // unambiguous regardless of host defaults.
    bin: { [binCommand]: BUNDLE_BASENAME },
    files: [BUNDLE_BASENAME],
    engines: workspaceManifest.engines || { node: ENGINES_NODE },
    repository: workspaceManifest.repository || {
      type: "git",
      url: "git+https://github.com/traycerai/traycer.git",
      directory: "clients/traycer-cli",
    },
    license: workspaceManifest.license || "Proprietary",
    // Fully bundled — the published package pulls nothing from the
    // registry at install time.
    dependencies: {},
    publishConfig: { access: "public", provenance: true },
  };
  fs.writeFileSync(
    path.join(distDir, "package.json"),
    `${JSON.stringify(publishManifest, null, 2)}\n`,
    "utf8",
  );

  // Ship a README next to the manifest if one exists so the npm package
  // page is not blank.
  const readme = path.join(workspaceRoot, "README.md");
  if (fs.existsSync(readme)) {
    fs.copyFileSync(readme, path.join(distDir, "README.md"));
    publishManifest.files.push("README.md");
    fs.writeFileSync(
      path.join(distDir, "package.json"),
      `${JSON.stringify(publishManifest, null, 2)}\n`,
      "utf8",
    );
  }

  const bundleSize = fs.statSync(outputBundle).size;
  process.stdout.write(
    `[build-cli-npm] ${PUBLISH_NAME}@${cliVersion} -> ${path.relative(REPO_ROOT, outputBundle)} (${bundleSize} bytes)\n`,
  );
}

main();
