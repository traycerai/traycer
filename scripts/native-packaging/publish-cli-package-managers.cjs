"use strict";

// Generate package-manager manifest updates for a published CLI release.
//
// This script is invoked from the cross-platform `update-cli-package-
// managers` workflow after all per-platform CLI release workflows have
// finished publishing the signed binaries to the cli-v* GitHub Release
// on RELEASE_REPO. It does not push to upstream taps/repos directly -
// instead it:
//
//   1. Reads the per-platform descriptors emitted by sign-cli-binary.cjs.
//   2. Renders ready-to-commit manifests for Homebrew, winget, scoop,
//      a debian/rpm template metadata file, a Desktop Homebrew cask, and a generated install
//      manifest hint (so package-manager install hooks can call
//      `traycer cli mark-source` with the correct source identifier).
//   3. Writes the rendered manifests under a staging directory the
//      workflow then commits/pushes to the external taps using a
//      configured PAT secret.
//
// External repository assumptions (configured via secrets in workflows):
//   - Homebrew tap:   traycerai/homebrew-traycer   (Formula/traycer.rb, Casks/traycer-desktop.rb)
//   - winget:        microsoft/winget-pkgs forks   (manifests/t/Traycer/CLI)
//   - scoop:         traycerai/scoop-traycer        (bucket/traycer-cli.json)
//   - deb/rpm:       traycerai/traycer-apt-rpm     (versions.json)
//
// Required secrets (used by the calling workflow, not this script):
//   TRAYCER_TAP_PUSH_TOKEN   PAT with `repo` scope on the tap repos.
//
// Output: writes files under --staging <dir>, prints a JSON summary
// (paths + manifest snippets) on stdout.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Canonical public-facing repo URL used for auto-generated release-notes
// links in Homebrew/winget/Scoop/deb-rpm manifests. The build-time repo
// (`traycerai/traycer-development`) is private; auto-generated download
// pages must point at the public mirror. Override per-invocation via
// `--release-notes-url <url>` when cutting a release out of a fork.
const DEFAULT_RELEASE_NOTES_REPO = "traycerai/traycer";

function parseArgs(argv) {
  const out = { descriptors: [] };
  const valueFor = (token, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }
    return value;
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--descriptor") {
      out.descriptors.push(valueFor(token, i));
      i += 1;
    } else if (token === "--version") {
      out.version = valueFor(token, i);
      i += 1;
    } else if (token === "--staging") {
      out.staging = valueFor(token, i);
      i += 1;
    } else if (token === "--release-notes-url") {
      out.releaseNotesUrl = valueFor(token, i);
      i += 1;
    } else if (token === "--release-repo") {
      out.releaseRepo = valueFor(token, i);
      i += 1;
    } else if (token === "--homepage") {
      out.homepage = valueFor(token, i);
      i += 1;
    } else if (token === "--license") {
      out.license = valueFor(token, i);
      i += 1;
    } else if (token === "--managers") {
      out.managers = valueFor(token, i);
      i += 1;
    } else if (token === "--desktop-cask") {
      out.desktopCask = true;
    } else if (token === "--homebrew-versioned-only") {
      out.homebrewVersionedOnly = true;
    } else if (token === "--target-homebrew-version") {
      out.targetHomebrewVersion = valueFor(token, i);
      i += 1;
    } else if (token === "--mac-arm-url") {
      out.macArmUrl = valueFor(token, i);
      i += 1;
    } else if (token === "--mac-arm-sha256") {
      out.macArmSha256 = valueFor(token, i);
      i += 1;
    } else if (token === "--mac-x64-url") {
      out.macX64Url = valueFor(token, i);
      i += 1;
    } else if (token === "--mac-x64-sha256") {
      out.macX64Sha256 = valueFor(token, i);
      i += 1;
    } else if (token === "--linux-x64-appimage-url") {
      out.linuxX64AppImageUrl = valueFor(token, i);
      i += 1;
    } else if (token === "--linux-x64-appimage-sha256") {
      out.linuxX64AppImageSha256 = valueFor(token, i);
      i += 1;
    }
  }
  return out;
}

function requiredArg(args, name) {
  if (typeof args[name] !== "string" || args[name].length === 0) {
    throw new Error(`Missing required --${name}`);
  }
  return args[name];
}

function readDescriptor(file) {
  const raw = fs.readFileSync(file, "utf8");
  const obj = JSON.parse(raw);
  if (typeof obj.platformKey !== "string" || obj.descriptor === undefined) {
    throw new Error(`Descriptor ${file} missing platformKey/descriptor`);
  }
  return obj;
}

function descriptorsByPlatform(descriptors) {
  const out = {};
  for (const d of descriptors) {
    out[d.platformKey] = d.descriptor;
  }
  return out;
}

function requirePlatform(byPlatform, key) {
  const d = byPlatform[key];
  if (d === undefined) {
    throw new Error(
      `Missing descriptor for platform '${key}'; cannot render package-manager manifest`,
    );
  }
  // A descriptor with `available: false` is legitimate per the fixture
  // schema but has empty url/sha256/signatureUrl fields. Rendering one
  // into a Homebrew/winget/Scoop/deb-rpm manifest would commit `url ""`
  // / `sha256 ""` to the public tap. Fail loudly here so the publisher
  // never produces a broken tap commit; release engineers must either
  // republish the platform asset or drop the platform from the matrix.
  if (d.available !== true) {
    const reason =
      typeof d.unavailableReason === "string" && d.unavailableReason.length > 0
        ? d.unavailableReason
        : "(no unavailableReason recorded)";
    throw new Error(
      `Descriptor for platform '${key}' is marked available=false (${reason}); cannot render package-manager manifest with an empty URL/sha256`,
    );
  }
  return d;
}

function maybePlatform(byPlatform, key) {
  const d = byPlatform[key];
  if (d === undefined) return null;
  // Treat available=false the same as a missing descriptor for optional
  // platforms - the renderer's conditional `linuxBlock` / arm64 winget /
  // arm64 scoop branches must omit the platform entirely rather than
  // emit empty fields. The strict counterpart is requirePlatform.
  if (d.available !== true) return null;
  return d;
}

const DEFAULT_MANAGERS = ["homebrew", "winget", "scoop", "deb-rpm"];
const HOMEBREW_LINUX_CASK_MIN_VERSION = "4.5.0";

function selectedManagers(rawManagers) {
  if (typeof rawManagers !== "string" || rawManagers.trim().length === 0) {
    return new Set(DEFAULT_MANAGERS);
  }
  const selected = rawManagers
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (selected.length === 0) {
    throw new Error("--managers must name at least one manager when supplied");
  }
  for (const manager of selected) {
    if (!DEFAULT_MANAGERS.includes(manager)) {
      throw new Error(
        `Unknown package manager '${manager}'. Expected one of: ${DEFAULT_MANAGERS.join(", ")}`,
      );
    }
  }
  return new Set(selected);
}

function homebrewExactVersionTokenSuffix(version) {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(version);
  if (match === null) {
    throw new Error(
      `Cannot derive Homebrew exact-version token suffix from version '${version}'`,
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function homebrewVersionedClassName(version) {
  return `TraycerAT${version.replace(/[^0-9]/g, "")}`;
}

function compareDottedVersions(left, right) {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i += 1) {
    const leftPart = Number.isNaN(leftParts[i]) ? 0 : leftParts[i] || 0;
    const rightPart = Number.isNaN(rightParts[i]) ? 0 : rightParts[i] || 0;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }
  return 0;
}

function requireHomebrewLinuxCaskSupport(targetHomebrewVersion) {
  if (
    compareDottedVersions(
      targetHomebrewVersion,
      HOMEBREW_LINUX_CASK_MIN_VERSION,
    ) < 0
  ) {
    throw new Error(
      `Desktop Linux AppImage casks require Homebrew >= ${HOMEBREW_LINUX_CASK_MIN_VERSION}; target is ${targetHomebrewVersion}`,
    );
  }
}

// Homebrew formula - single ruby file that downloads the SEA binary
// directly. Two-arch macOS support via on_macos/on_arm/on_intel; Linux
// support is included so `brew install` works on Linuxbrew too.
function renderHomebrewFormula({
  version,
  className,
  kegOnly,
  byPlatform,
  homepage,
  license,
  releaseNotesUrl,
}) {
  const darwinArm = requirePlatform(byPlatform, "darwin-arm64");
  const darwinX64 = requirePlatform(byPlatform, "darwin-x64");
  const linuxArm = maybePlatform(byPlatform, "linux-arm64");
  const linuxX64 = maybePlatform(byPlatform, "linux-x64");
  const linuxBlock =
    linuxArm !== null || linuxX64 !== null
      ? `
  on_linux do
${
  linuxArm !== null
    ? `    on_arm do
      url "${linuxArm.url}"
      sha256 "${linuxArm.sha256}"
    end
`
    : ""
}${
          linuxX64 !== null
            ? `    on_intel do
      url "${linuxX64.url}"
      sha256 "${linuxX64.sha256}"
    end
`
            : ""
        }  end`
      : "";
  const kegOnlyBlock = kegOnly ? "\n  keg_only :versioned_formula\n" : "";
  return `# Auto-generated by scripts/native-packaging/publish-cli-package-managers.cjs
# Source: ${releaseNotesUrl}
# Do not hand-edit - package-manager publishing regenerates this file.
class ${className} < Formula
  desc "Traycer CLI - host supervisor, auth, and config surface"
  homepage "${homepage}"
  version "${version}"
  license "${license}"
${kegOnlyBlock}
  on_macos do
    on_arm do
      url "${darwinArm.url}"
      sha256 "${darwinArm.sha256}"
    end
    on_intel do
      url "${darwinX64.url}"
      sha256 "${darwinX64.sha256}"
    end
  end${linuxBlock}

  def install
    bin.install Dir["traycer*"].first => "traycer"
    # Mark this install as homebrew-owned so 'traycer cli upgrade' guides
    # the user to 'brew upgrade traycer' instead of self-replacing. Only the
    # mark-source call is best-effort (it writes the CLI install manifest if
    # the user's home is writable) - a failed bin.install above must still
    # fail the formula rather than be swallowed.
    begin
      system bin/"traycer", "cli", "mark-source", "--source", "homebrew",
             "--binary-path", bin/"traycer", "--installed-version", version
    rescue
      nil
    end
  end

  test do
    # 'traycer --version' prints only a semver-shaped version string
    # (no 'traycer' prefix). We pin two checks:
    #   1. The reported value matches the released formula version
    #      exactly. This catches release artifacts that were built
    #      without TRAYCER_CLI_VERSION (which would otherwise report
    #      the source-tree placeholder "0.0.0-local" or a stale
    #      "0.0.0"); a generic /^\\d+\\.\\d+\\.\\d+/ shape match would
    #      let those slip through.
    #   2. As defence in depth, reject the literal placeholders so a
    #      future formula refactor that loosens (1) still cannot ship a
    #      placeholder build.
    reported = shell_output("#{bin}/traycer --version").strip
    assert_equal version.to_s, reported
    refute_match(/\\A0\\.0\\.0(?:-local)?\\z/, reported)
  end
end
`;
}

function renderHomebrewCask({
  token,
  version,
  homepage,
  macArm,
  macX64,
  linuxX64AppImage,
}) {
  const linuxBlock =
    linuxX64AppImage === null
      ? ""
      : `
  # Linux AppImage casks require Homebrew >= ${HOMEBREW_LINUX_CASK_MIN_VERSION}.
  on_linux do
    depends_on arch: :x86_64

    sha256 "${linuxX64AppImage.sha256}"
    url "${linuxX64AppImage.url}"

    appimage "${basenameFromUrl(linuxX64AppImage.url)}"
  end`;
  return `# Auto-generated by scripts/native-packaging/publish-cli-package-managers.cjs
# Do not hand-edit - package-manager publishing regenerates this file.
cask "${token}" do
  arch arm: "arm64", intel: "x64"

  version "${version}"

  on_macos do
    on_arm do
      sha256 "${macArm.sha256}"
      url "${macArm.url}"
    end

    on_intel do
      sha256 "${macX64.sha256}"
      url "${macX64.url}"
    end

    depends_on macos: :monterey

    app "Traycer.app"
  end${linuxBlock}

  name "Traycer"
  desc "Traycer desktop app"
  homepage "${homepage}"

  auto_updates true
end
`;
}

// winget manifest - three YAML files per package version (version,
// installer, locale). The installer file pins the platform-specific
// sha256 + URL so winget's downloader verifies the bytes before
// running the SEA executable as a portable.
function renderWingetManifests({
  version,
  byPlatform,
  homepage,
  license,
  releaseNotesUrl,
}) {
  const winX64 = requirePlatform(byPlatform, "win32-x64");
  const winArm = maybePlatform(byPlatform, "win32-arm64");
  const installers = [
    {
      Architecture: "x64",
      InstallerType: "portable",
      InstallerUrl: winX64.url,
      InstallerSha256: winX64.sha256.toUpperCase(),
    },
  ];
  if (winArm !== null) {
    installers.push({
      Architecture: "arm64",
      InstallerType: "portable",
      InstallerUrl: winArm.url,
      InstallerSha256: winArm.sha256.toUpperCase(),
    });
  }

  const versionYaml = `PackageIdentifier: Traycer.CLI
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`;
  const installerYaml = `PackageIdentifier: Traycer.CLI
PackageVersion: ${version}
MinimumOSVersion: 10.0.0.0
InstallModes:
  - silent
Commands:
  - traycer
ReleaseDate: ${new Date().toISOString().slice(0, 10)}
Installers:
${installers
  .map(
    (i) =>
      `  - Architecture: ${i.Architecture}
    InstallerType: ${i.InstallerType}
    InstallerUrl: ${i.InstallerUrl}
    InstallerSha256: ${i.InstallerSha256}`,
  )
  .join("\n")}
ManifestType: installer
ManifestVersion: 1.6.0
`;
  const localeYaml = `PackageIdentifier: Traycer.CLI
PackageVersion: ${version}
PackageLocale: en-US
Publisher: Traycer
PublisherUrl: ${homepage}
PackageName: Traycer CLI
PackageUrl: ${homepage}
License: ${license}
ShortDescription: Traycer CLI - host supervisor, auth, and config surface
ReleaseNotesUrl: ${releaseNotesUrl}
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`;
  return {
    "Traycer.CLI.yaml": versionYaml,
    "Traycer.CLI.installer.yaml": installerYaml,
    "Traycer.CLI.locale.en-US.yaml": localeYaml,
  };
}

// Scoop manifest - single JSON describing per-arch SEA binaries.
//
// Per-architecture `bin` uses the `[[source, alias]]` form so the
// downloaded asset (`traycer-cli-windows-x64.exe` /
// `traycer-cli-windows-arm64.exe`)
// is exposed on PATH as `traycer.exe` (and as the alias `traycer`).
// Without the alias mapping `scoop install` would shim the long
// asset name and `traycer ...` would not resolve from the user's
// shell.
function renderScoopManifest({
  version,
  byPlatform,
  homepage,
  license,
  releaseNotesUrl,
  releaseRepo,
}) {
  const winX64 = requirePlatform(byPlatform, "win32-x64");
  const winArm = maybePlatform(byPlatform, "win32-arm64");
  const x64AssetName = basenameFromUrl(winX64.url);
  const architecture = {
    "64bit": {
      url: winX64.url,
      hash: winX64.sha256,
      bin: [[x64AssetName, "traycer"]],
    },
  };
  if (winArm !== null) {
    const armAssetName = basenameFromUrl(winArm.url);
    architecture.arm64 = {
      url: winArm.url,
      hash: winArm.sha256,
      bin: [[armAssetName, "traycer"]],
    };
  }
  const manifest = {
    version,
    description: "Traycer CLI - host supervisor, auth, and config surface",
    homepage,
    license,
    architecture,
    notes: `Release notes: ${releaseNotesUrl}`,
    post_install: [
      // Locate the alias shim Scoop created from the [[source, alias]]
      // mapping above. Falls back to the raw asset if a future Scoop
      // version stops generating the alias.
      "$traycerExe = Join-Path $dir 'traycer.exe'",
      "if (-not (Test-Path $traycerExe)) {",
      "  $candidate = Get-ChildItem -Path $dir -Filter 'traycer-cli-windows-*.exe' | Select-Object -First 1",
      "  if ($candidate) { $traycerExe = $candidate.FullName }",
      "}",
      // Scoop install runs `post_install` synchronously and blocks the
      // user's shell prompt until every entry returns. `& $traycer ...`
      // therefore stretches install time by however long `mark-source`
      // takes. Start the helper detached (`-Wait:$false`) and hide its
      // window so the source-attribution write is best-effort and never
      // visible to the user - errors are still silenced with `2>$null`.
      "Start-Process -FilePath $traycerExe -ArgumentList @('cli','mark-source','--source','scoop','--binary-path',$traycerExe,'--installed-version',$version) -NoNewWindow -Wait:$false 2>$null",
    ],
    // checkver reads `latest` from the rolling `cli-manifest` GitHub
    // Release asset on RELEASE_REPO (the same versions.json the CLI
    // self-update consumes); autoupdate templates the per-arch asset
    // URLs on the cli-v<version> Release.
    checkver: {
      url: `https://github.com/${releaseRepo}/releases/download/cli-manifest/versions.json`,
      jsonpath: "$.latest",
    },
    autoupdate: {
      architecture: {
        "64bit": {
          url: `https://github.com/${releaseRepo}/releases/download/cli-v$version/traycer-cli-windows-x64.exe`,
        },
        arm64: {
          url: `https://github.com/${releaseRepo}/releases/download/cli-v$version/traycer-cli-windows-arm64.exe`,
        },
      },
    },
  };
  return manifest;
}

function basenameFromUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const segments = parsed.pathname.split("/");
    const last = segments[segments.length - 1];
    if (typeof last === "string" && last.length > 0) return last;
  } catch {
    // fall through
  }
  // Defensive default - keeps `bin` valid even if URL parsing fails.
  return "traycer.exe";
}

// Per-package postRemove script. Only removes the marker for the
// package being uninstalled (`apt` for .deb, `rpm` for .rpm) so the
// other package manager's marker - if a user has both installed - is
// left intact. Only `rmdir /var/lib/traycer` if the directory is now
// empty (other markers might still be present).
function renderPostRemoveScript(pkgKind) {
  if (pkgKind !== "deb" && pkgKind !== "rpm") {
    throw new Error(`renderPostRemoveScript: invalid pkgKind '${pkgKind}'`);
  }
  const markerSuffix = pkgKind === "deb" ? "apt" : "rpm";
  return [
    "#!/bin/sh",
    `rm -f /var/lib/traycer/source.${markerSuffix}`,
    '[ -z "$(ls -A /var/lib/traycer 2>/dev/null)" ] && rmdir /var/lib/traycer 2>/dev/null || true',
    "exit 0",
  ].join("\n");
}

// Debian/RPM metadata - package-manager-agnostic JSON consumed by our
// apt/rpm repo build pipeline. The pipeline downloads the binary,
// builds a .deb / .rpm with post-install hooks that call
// `traycer cli mark-source --source apt|rpm` and removes only the
// installed binary on uninstall (post-remove does NOT touch ~/.traycer
// or the host install directory).
function renderDebRpmMetadata({
  version,
  byPlatform,
  homepage,
  license,
  releaseNotesUrl,
}) {
  const linuxArm = maybePlatform(byPlatform, "linux-arm64");
  const linuxX64 = requirePlatform(byPlatform, "linux-x64");
  const architectures = {
    amd64: {
      url: linuxX64.url,
      sha256: linuxX64.sha256,
      signatureUrl: linuxX64.signatureUrl,
    },
  };
  if (linuxArm !== null) {
    architectures.arm64 = {
      url: linuxArm.url,
      sha256: linuxArm.sha256,
      signatureUrl: linuxArm.signatureUrl,
    };
  }
  return {
    name: "traycer-cli",
    version,
    description: "Traycer CLI - host supervisor, auth, and config surface",
    homepage,
    license,
    releaseNotesUrl,
    architectures,
    postInstall: {
      // Write a system-wide install-source marker that any subsequent
      // `traycer cli upgrade` invocation reads (see
      // traycer-clients/traycer-cli/src/manifest/cli-manifest.ts ::
      // readSystemSourceMarker). The marker is preferred over the
      // legacy `cli mark-source` invocation because it works for
      // unattended installs where SUDO_USER is unset and for
      // multi-user systems where no single $HOME is "the user".
      script: [
        "#!/bin/sh",
        "set -e",
        "SRC=${PKG_SOURCE:-apt}",
        "install -d -m 0755 /var/lib/traycer",
        'printf \'{"source":"%s","binaryPath":"/usr/bin/traycer","version":"' +
          version +
          '"}\\n\' "$SRC" > /var/lib/traycer/source.${SRC}',
        "chmod 0644 /var/lib/traycer/source.${SRC}",
        "exit 0",
      ].join("\n"),
    },
    // Pre-remove must NEVER touch ~/.traycer/, the host install dir,
    // or the OS service registration. Package-manager uninstall removes
    // ONLY the CLI binary (handled implicitly by dpkg/rpm). The script
    // is a no-op placeholder so the build pipeline can include the hook
    // file without conditional logic.
    preRemove: {
      script: ["#!/bin/sh", "exit 0"].join("\n"),
    },
    postRemove: {
      // Clean up only the system-wide install-source marker for the
      // package being uninstalled (deb or rpm) so a subsequent
      // re-install through the same package manager cleanly re-records
      // it, and a coexisting install through the *other* manager keeps
      // its marker untouched. Never touches ~/.traycer/, host install
      // dir, or service registration. The build pipeline reads the
      // per-kind variant matching the artifact it's emitting.
      deb: { script: renderPostRemoveScript("deb") },
      rpm: { script: renderPostRemoveScript("rpm") },
    },
  };
}

function sha256OfString(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function writeFile(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function main() {
  const args = parseArgs(process.argv);
  const version = requiredArg(args, "version");
  const staging = requiredArg(args, "staging");
  // RELEASE_REPO coordinate (the OSS distribution surface). Drives both
  // the auto-generated release-notes links and the GitHub-Releases-hosted
  // scoop checkver/autoupdate URLs. Override per-invocation via
  // `--release-repo`; defaults to the public mirror.
  const releaseRepo = args.releaseRepo || DEFAULT_RELEASE_NOTES_REPO;
  const releaseNotesUrl =
    args.releaseNotesUrl ||
    `https://github.com/${releaseRepo}/releases/tag/cli-v${version}`;
  const homepage = args.homepage || "https://traycer.ai";
  const license = args.license || "MIT";
  if (args.desktopCask === true) {
    const macArm = {
      url: requiredArg(args, "macArmUrl"),
      sha256: requiredArg(args, "macArmSha256"),
    };
    const macX64 = {
      url: requiredArg(args, "macX64Url"),
      sha256: requiredArg(args, "macX64Sha256"),
    };
    const linuxX64AppImage =
      typeof args.linuxX64AppImageUrl === "string" ||
      typeof args.linuxX64AppImageSha256 === "string"
        ? {
            url: requiredArg(args, "linuxX64AppImageUrl"),
            sha256: requiredArg(args, "linuxX64AppImageSha256"),
          }
        : null;
    if (linuxX64AppImage !== null) {
      requireHomebrewLinuxCaskSupport(
        args.targetHomebrewVersion || HOMEBREW_LINUX_CASK_MIN_VERSION,
      );
    }
    const versionedCaskVersion = homebrewExactVersionTokenSuffix(version);
    const caskOutputs = [];
    if (args.homebrewVersionedOnly !== true) {
      caskOutputs.push({
        manager: "homebrew-cask",
        path: path.join(staging, "homebrew", "Casks", "traycer-desktop.rb"),
        content: renderHomebrewCask({
          token: "traycer-desktop",
          version,
          homepage,
          macArm,
          macX64,
          linuxX64AppImage,
        }),
      });
    }
    caskOutputs.push(
      {
        manager: "homebrew-cask-versioned",
        path: path.join(
          staging,
          "homebrew",
          "Casks",
          `traycer-desktop@${versionedCaskVersion}.rb`,
        ),
        content: renderHomebrewCask({
          token: `traycer-desktop@${versionedCaskVersion}`,
          version,
          homepage,
          macArm,
          macX64,
          linuxX64AppImage,
        }),
      },
    );
    for (const output of caskOutputs) {
      writeFile(output.path, output.content);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          version,
          written: caskOutputs.map((output) => ({
            manager: output.manager,
            path: output.path,
            sha256: sha256OfString(output.content),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const managers = selectedManagers(args.managers);
  const homebrewVersionedOnlyBackfill =
    args.homebrewVersionedOnly === true &&
    managers.size === 1 &&
    managers.has("homebrew");
  const descriptors = (args.descriptors || []).map(readDescriptor);
  if (descriptors.length === 0) {
    throw new Error("At least one --descriptor must be supplied");
  }
  const byPlatform = descriptorsByPlatform(descriptors);
  fs.mkdirSync(staging, { recursive: true });

  const summary = { version, written: [] };

  // ----- Homebrew -----
  if (managers.has("homebrew")) {
    const versionedFormulaVersion = homebrewExactVersionTokenSuffix(version);
    const formulaOutputs = [];
    if (args.homebrewVersionedOnly !== true) {
      formulaOutputs.push({
        manager: "homebrew",
        path: path.join(staging, "homebrew", "Formula", "traycer.rb"),
        content: renderHomebrewFormula({
          version,
          className: "Traycer",
          kegOnly: false,
          byPlatform,
          homepage,
          license,
          releaseNotesUrl,
        }),
      });
    }
    formulaOutputs.push(
      {
        manager: "homebrew-versioned",
        path: path.join(
          staging,
          "homebrew",
          "Formula",
          `traycer@${versionedFormulaVersion}.rb`,
        ),
        content: renderHomebrewFormula({
          version,
          className: homebrewVersionedClassName(versionedFormulaVersion),
          kegOnly: true,
          byPlatform,
          homepage,
          license,
          releaseNotesUrl,
        }),
      },
    );
    for (const output of formulaOutputs) {
      writeFile(output.path, output.content);
      summary.written.push({
        manager: output.manager,
        path: output.path,
        sha256: sha256OfString(output.content),
      });
    }
  }

  // ----- winget -----
  if (managers.has("winget")) {
    const wingetFiles = renderWingetManifests({
      version,
      byPlatform,
      homepage,
      license,
      releaseNotesUrl,
    });
    const wingetDir = path.join(
      staging,
      "winget",
      "manifests",
      "t",
      "Traycer",
      "CLI",
      version,
    );
    for (const [name, content] of Object.entries(wingetFiles)) {
      const p = path.join(wingetDir, name);
      writeFile(p, content);
      summary.written.push({
        manager: "winget",
        path: p,
        sha256: sha256OfString(content),
      });
    }
  }

  // ----- scoop -----
  if (managers.has("scoop")) {
    const scoop = renderScoopManifest({
      version,
      byPlatform,
      homepage,
      license,
      releaseNotesUrl,
      releaseRepo,
    });
    const scoopPath = path.join(staging, "scoop", "bucket", "traycer-cli.json");
    const scoopContent = `${JSON.stringify(scoop, null, 2)}\n`;
    writeFile(scoopPath, scoopContent);
    summary.written.push({
      manager: "scoop",
      path: scoopPath,
      sha256: sha256OfString(scoopContent),
    });
  }

  // ----- deb + rpm metadata -----
  if (managers.has("deb-rpm")) {
    const debRpm = renderDebRpmMetadata({
      version,
      byPlatform,
      homepage,
      license,
      releaseNotesUrl,
    });
    const debRpmPath = path.join(
      staging,
      "deb-rpm",
      "versions",
      `${version}.json`,
    );
    const debRpmContent = `${JSON.stringify(debRpm, null, 2)}\n`;
    writeFile(debRpmPath, debRpmContent);
    summary.written.push({
      manager: "deb-rpm",
      path: debRpmPath,
      sha256: sha256OfString(debRpmContent),
    });
  }

  // Only a true Homebrew-only backfill should avoid advancing the shared feed.
  if (homebrewVersionedOnlyBackfill !== true) {
    // ----- CLI versions.json (used by scoop's checkver + Desktop probe) -----
    const cliVersions = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      latest: version,
      version,
      platforms: byPlatform,
      releaseNotesUrl,
    };
    const cliVersionsPath = path.join(staging, "cli", "versions.json");
    const cliVersionsContent = `${JSON.stringify(cliVersions, null, 2)}\n`;
    writeFile(cliVersionsPath, cliVersionsContent);
    summary.written.push({
      manager: "cli-versions",
      path: cliVersionsPath,
      sha256: sha256OfString(cliVersionsContent),
    });
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `[publish-cli-package-managers] ${err && err.message ? err.message : err}\n`,
  );
  process.exit(1);
}
