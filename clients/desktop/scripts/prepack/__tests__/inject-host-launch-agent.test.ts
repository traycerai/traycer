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
  accessSync,
  chmodSync,
  constants,
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
import {
  labelForEnvironment,
  smAppServiceAgentLabelId,
} from "../../../src/electron-main/host/host-paths";

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
      it("keeps the injected plists' filenames and Labels in lockstep with SMAppService's lookup (host-paths labelForEnvironment + smAppServiceAgentLabelId)", async () => {
        // SMAppService resolves the login item strictly by the
        // `<label>.plist` filename under Contents/Library/LaunchAgents,
        // where <label> comes from host-login-item.ts via
        // labelForEnvironment/smAppServiceAgentLabelId. The injector
        // necessarily duplicates those strings (a pack-time .cjs cannot
        // import electron-main TS), so parity was previously pinned only
        // by matching literals - drift would ship a plist SMAppService can
        // never find while every literal-based assertion stayed green.
        // This test crosses the boundary: the expected names come from the
        // REAL production lookup code, not copied strings. Both plists are
        // asserted: the registered agent plist AND the inert old-label
        // plist the desktop's transition cleanup resolves for unregister.
        const cliLabel = labelForEnvironment("production").id;
        const agentLabel = smAppServiceAgentLabelId(cliLabel);
        const { modulePath, appOutDir, appPath } = createFixture("production");
        const injected = loadModule(modulePath);

        await injected.afterPack({
          electronPlatformName: "darwin",
          appOutDir,
          arch: Arch.arm64,
        });

        for (const expectedLabel of [agentLabel, cliLabel]) {
          const plistPath = path.join(
            appPath,
            "Contents",
            "Library",
            "LaunchAgents",
            `${expectedLabel}.plist`,
          );
          expect(existsSync(plistPath)).toBe(true);
          expect(readFileSync(plistPath, "utf8")).toMatch(
            new RegExp(
              `<key>Label</key>\\s*<string>${expectedLabel.replaceAll(".", "\\.")}</string>`,
            ),
          );
          const plist = readFileSync(plistPath, "utf8");
          // Deliberately the full launcher path, not a `toContain` of the
          // basename: the helper bundle directory is `<product> Host.app`, so
          // a bare substring check for `<product> Host` passes no matter what
          // the launcher is called - it matches the directory. Verified by
          // mutation probe (reverting the basename left the loose form green).
          expect(plist).toContain(
            `<string>Contents/Library/LaunchAgents/${PRODUCT_NAME} Host.app/Contents/MacOS/${PRODUCT_NAME} Host</string>`,
          );
          expect(plist).not.toContain("<string>/bin/sh</string>");
          expect(plist).toContain(expectedLabel);
        }
      });

      it("names the executable BTM shows in Login Items after the product, not after a slug filename", async () => {
        // System Settings → Login Items renders this agent under whatever
        // BTM recorded as `Name`, and BTM takes that from the VERBATIM
        // basename of the plist's `BundleProgram`. It is not bundle-aware:
        // live-probed 2026-07-29 (macOS 26.5, real `SMAppService.agent`
        // registration read back with `sfltool dumpbtm`), a variant whose
        // `BundleProgram` pointed at the helper bundle's own
        // `CFBundleExecutable` still recorded that executable's basename and
        // ignored `CFBundleDisplayName`/`CFBundleName`/the `.app` name. So
        // the helper's Info.plist naming keys - asserted elsewhere in this
        // file - do NOT cover this, and cannot: the basename is the only
        // lever, which is what makes it worth its own test.
        //
        // The prior basename `traycer-host-start` shipped a filename into a
        // product surface. Reverting it must fail here.
        const { modulePath, appOutDir, appPath } = createFixture("production");
        const injected = loadModule(modulePath);

        await injected.afterPack({
          electronPlatformName: "darwin",
          appOutDir,
          arch: Arch.arm64,
        });

        const agentLabel = smAppServiceAgentLabelId(
          labelForEnvironment("production").id,
        );
        const agentPlist = readFileSync(
          path.join(
            appPath,
            "Contents",
            "Library",
            "LaunchAgents",
            `${agentLabel}.plist`,
          ),
          "utf8",
        );
        const bundleProgram = agentPlist.match(
          /<key>BundleProgram<\/key>\s*<string>([^<]+)<\/string>/,
        )?.[1];
        if (bundleProgram === undefined) {
          throw new Error("BundleProgram not found in the generated plist");
        }

        // The one assertion this test is named for: what the user reads.
        expect(path.basename(bundleProgram)).toBe(`${PRODUCT_NAME} Host`);

        // launchd execs `BundleProgram`, so a name BTM likes is worthless if
        // the file it points at is not actually there and executable. The
        // live probe confirmed launchd resolves and runs a space-containing
        // basename (`$0` intact, exit 0); this pins our half of that.
        const launcherOnDisk = path.join(appPath, bundleProgram);
        expect(existsSync(launcherOnDisk)).toBe(true);
        expect(() => {
          accessSync(launcherOnDisk, constants.X_OK);
        }).not.toThrow();

        // ProgramArguments[0] and BundleProgram must name the same file.
        // launchd uses BundleProgram for the exec, but the argv is what
        // `attestTraycerRegistration` reads, so drift between them would
        // leave the two halves disagreeing about which file this job is.
        const firstProgramArgument = agentPlist.match(
          /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/,
        )?.[1];
        expect(firstProgramArgument).toBe(bundleProgram);
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

        // The premise the unconditional `--service-label` rests on: the CLI
        // the shim execs is a byte-identical copy of the one this same
        // afterPack run staged into the bundle, sitting beside the launcher -
        // never the user's `~/.traycer` slot symlink. If this ever stops
        // holding, the shim needs a capability probe again.
        expect(readFileSync(helperBinary)).toEqual(
          readFileSync(
            path.join(
              appPath,
              "Contents",
              "Resources",
              "cli",
              "darwin-arm64",
              "traycer",
            ),
          ),
        );

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
        // The inert old-label plist must also be structurally valid - the
        // desktop's transition unregister resolves it via SMAppService.
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
        const relativeLauncherPath = bundleProgramMatch[1];
        expect(relativeLauncherPath.startsWith("/")).toBe(false);
        expect(relativeLauncherPath.endsWith(`/${PRODUCT_NAME} Host`)).toBe(
          true,
        );

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
          const resolvedLauncherPath = path.join(
            relocatedAppPath,
            relativeLauncherPath,
          );
          expect(existsSync(resolvedLauncherPath)).toBe(true);
          expect(statSync(resolvedLauncherPath).mode & 0o111).not.toBe(0);

          // BundleProgram points to this real executable boundary. Execute it
          // after relocating the app and replace only its sibling CLI, so the
          // argv the CLI actually receives is asserted rather than XML text
          // inspected.
          //
          // There is deliberately NO capability probe here, and the stub
          // proves it: it answers nothing but a plain argv dump, so a
          // launcher that tried to probe would either mis-detect or record an
          // extra invocation. The shim's CLI is not the user's slot symlink -
          // `installHelperApp` copies it out of
          // `Contents/Resources/cli/darwin-<arch>/` into this exact directory
          // in the same afterPack run, from the same build, shipping in the
          // same bundle (asserted below). With no mixed-version case to
          // detect, a probe could only ever answer wrongly - which is what it
          // did, silently dropping the label as soon as `--service-label` was
          // hidden from help output.
          const relocatedCliPath = path.join(
            path.dirname(resolvedLauncherPath),
            "traycer",
          );
          const invocationsPath = path.join(relocatedRoot, "invocations.txt");
          writeFileSync(
            relocatedCliPath,
            `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(invocationsPath)}
if [ "$2" = "adoption-nonce" ]; then exit 1; fi
printf '%s\\n' "$@"
`,
            "utf8",
          );
          chmodSync(relocatedCliPath, 0o755);
          expect(
            execFileSync(resolvedLauncherPath, ["ai.traycer.host.agent"], {
              encoding: "utf8",
            }),
          ).toBe("host\nstart\n--service-label\nai.traycer.host.agent\n");
          // Two invocations, in order: the adoption-nonce probe, then the
          // host start. This stub DECLINES the probe (exit 1), which is the
          // documented no-proof path a launcher must treat as normal under
          // `set -eu` - so the start leg carries no `--adoption-nonce` and the
          // argv assertions above are the plain form.
          //
          // This assertion is what pins the probe as a real round trip rather
          // than an assumption: the launcher is resolving its sibling CLI by a
          // relative `$0`, and a probe that silently never ran would leave the
          // path resolution this test exists for only half exercised.
          expect(readFileSync(invocationsPath, "utf8")).toBe(
            "host adoption-nonce --service-label ai.traycer.host.agent\n" +
              "host start --service-label ai.traycer.host.agent\n",
          );

          // Relative-`$0` hazard, exercised for real. An `argv0` override
          // cannot test this - the shim is a `#!/bin/sh` script, so the
          // kernel discards the caller's argv[0] and hands the interpreter
          // the resolved script path no matter what was passed. Invoking
          // through a genuinely relative path from a different cwd is what
          // makes `$0` relative, and so what exercises the
          // `cd -- "$(dirname -- "$0")"` resolution the shim uses to locate
          // its sibling CLI.
          expect(
            execFileSync(
              path.join(".", relativeLauncherPath),
              ["ai.traycer.host.agent"],
              { encoding: "utf8", cwd: relocatedAppPath },
            ),
          ).toBe("host\nstart\n--service-label\nai.traycer.host.agent\n");
        } finally {
          rmSync(relocatedRoot, { recursive: true, force: true });
        }
      });

      it("runs the real packaged launcher through label-only fallback when nonce discovery exits 1", async () => {
        const { modulePath, appOutDir, appPath } = createFixture("production");
        const injected = loadModule(modulePath);
        await injected.afterPack({
          electronPlatformName: "darwin",
          appOutDir,
          arch: Arch.arm64,
        });

        const agentLabel = smAppServiceAgentLabelId(
          labelForEnvironment("production").id,
        );
        const agentPlist = readFileSync(
          path.join(
            appPath,
            "Contents",
            "Library",
            "LaunchAgents",
            `${agentLabel}.plist`,
          ),
          "utf8",
        );
        const bundleProgram = agentPlist.match(
          /<key>BundleProgram<\/key>\s*<string>([^<]+)<\/string>/,
        )?.[1];
        if (bundleProgram === undefined)
          throw new Error("BundleProgram not found");
        const launcherPath = path.join(appPath, bundleProgram);
        const cliPath = path.join(path.dirname(launcherPath), "traycer");
        const invocationsPath = path.join(
          appOutDir,
          "nonce-fallback-invocations.txt",
        );
        writeFileSync(
          cliPath,
          `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(invocationsPath)}
if [ "$2" = "adoption-nonce" ]; then exit 1; fi
printf '%s\\n' "$@"
`,
          "utf8",
        );
        chmodSync(cliPath, 0o755);

        expect(
          execFileSync(launcherPath, [agentLabel], { encoding: "utf8" }),
        ).toBe(`host\nstart\n--service-label\n${agentLabel}\n`);
        expect(readFileSync(invocationsPath, "utf8")).toBe(
          `host adoption-nonce --service-label ${agentLabel}\nhost start --service-label ${agentLabel}\n`,
        );
      });
    },
  );
});
