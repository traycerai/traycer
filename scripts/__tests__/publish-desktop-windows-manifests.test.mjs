import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const PUBLISHER = path.join(
  REPO_ROOT,
  "scripts",
  "native-packaging",
  "publish-cli-package-managers.cjs",
);
const VERSION = "1.5.1";
const EXE_URL = `https://github.com/traycerai/traycer/releases/download/desktop-v${VERSION}/traycer-desktop-windows-x64.exe`;
const EXE_SHA256 =
  "c898b0270e5e3ec557759a36edeb5e2f595f7e21e82174f7a374d3312d9d5c9c";

const stagingDirs = [];

afterEach(() => {
  for (const dir of stagingDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function render(extraArgs) {
  const staging = mkdtempSync(path.join(tmpdir(), "desktop-windows-pm-"));
  stagingDirs.push(staging);
  execFileSync(
    process.execPath,
    [
      PUBLISHER,
      "--version",
      VERSION,
      "--staging",
      staging,
      "--release-repo",
      "traycerai/traycer",
      ...extraArgs,
    ],
    { stdio: "pipe" },
  );
  return staging;
}

const WINDOWS_ARGS = ["--win-x64-url", EXE_URL, "--win-x64-sha256", EXE_SHA256];

describe("desktop winget manifest", () => {
  it("installs the signed NSIS installer per user under Traycer.Desktop", () => {
    const staging = render(["--desktop-winget", ...WINDOWS_ARGS]);
    const dir = path.join(
      staging,
      "winget",
      "manifests",
      "t",
      "Traycer",
      "Desktop",
      VERSION,
    );
    const read = (name) =>
      parseYaml(readFileSync(path.join(dir, name), "utf8"));

    const version = read("Traycer.Desktop.yaml");
    const installer = read("Traycer.Desktop.installer.yaml");
    const locale = read("Traycer.Desktop.locale.en-US.yaml");

    for (const manifest of [version, installer, locale]) {
      expect(manifest).toMatchObject({
        PackageIdentifier: "Traycer.Desktop",
        PackageVersion: VERSION,
        ManifestVersion: "1.10.0",
      });
    }
    expect(version.DefaultLocale).toBe("en-US");
    expect(installer).toMatchObject({
      InstallerType: "nullsoft",
      Scope: "user",
      Installers: [
        {
          Architecture: "x64",
          InstallerUrl: EXE_URL,
          InstallerSha256: EXE_SHA256.toUpperCase(),
        },
      ],
    });
    expect(locale).toMatchObject({
      PackageLocale: "en-US",
      PackageName: "Traycer",
      ReleaseNotesUrl: `https://github.com/traycerai/traycer/releases/tag/desktop-v${VERSION}`,
    });
  });
});

describe("desktop Scoop manifest", () => {
  function renderScoop() {
    const staging = render(["--desktop-scoop", ...WINDOWS_ARGS]);
    return JSON.parse(
      readFileSync(
        path.join(staging, "scoop", "bucket", "traycer-desktop.json"),
        "utf8",
      ),
    );
  }

  it("unpacks the NSIS payload and marks the install for the in-app updater", () => {
    const manifest = renderScoop();

    expect(manifest.version).toBe(VERSION);
    expect(manifest.architecture["64bit"]).toEqual({
      url: `${EXE_URL}#/dl.7z`,
      hash: EXE_SHA256,
    });
    expect(manifest.installer.script[0]).toBe(
      'Expand-7zipArchive "$dir\\`$PLUGINSDIR\\app-64.7z" "$dir"',
    );
    // `clients/desktop/src/electron-main/app/scoop-install.ts` reads exactly
    // this file and value.
    expect(manifest.installer.script).toContain(
      "Set-Content -Path \"$dir\\resources\\package-type\" -Value 'scoop' -NoNewline -Encoding ascii",
    );
    expect(manifest.shortcuts).toEqual([["Traycer.exe", "Traycer"]]);
    expect(manifest.autoupdate.architecture["64bit"].url).toBe(
      "https://github.com/traycerai/traycer/releases/download/desktop-v$version/traycer-desktop-windows-x64.exe#/dl.7z",
    );
  });

  it("removes the host autostart on scoop uninstall only, never on scoop update", () => {
    const script = renderScoop().uninstaller.script;

    expect(script[0]).toBe("if ($cmd -eq 'uninstall') {");
    expect(script.at(-1)).toBe("}");
    expect(script.join("\n")).toContain(
      "schtasks /Delete /TN '\\Traycer\\Host' /F",
    );
  });

  it("checkver picks the newest stable desktop tag from the shared release list", () => {
    const { checkver } = renderScoop();
    const releases = JSON.stringify([
      { tag_name: "cli-v2.0.0" },
      { tag_name: "desktop-v1.6.0-rc.1" },
      { tag_name: "host-v1.9.0" },
      { tag_name: "desktop-v1.5.1" },
      { tag_name: "desktop-v1.5.0" },
    ]);

    expect(checkver.url).toBe(
      "https://api.github.com/repos/traycerai/traycer/releases?per_page=100",
    );
    expect(new RegExp(checkver.regex).exec(releases)?.[1]).toBe("1.5.1");
  });
});

it("refuses to render without the installer's sha256", () => {
  expect(() =>
    render(["--desktop-winget", "--desktop-scoop", "--win-x64-url", EXE_URL]),
  ).toThrow(/Missing required --winX64Sha256/);
});
