/**
 * Regression coverage for the "release-packaging-relocatable-plist" ticket:
 * a real `bun run package:dir` run (the documented, RELEASE.md-sanctioned
 * local-packaging entry point: `build:app` + all three prepack checks +
 * `electron-builder --dir --publish never`), production-stamped via the real
 * `set-deploy-target.cjs` exactly the way `.github/workflows/
 * release-desktop.yml` (internal repo) drives a release build against THIS
 * package.json, with no internal script involved. Unlike
 * `inject-host-launch-agent.test.ts` (which drives the exported hook
 * functions directly against a scaffolded fixture), this test proves the
 * hook is actually WIRED into the real package.json `build.afterPack` config
 * and fires during a genuine electron-builder pack.
 *
 * `--dir` (via `package:dir`, no dmg/zip/notarization) plus
 * `CSC_IDENTITY_AUTO_DISCOVERY=false` mean this never needs real Developer ID
 * certs and produces a plain ad-hoc-signed `.app` - "ad-hoc signing is fine
 * and expected locally" per the ticket. Slow (a real electron-builder pack)
 * and darwin-only (shells out to the real `codesign`/`plutil`, mirroring
 * what the hook itself does), so it's gated the same way
 * `install-desktop.test.mjs`'s own real-build suite is in the internal repo.
 *
 * Safety: every path this test touches - the staged fake CLI binary under
 * `resources/cli/darwin-<arch>/` (gitignored - see `.gitignore`) and the
 * packaged output under `release/` (also gitignored) - lives inside this
 * workspace only. It never touches `/Applications`, a real running Traycer
 * host, or calls `launchctl`. `src/config.ts` is stamped to `"production"`
 * for the duration of the pack and unconditionally restored to `"dev"` in a
 * `finally`, exactly mirroring the real release workflow's own
 * stamp/build/restore sequence - never left mutated even if the build
 * throws.
 *
 * Why this lives in `__integration_tests__`, not `__tests__`, and runs via
 * `bun run test:packaging` (see `vitest.config.packaging.ts`) instead of the
 * default `bun run test`: `src/config.ts` is a real file shared by the whole
 * workspace, and several unrelated suites (`config-dev-backend-urls.test.ts`,
 * `sign-in-url.test.ts`, `deep-link.test.ts`, ...) import the real `../config`
 * module and assert on its dev-slot values. Vitest's default `vitest run`
 * runs test files concurrently across a worker pool; with this test in that
 * same pool, its `beforeAll` stamping `src/config.ts` to `"production"`
 * raced with those other files' imports mid-run and produced spurious
 * failures unrelated to anything this ticket changed. Being production
 * -stamped for the ~10s a real pack takes is unavoidable - the whole point
 * is exercising the actual `package.json` build config with no internal
 * script involved - so instead this file (and thus its stamp/restore
 * window) is excluded from the default suite's `include` glob and only
 * ever runs alone, one file at a time, never racing another suite's import
 * of `../config`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const REAL_PACKAGE_JSON = JSON.parse(
  readFileSync(path.join(DESKTOP_ROOT, "package.json"), "utf8"),
) as { build: { productName: string; appId: string } };
const PRODUCT_NAME = REAL_PACKAGE_JSON.build.productName;
const APP_ID = REAL_PACKAGE_JSON.build.appId;

const RELEASE_DIR = path.join(DESKTOP_ROOT, "release");
const SET_DEPLOY_TARGET_SCRIPT = path.join(
  DESKTOP_ROOT,
  "scripts",
  "set-deploy-target.cjs",
);
const CLI_ARCH_DIR = path.join(
  DESKTOP_ROOT,
  "resources",
  "cli",
  `darwin-${process.arch}`,
);
// A developer may have a REAL staged CLI + host archive in the (gitignored)
// arch dir - e.g. from `make dev-desktop` or a local install build. The test
// must not destroy it: the real content is moved aside here and restored in
// `afterAll` (plus a stale-backup recovery in `beforeAll` for a previous run
// that died between the two).
const CLI_ARCH_DIR_BACKUP = `${CLI_ARCH_DIR}.packaging-test-backup`;
const PACKAGING_TEST_VERSION = "0.0.0-electron-builder-packaging-test";

function findPackagedApp(): string | null {
  if (!existsSync(RELEASE_DIR)) return null;
  for (const entry of readdirSync(RELEASE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(RELEASE_DIR, entry.name, `${PRODUCT_NAME}.app`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

describe.skipIf(process.platform !== "darwin")(
  "real electron-builder --mac packaging (release-workflow-equivalent, no internal script involved)",
  () => {
    let packagedAppPath: string | null = null;
    let buildError: unknown = null;

    beforeAll(() => {
      rmSync(RELEASE_DIR, { recursive: true, force: true });
      // Recover from a prior run that crashed between backup and restore:
      // the backup holds the developer's real content, so it wins.
      if (existsSync(CLI_ARCH_DIR_BACKUP)) {
        rmSync(CLI_ARCH_DIR, { recursive: true, force: true });
        renameSync(CLI_ARCH_DIR_BACKUP, CLI_ARCH_DIR);
      }
      if (existsSync(CLI_ARCH_DIR)) {
        renameSync(CLI_ARCH_DIR, CLI_ARCH_DIR_BACKUP);
      }
      mkdirSync(CLI_ARCH_DIR, { recursive: true });
      const cliBinaryPath = path.join(CLI_ARCH_DIR, "traycer");
      writeFileSync(cliBinaryPath, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(cliBinaryPath, 0o755);
      writeFileSync(
        path.join(CLI_ARCH_DIR, "version.json"),
        JSON.stringify({ version: PACKAGING_TEST_VERSION }),
        "utf8",
      );

      // Mirrors release-desktop.yml: stamp production BEFORE build:app (the
      // baked config values get inlined by esbuild/vite at build time), pack,
      // then unconditionally restore - even if the pack itself throws.
      execFileSync(
        "bun",
        [
          SET_DEPLOY_TARGET_SCRIPT,
          "--target=production",
          `--version=${PACKAGING_TEST_VERSION}`,
        ],
        { cwd: DESKTOP_ROOT, stdio: "inherit" },
      );
      try {
        // `package:dir` is the real, documented (RELEASE.md) local-packaging
        // entry point: build:app + all three prepack checks (CLI/icons/tray)
        // + `electron-builder --dir --publish never` - the exact chain a
        // contributor or CI would run, not a hand-picked subset of it.
        execFileSync("bun", ["run", "package:dir"], {
          cwd: DESKTOP_ROOT,
          stdio: "inherit",
          env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
        });
      } catch (error) {
        buildError = error;
      } finally {
        execFileSync("bun", [SET_DEPLOY_TARGET_SCRIPT, "--restore"], {
          cwd: DESKTOP_ROOT,
          stdio: "inherit",
        });
      }

      if (buildError === null) {
        packagedAppPath = findPackagedApp();
      }
    }, 300_000);

    afterAll(() => {
      rmSync(RELEASE_DIR, { recursive: true, force: true });
      rmSync(CLI_ARCH_DIR, { recursive: true, force: true });
      if (existsSync(CLI_ARCH_DIR_BACKUP)) {
        renameSync(CLI_ARCH_DIR_BACKUP, CLI_ARCH_DIR);
      }
    });

    it("packages without error and restores src/config.ts to dev afterwards", () => {
      expect(buildError).toBeNull();
      const configSource = readFileSync(
        path.join(DESKTOP_ROOT, "src", "config.ts"),
        "utf8",
      );
      expect(configSource).toMatch(/environment:\s*"dev"/);
      expect(configSource).not.toMatch(/environment:\s*"production"/);
    });

    it("produces a packaged .app containing the helper .app and a LaunchAgent plist with NumberOfFiles=8192, valid via plutil -lint", () => {
      if (packagedAppPath === null) {
        throw new Error(
          "packagedAppPath was not set - packaging must have failed",
        );
      }
      const appPath = packagedAppPath;
      expect(existsSync(appPath)).toBe(true);

      const helperAppPath = path.join(
        appPath,
        "Contents",
        "Library",
        "LaunchAgents",
        `${PRODUCT_NAME} Host.app`,
      );
      const helperBinary = path.join(
        helperAppPath,
        "Contents",
        "MacOS",
        "traycer",
      );
      expect(existsSync(helperBinary)).toBe(true);
      expect(statSync(helperBinary).mode & 0o111).not.toBe(0);

      const helperInfoPlist = path.join(
        helperAppPath,
        "Contents",
        "Info.plist",
      );
      expect(() =>
        execFileSync("plutil", ["-lint", helperInfoPlist]),
      ).not.toThrow();
      expect(readFileSync(helperInfoPlist, "utf8")).toContain(
        `<string>${APP_ID}.host</string>`,
      );

      const agentPlistPath = path.join(
        appPath,
        "Contents",
        "Library",
        "LaunchAgents",
        "ai.traycer.host.agent.plist",
      );
      expect(existsSync(agentPlistPath)).toBe(true);
      expect(() =>
        execFileSync("plutil", ["-lint", agentPlistPath]),
      ).not.toThrow();

      // The inert old-label plist ships beside the agent one (label-split
      // transition: the desktop unregisters the old serviceName against it).
      const inertOldPlistPath = path.join(
        appPath,
        "Contents",
        "Library",
        "LaunchAgents",
        "ai.traycer.host.plist",
      );
      expect(existsSync(inertOldPlistPath)).toBe(true);
      expect(() =>
        execFileSync("plutil", ["-lint", inertOldPlistPath]),
      ).not.toThrow();

      const agentPlist = readFileSync(agentPlistPath, "utf8");
      expect(agentPlist).toContain(`<key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>8192</integer>
  </dict>`);
      expect(agentPlist).not.toContain("HardResourceLimits");
      expect(agentPlist).not.toContain("<key>HOME</key>");
      // Regression guard for Finding 1 (release-workflow bypass): the real
      // packaged output - not just a stationary scaffold - must carry the
      // fix.
      expect(agentPlist).not.toContain(RELEASE_DIR);
    });

    it("relocates cleanly - after cp -R to a different path, BundleProgram (parsed, not grepped) still resolves to a real executable file", () => {
      if (packagedAppPath === null) {
        throw new Error(
          "packagedAppPath was not set - packaging must have failed",
        );
      }
      const appPath = packagedAppPath;
      const agentPlistPath = path.join(
        appPath,
        "Contents",
        "Library",
        "LaunchAgents",
        "ai.traycer.host.agent.plist",
      );
      const agentPlist = readFileSync(agentPlistPath, "utf8");
      const bundleProgramMatch = agentPlist.match(
        /<key>BundleProgram<\/key>\s*<string>([^<]+)<\/string>/,
      );
      if (bundleProgramMatch === null) {
        throw new Error("BundleProgram not found in the generated plist");
      }
      const relativeHelperPath = bundleProgramMatch[1];
      expect(relativeHelperPath.startsWith("/")).toBe(false);

      const relocatedRoot = path.join(
        DESKTOP_ROOT,
        ".tmp-electron-builder-packaging-relocated",
      );
      rmSync(relocatedRoot, { recursive: true, force: true });
      try {
        mkdirSync(relocatedRoot, { recursive: true });
        const relocatedAppPath = path.join(
          relocatedRoot,
          `${PRODUCT_NAME}.app`,
        );
        execFileSync("cp", ["-R", appPath, relocatedAppPath]);
        const resolvedHelperPath = path.join(
          relocatedAppPath,
          relativeHelperPath,
        );
        expect(existsSync(resolvedHelperPath)).toBe(true);
        expect(statSync(resolvedHelperPath).mode & 0o111).not.toBe(0);
      } finally {
        rmSync(relocatedRoot, { recursive: true, force: true });
      }
    });
  },
);
