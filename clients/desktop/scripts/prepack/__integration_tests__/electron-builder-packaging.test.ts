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
// The OTHER macOS arch. The release job stages `darwin-arm64` and
// `darwin-x64` side by side before one `electron-builder --mac` packs both
// apps, and an arch-blind `resources/cli` -> `cli` mapping shipped the x86_64
// SEA inside the arm64 bundle (traycerai/traycer#1528). Staging a decoy here
// reproduces that release-job layout so the pack below proves the `${arch}`
// scoped mapping keeps the foreign arch out.
const FOREIGN_ARCH = process.arch === "arm64" ? "x64" : "arm64";
const CLI_FOREIGN_ARCH_DIR = path.join(
  DESKTOP_ROOT,
  "resources",
  "cli",
  `darwin-${FOREIGN_ARCH}`,
);
const CLI_FOREIGN_ARCH_DIR_BACKUP = `${CLI_FOREIGN_ARCH_DIR}.packaging-test-backup`;
const PACKAGING_TEST_VERSION = "0.0.0-electron-builder-packaging-test";
const FOREIGN_ARCH_DECOY_MARKER = "decoy-foreign-arch-cli-must-not-ship";

function stageFakeCli(
  archDir: string,
  binaryBody: string,
  version: string,
): void {
  mkdirSync(archDir, { recursive: true });
  const cliBinaryPath = path.join(archDir, "traycer");
  writeFileSync(cliBinaryPath, binaryBody, "utf8");
  chmodSync(cliBinaryPath, 0o755);
  writeFileSync(
    path.join(archDir, "version.json"),
    JSON.stringify({ version }),
    "utf8",
  );
}

function packagedCliDir(appPath: string): string {
  return path.join(appPath, "Contents", "Resources", "cli");
}

function findPackagedApps(): ReadonlyArray<string> {
  if (!existsSync(RELEASE_DIR)) return [];
  const apps: string[] = [];
  for (const entry of readdirSync(RELEASE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(RELEASE_DIR, entry.name, `${PRODUCT_NAME}.app`);
    if (existsSync(candidate)) apps.push(candidate);
  }
  return apps;
}

function findPackagedApp(): string | null {
  return findPackagedApps()[0] ?? null;
}

// The two arches `build.mac.target` ships. Both are packed by ONE
// `electron-builder --mac` in the release job.
const MAC_PACK_ARCHES = ["arm64", "x64"] as const;
type MacPackArch = (typeof MAC_PACK_ARCHES)[number];

function cliArchDir(arch: MacPackArch): string {
  return path.join(DESKTOP_ROOT, "resources", "cli", `darwin-${arch}`);
}

function twoArchMarker(arch: MacPackArch): string {
  return `two-arch-pack-marker-${arch}`;
}

function twoArchVersion(arch: MacPackArch): string {
  return `${PACKAGING_TEST_VERSION}-two-arch-${arch}`;
}

/**
 * The arch of the app's OWN Mach-O, read with `lipo`. The two-arch assertions
 * key each app's expected CLI off this rather than off the output directory
 * name: electron-builder names the per-arch dirs `mac-arm64` and (for the
 * default arch) a bare `mac`, which is an implementation detail that would
 * make the test read as passing for the wrong reason if it ever changed.
 * Matching binary-arch to CLI-arch is the property actually under test.
 */
function appArchOf(appPath: string): MacPackArch {
  const raw = execFileSync(
    "lipo",
    ["-archs", path.join(appPath, "Contents", "MacOS", PRODUCT_NAME)],
    { encoding: "utf8" },
  ).trim();
  if (raw === "arm64") return "arm64";
  if (raw === "x86_64") return "x64";
  throw new Error(`unexpected app arch '${raw}' for ${appPath}`);
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
      if (existsSync(CLI_FOREIGN_ARCH_DIR_BACKUP)) {
        rmSync(CLI_FOREIGN_ARCH_DIR, { recursive: true, force: true });
        renameSync(CLI_FOREIGN_ARCH_DIR_BACKUP, CLI_FOREIGN_ARCH_DIR);
      }
      if (existsSync(CLI_ARCH_DIR)) {
        renameSync(CLI_ARCH_DIR, CLI_ARCH_DIR_BACKUP);
      }
      if (existsSync(CLI_FOREIGN_ARCH_DIR)) {
        renameSync(CLI_FOREIGN_ARCH_DIR, CLI_FOREIGN_ARCH_DIR_BACKUP);
      }
      stageFakeCli(CLI_ARCH_DIR, "#!/bin/sh\nexit 0\n", PACKAGING_TEST_VERSION);
      // Distinct bytes so the assertion below can tell "the foreign dir is
      // absent" apart from "the target dir was copied under both names".
      stageFakeCli(
        CLI_FOREIGN_ARCH_DIR,
        `#!/bin/sh\n# ${FOREIGN_ARCH_DECOY_MARKER}\nexit 1\n`,
        `${PACKAGING_TEST_VERSION}-${FOREIGN_ARCH}`,
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
      rmSync(CLI_FOREIGN_ARCH_DIR, { recursive: true, force: true });
      if (existsSync(CLI_FOREIGN_ARCH_DIR_BACKUP)) {
        renameSync(CLI_FOREIGN_ARCH_DIR_BACKUP, CLI_FOREIGN_ARCH_DIR);
      }
    });

    it(`ships only the ${process.arch} CLI under Resources/cli - the staged darwin-${FOREIGN_ARCH} sibling never enters the bundle (traycerai/traycer#1528)`, () => {
      if (packagedAppPath === null) {
        throw new Error(
          "packagedAppPath was not set - packaging must have failed",
        );
      }
      const cliDir = packagedCliDir(packagedAppPath);
      expect(existsSync(cliDir)).toBe(true);
      // Exactly one arch dir, and it is the one electron-builder packed. Any
      // other entry (the foreign arch, a stray README, a flat binary) is a
      // regression back to the arch-blind mapping.
      expect(readdirSync(cliDir).sort()).toEqual([`darwin-${process.arch}`]);

      const targetDir = path.join(cliDir, `darwin-${process.arch}`);
      const shippedBinary = path.join(targetDir, "traycer");
      expect(existsSync(shippedBinary)).toBe(true);
      expect(statSync(shippedBinary).mode & 0o111).not.toBe(0);
      expect(readFileSync(shippedBinary, "utf8")).not.toContain(
        FOREIGN_ARCH_DECOY_MARKER,
      );
      expect(
        JSON.parse(readFileSync(path.join(targetDir, "version.json"), "utf8")),
      ).toEqual({ version: PACKAGING_TEST_VERSION });

      expect(existsSync(path.join(cliDir, `darwin-${FOREIGN_ARCH}`))).toBe(
        false,
      );
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

/**
 * The release topology, which the block above does NOT cover: the macOS job
 * stages `darwin-arm64` AND `darwin-x64`, then ONE `electron-builder --mac`
 * packs both apps (`build.mac.target` lists both arches). `package:dir` above
 * packs a single arch, so it can only prove the mapping picks the right dir -
 * not that two packs inside one invocation resolve `${arch}` independently.
 * That distinction is the whole fix for traycerai/traycer#1528: the arch-blind
 * mapping it replaced put BOTH staged CLIs into BOTH apps, and the arm64 DMG
 * shipping an x86_64 Mach-O is what made macOS 26 flag the app as Intel.
 *
 * Deliberately NOT production-stamped, unlike the block above: nothing here
 * asserts on the LaunchAgent/helper that `afterPack` injects (that hook
 * early-returns when unstamped), so this avoids a second window in which
 * `src/config.ts` is mutated. It invokes electron-builder directly rather
 * than through `package:dir`, because no package script packs two arches.
 */
describe.skipIf(process.platform !== "darwin")(
  "real electron-builder --mac packaging, BOTH arches in one invocation (release topology)",
  () => {
    let buildError: unknown = null;

    beforeAll(() => {
      rmSync(RELEASE_DIR, { recursive: true, force: true });
      for (const arch of MAC_PACK_ARCHES) {
        const dir = cliArchDir(arch);
        const backup = `${dir}.packaging-test-backup`;
        // Same stale-backup recovery as the block above: a backup left by a
        // crashed run holds the developer's real staged CLI, so it wins.
        if (existsSync(backup)) {
          rmSync(dir, { recursive: true, force: true });
          renameSync(backup, dir);
        }
        if (existsSync(dir)) renameSync(dir, backup);
        // Per-arch marker bytes: without them "the x64 app has a darwin-x64
        // dir" would also be satisfied by the arm64 CLI copied under the x64
        // name, which is precisely the bug class being gated.
        stageFakeCli(
          dir,
          `#!/bin/sh\n# ${twoArchMarker(arch)}\nexit 0\n`,
          twoArchVersion(arch),
        );
      }

      try {
        execFileSync("bun", ["run", "build:app"], {
          cwd: DESKTOP_ROOT,
          stdio: "inherit",
        });
        // electron-builder cannot resolve Bun's `catalog:` protocol from the
        // package.json devDependency, and electron is hoisted, so its
        // project-level lookup misses too - pin the installed version
        // explicitly, exactly as `release-desktop.yml` does.
        const electronVersion = execFileSync(
          "node",
          ["-p", "require('electron/package.json').version"],
          { cwd: DESKTOP_ROOT, encoding: "utf8" },
        ).trim();
        execFileSync(
          "bun",
          [
            "x",
            "electron-builder",
            "--mac",
            "--dir",
            "--arm64",
            "--x64",
            "--publish",
            "never",
            `-c.electronVersion=${electronVersion}`,
          ],
          {
            cwd: DESKTOP_ROOT,
            stdio: "inherit",
            env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
          },
        );
      } catch (error) {
        buildError = error;
      }
    }, 900_000);

    afterAll(() => {
      rmSync(RELEASE_DIR, { recursive: true, force: true });
      for (const arch of MAC_PACK_ARCHES) {
        const dir = cliArchDir(arch);
        const backup = `${dir}.packaging-test-backup`;
        rmSync(dir, { recursive: true, force: true });
        if (existsSync(backup)) renameSync(backup, dir);
      }
    });

    it("packs one app per arch", () => {
      expect(buildError).toBeNull();
      const apps = findPackagedApps();
      // Guards the assertion below against passing vacuously: a single-arch
      // (or zero-app) output would otherwise satisfy an empty loop.
      expect(apps).toHaveLength(MAC_PACK_ARCHES.length);
      expect(apps.map(appArchOf).sort()).toEqual([...MAC_PACK_ARCHES].sort());
    });

    it("gives each app only the CLI matching its own Mach-O arch", () => {
      expect(buildError).toBeNull();
      const apps = findPackagedApps();
      expect(apps.length).toBeGreaterThan(0);

      for (const app of apps) {
        const arch = appArchOf(app);
        const cliDir = packagedCliDir(app);
        // Exactly one arch dir, and it is this app's own.
        expect(readdirSync(cliDir).sort()).toEqual([`darwin-${arch}`]);

        const archDir = path.join(cliDir, `darwin-${arch}`);
        const binary = readFileSync(path.join(archDir, "traycer"), "utf8");
        expect(binary).toContain(twoArchMarker(arch));
        for (const other of MAC_PACK_ARCHES) {
          if (other === arch) continue;
          expect(binary).not.toContain(twoArchMarker(other));
        }
        expect(
          JSON.parse(readFileSync(path.join(archDir, "version.json"), "utf8")),
        ).toEqual({ version: twoArchVersion(arch) });
      }
    });
  },
);
