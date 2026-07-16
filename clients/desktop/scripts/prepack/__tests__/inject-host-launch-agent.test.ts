/**
 * Unit-level coverage for `inject-host-launch-agent.cjs`'s exported
 * `afterPack` electron-builder hook (see the module doc comment for the full
 * design rationale - relocatable `BundleProgram`, ad-hoc baseline signing
 * superseded by electron-builder's own recursive signing pass).
 *
 * These tests drive the REAL committed `.cjs` file, not a
 * reimplementation of its logic. Since the module resolves `../../package.json`
 * and `../../src/config.ts` relative to its own `__dirname`, and reads
 * `config.ts`'s stamped `environment` via `fs.readFileSync` (not `require`),
 * there is no seam to inject a fake config without either mutating the real
 * tracked `src/config.ts` or relocating the module. Each test copies the
 * current, unmodified module source (`cpSync`, byte-for-byte, so it can never
 * drift from what's committed) plus the real `package.json` into an isolated
 * temp directory nested under this workspace root (so the module's bare
 * `require("electron-builder")` still resolves via the real `node_modules`
 * walk-up) alongside a synthetic `src/config.ts` stub, then `require()`s the
 * copy fresh. This keeps the real tracked `config.ts` untouched for every
 * test in this file - see `electron-builder-packaging.test.ts` for the one
 * place a real (restored) config stamp is unavoidable.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Arch } from "electron-builder";
import { labelForEnvironment } from "../../../src/electron-main/host/host-paths";

const require = createRequire(import.meta.url);

const DESKTOP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const REAL_MODULE_PATH = path.resolve(
  DESKTOP_ROOT,
  "scripts",
  "prepack",
  "inject-host-launch-agent.cjs",
);
const REAL_PACKAGE_JSON_PATH = path.join(DESKTOP_ROOT, "package.json");
const REAL_PACKAGE_JSON = JSON.parse(
  readFileSync(REAL_PACKAGE_JSON_PATH, "utf8"),
) as { build: { productName: string; appId: string } };
const PRODUCT_NAME = REAL_PACKAGE_JSON.build.productName;
const APP_ID = REAL_PACKAGE_JSON.build.appId;

interface InjectHostLaunchAgentModule {
  afterPack: (context: {
    electronPlatformName: string;
    appOutDir: string;
    arch: number;
  }) => Promise<void>;
}

const fixtureRoots: string[] = [];

function createFixture(environment: "dev" | "production"): {
  modulePath: string;
  appOutDir: string;
  appPath: string;
} {
  const root = mkdtempSync(
    path.join(DESKTOP_ROOT, ".tmp-inject-launch-agent-"),
  );
  fixtureRoots.push(root);

  const scriptsPrepackDir = path.join(root, "scripts", "prepack");
  mkdirSync(scriptsPrepackDir, { recursive: true });
  const modulePath = path.join(
    scriptsPrepackDir,
    "inject-host-launch-agent.cjs",
  );
  cpSync(REAL_MODULE_PATH, modulePath);
  cpSync(REAL_PACKAGE_JSON_PATH, path.join(root, "package.json"));

  const srcDir = path.join(root, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    path.join(srcDir, "config.ts"),
    `export const config = { environment: "${environment}" as string };\n`,
    "utf8",
  );

  const appOutDir = path.join(root, "appOutDir");
  const appPath = path.join(appOutDir, `${PRODUCT_NAME}.app`);
  const cliDir = path.join(
    appPath,
    "Contents",
    "Resources",
    "cli",
    `darwin-${Arch[Arch.arm64]}`,
  );
  mkdirSync(cliDir, { recursive: true });
  const cliBinary = path.join(cliDir, "traycer");
  writeFileSync(cliBinary, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(cliBinary, 0o755);
  writeFileSync(
    path.join(appPath, "Contents", "Resources", "icon.icns"),
    "fake-icon-bytes",
  );

  // A minimal-but-valid outer bundle shape (Info.plist + executable) - a real
  // electron-builder appOutDir always has this; this scaffold only fakes the
  // parts afterPack actually reads.
  const outerMacOSDir = path.join(appPath, "Contents", "MacOS");
  mkdirSync(outerMacOSDir, { recursive: true });
  const outerExecutable = path.join(outerMacOSDir, PRODUCT_NAME);
  writeFileSync(outerExecutable, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(outerExecutable, 0o755);
  writeFileSync(
    path.join(appPath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${PRODUCT_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${APP_ID}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
</dict>
</plist>
`,
    "utf8",
  );

  return { modulePath, appOutDir, appPath };
}

function loadModule(modulePath: string): InjectHostLaunchAgentModule {
  return require(modulePath) as InjectHostLaunchAgentModule;
}

afterEach(() => {
  while (fixtureRoots.length > 0) {
    const root = fixtureRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("inject-host-launch-agent afterPack", () => {
  it("afterPack no-ops when the electron-builder platform isn't darwin, even when production-stamped", async () => {
    const { modulePath, appOutDir } = createFixture("production");
    const injected = loadModule(modulePath);

    await expect(
      injected.afterPack({
        electronPlatformName: "win32",
        appOutDir,
        arch: Arch.x64,
      }),
    ).resolves.toBeUndefined();

    // Guard against ever touching the win32/linux packaged output: the hook
    // must return before computing/reading any darwin-shaped bundle path.
    expect(
      existsSync(path.join(appOutDir, `${PRODUCT_NAME}.app`, "Contents")),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          appOutDir,
          `${PRODUCT_NAME}.app`,
          "Contents",
          "Library",
          "LaunchAgents",
        ),
      ),
    ).toBe(false);
  });

  it("afterPack no-ops when src/config.ts is not production-stamped (dev build)", async () => {
    const { modulePath, appOutDir, appPath } = createFixture("dev");
    const injected = loadModule(modulePath);

    await expect(
      injected.afterPack({
        electronPlatformName: "darwin",
        appOutDir,
        arch: Arch.arm64,
      }),
    ).resolves.toBeUndefined();

    expect(
      existsSync(path.join(appPath, "Contents", "Library", "LaunchAgents")),
    ).toBe(false);
  });

  describe.skipIf(process.platform !== "darwin")(
    "darwin production build (spawns real codesign/plutil against scaffolded temp .app fixtures only)",
    () => {
      it("keeps the injected plist's filename and Label in lockstep with SMAppService's lookup (host-paths labelForEnvironment)", async () => {
        // SMAppService resolves the login item strictly by the
        // `<label>.plist` filename under Contents/Library/LaunchAgents,
        // where <label> comes from host-login-item.ts via
        // labelForEnvironment. The injector necessarily duplicates that
        // string (a pack-time .cjs cannot import electron-main TS), so
        // parity was previously pinned only by matching literals - drift
        // would ship a plist SMAppService can never find while every
        // literal-based assertion stayed green. This test crosses the
        // boundary: the expected name comes from the REAL production
        // lookup code, not a copied string.
        const expectedLabel = labelForEnvironment("production").id;
        const { modulePath, appOutDir, appPath } = createFixture("production");
        const injected = loadModule(modulePath);

        await injected.afterPack({
          electronPlatformName: "darwin",
          appOutDir,
          arch: Arch.arm64,
        });

        const agentPlistPath = path.join(
          appPath,
          "Contents",
          "Library",
          "LaunchAgents",
          `${expectedLabel}.plist`,
        );
        expect(existsSync(agentPlistPath)).toBe(true);
        expect(readFileSync(agentPlistPath, "utf8")).toMatch(
          new RegExp(
            `<key>Label</key>\\s*<string>${expectedLabel.replaceAll(".", "\\.")}</string>`,
          ),
        );
      });

      it("stages a signed helper .app and a relocatable NumberOfFiles=8192 LaunchAgent plist, both valid via plutil -lint", async () => {
        const { modulePath, appOutDir, appPath } = createFixture("production");
        const injected = loadModule(modulePath);

        await injected.afterPack({
          electronPlatformName: "darwin",
          appOutDir,
          arch: Arch.arm64,
        });

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
          "ai.traycer.host.plist",
        );
        expect(existsSync(agentPlistPath)).toBe(true);
        expect(() =>
          execFileSync("plutil", ["-lint", agentPlistPath]),
        ).not.toThrow();

        const agentPlist = readFileSync(agentPlistPath, "utf8");
        expect(agentPlist).toContain(`<key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>8192</integer>
  </dict>`);
        expect(agentPlist).not.toContain("HardResourceLimits");
        expect(agentPlist).not.toContain("<key>HOME</key>");
        // Relocatable-path regression guard: must not bake this fixture's
        // temp appOutDir (electron-builder's real appOutDir is deleted once
        // packaging finishes, so a baked reference to it would be dangling
        // wherever the final .app actually lands).
        expect(agentPlist).not.toContain(appOutDir);

        const bundleProgramMatch = agentPlist.match(
          /<key>BundleProgram<\/key>\s*<string>([^<]+)<\/string>/,
        );
        if (bundleProgramMatch === null) {
          throw new Error("BundleProgram not found in the generated plist");
        }
        const relativeHelperPath = bundleProgramMatch[1];
        expect(relativeHelperPath.startsWith("/")).toBe(false);

        // Actually relocate the packaged .app (cp -R to a different path) and
        // confirm BundleProgram - parsed from the plist, not just grepped -
        // still resolves to a real, executable file there. This is the crux
        // of the relocatable-path fix: the same baked plist must resolve
        // correctly wherever the .app ends up.
        const relocatedRoot = mkdtempSync(
          path.join(DESKTOP_ROOT, ".tmp-inject-launch-agent-relocated-"),
        );
        try {
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
});
