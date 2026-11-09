#!/usr/bin/env node
"use strict";

// Deliberately dependency-free: this runs before Bun, Python or npm install.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function readLock(lockPath) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.artifacts)) {
    throw new Error("Unsupported CI tools lock");
  }
  const keys = new Set();
  for (const entry of lock.artifacts) {
    if (
      !/^[a-z0-9][a-z0-9-]*$/.test(entry.name) ||
      !/^[a-zA-Z0-9._+-]+$/.test(entry.version) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !secureOrigin(entry.upstreamUrl) ||
      !["linux", "darwin", "win32", "any"].includes(entry.os) ||
      !["x64", "arm64", "any"].includes(entry.arch)
    ) {
      throw new Error("Malformed CI tools lock entry");
    }
    const filename = decodeURIComponent(
      new URL(entry.upstreamUrl).pathname.split("/").at(-1),
    );
    if (!/^[a-zA-Z0-9._+-]+$/.test(filename)) {
      throw new Error(`Unsafe CI tool filename: ${entry.name}`);
    }
    const key = objectKey(entry);
    if (keys.has(key)) throw new Error(`Duplicate mirror object: ${key}`);
    keys.add(key);
  }
  for (const hook of lock.hookEnvironments || []) {
    if (
      !/^[a-f0-9]{64}$/.test(hook.configSha256) ||
      !/^[a-f0-9]{64}$/.test(hook.sha256) ||
      !Number.isSafeInteger(hook.bytes) ||
      hook.bytes <= 0 ||
      !/^\d+$/.test(String(hook.prepareRunId)) ||
      hook.os !== "linux" ||
      hook.arch !== "x64" ||
      hook.objectKey !==
        `tools/pre-commit-hooks/${hook.configSha256}/hooks-${hook.configSha256}-linux-x64.tar.gz`
    ) {
      throw new Error("Malformed prepared hook environment lock");
    }
  }
  return lock;
}

function secureOrigin(url) {
  const parsed = new URL(url);
  return (
    !parsed.username &&
    !parsed.password &&
    (parsed.protocol === "https:" ||
      (parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))
  );
}

function objectKey(entry) {
  return `tools/${entry.name}/${entry.version}/${decodeURIComponent(new URL(entry.upstreamUrl).pathname.split("/").at(-1))}`;
}

function sha256(filename) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filename))
    .digest("hex");
}

function download(entry, destination, mirror) {
  if (mirror !== null && !secureOrigin(mirror))
    throw new Error("Unsafe CI mirror origin");
  const stage = `${destination}.partial`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  for (const [origin, url, seconds] of [
    ...(mirror === null
      ? []
      : [["mirror", `${mirror.replace(/\/$/, "")}/${objectKey(entry)}`, 30]]),
    ["upstream", entry.upstreamUrl, 180],
  ]) {
    try {
      execFileSync(
        "curl",
        [
          "--fail",
          "--silent",
          "--show-error",
          "--location",
          "--connect-timeout",
          "10",
          "--max-time",
          String(seconds),
          "--output",
          stage,
          url,
        ],
        { stdio: ["ignore", "ignore", "pipe"], timeout: (seconds + 5) * 1000 },
      );
      if (sha256(stage) !== entry.sha256) throw new Error("SHA-256 mismatch");
      fs.renameSync(stage, destination);
      console.log(
        `[ci-tools] ${entry.name} ${entry.version} verified (${origin})`,
      );
      return url;
    } catch (error) {
      fs.rmSync(stage, { force: true });
      // Never forward curl stderr: a transport's response may include credentials.
      console.log(
        `[ci-tools] ${entry.name}: ${origin} failed verification or transport`,
      );
      if (origin === "upstream") {
        throw new Error(`Both origins failed for ${objectKey(entry)}`, {
          cause: error,
        });
      }
    }
  }
}

function select(lock, name, platform, arch) {
  const entries = lock.artifacts.filter(
    (entry) =>
      entry.name === name &&
      entry.role !== "metadata" &&
      (entry.os === platform || entry.os === "any") &&
      (entry.arch === arch || entry.arch === "any"),
  );
  if (entries.length !== 1) {
    throw new Error(
      `Expected one locked ${name} for ${platform}/${arch}, found ${entries.length}`,
    );
  }
  return entries[0];
}

function downloadHookArchive(hook, destination, mirror) {
  if (!mirror || !secureOrigin(mirror))
    throw new Error(
      "A verified hook archive requires an explicit mirror origin",
    );
  const origin = new URL(mirror);
  if (origin.search || origin.hash)
    throw new Error("Hook mirror origin cannot contain a query or fragment");
  const stage = `${destination}.partial`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    execFileSync(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--connect-timeout",
        "10",
        "--max-time",
        "180",
        "--output",
        stage,
        `${mirror.replace(/\/$/, "")}/${hook.objectKey}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 185000 },
    );
    if (fs.statSync(stage).size !== hook.bytes)
      throw new Error("Hook archive byte size mismatch");
    if (sha256(stage) !== hook.sha256)
      throw new Error("Hook archive SHA-256 mismatch");
    fs.renameSync(stage, destination);
  } finally {
    fs.rmSync(stage, { force: true });
  }
}

function downloadLockedUrl(lock, url, destination) {
  const entry = lock.artifacts.find(
    (candidate) => decodeURI(candidate.upstreamUrl) === decodeURI(url),
  );
  if (!entry)
    throw new Error(
      `GitHub acquisition is absent from tools-mirror.lock.json: ${url}`,
    );
  download(entry, destination, process.env.CI_TOOLS_MIRROR || null);
  append(process.env.GITHUB_OUTPUT, `${entry.name}=executed`);
}

function append(filename, value) {
  if (filename) fs.appendFileSync(filename, `${value}\n`);
}

function install(entry, archive, root) {
  const python = entry.name === "python-311" || entry.name === "python-312";
  const destination = python
    ? "/opt/traycer-ci/python"
    : path.join(root, entry.name, entry.sha256);
  const bin = entry.bin
    ? path.resolve(
        destination,
        python
          ? "bin"
          : entry.bin.replace(
              "{arch}",
              process.arch === "x64" ? "x86_64" : "aarch64",
            ),
      )
    : null;
  if (
    bin !== null &&
    bin !== destination &&
    !bin.startsWith(`${destination}${path.sep}`)
  ) {
    throw new Error(`Unsafe tool bin path: ${entry.name}`);
  }
  if (
    entry.name === "node" &&
    bin !== null &&
    path.resolve(process.execPath) === path.join(bin, entry.executable)
  ) {
    // Windows cannot replace the interpreter currently executing this action.
    append(process.env.GITHUB_PATH, bin);
    return destination;
  }
  if (python) {
    execFileSync("sudo", ["mkdir", "-p", "/opt/traycer-ci"], {
      stdio: "inherit",
    });
    execFileSync(
      "sudo",
      ["chown", `${process.getuid()}:${process.getgid()}`, "/opt/traycer-ci"],
      { stdio: "inherit" },
    );
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  if (entry.kind === "zip") {
    // tar on Windows is bsdtar, which also reads ZIP; macOS/Linux use unzip.
    if (process.platform === "win32") {
      if (!process.env.SystemRoot)
        throw new Error("Windows system directory is missing");
      const tar = path.join(process.env.SystemRoot, "System32", "tar.exe");
      execFileSync(tar, ["-xf", archive, "-C", destination], {
        stdio: "inherit",
      });
    } else {
      execFileSync("unzip", ["-q", archive, "-d", destination], {
        stdio: "inherit",
      });
    }
  } else if (entry.kind === "tar.gz") {
    execFileSync(
      "tar",
      [
        "-xzf",
        archive,
        "-C",
        destination,
        ...(python ? ["--strip-components=1"] : []),
      ],
      { stdio: "inherit" },
    );
  } else if (entry.kind === "file") {
    fs.copyFileSync(archive, path.join(destination, entry.executable));
    fs.chmodSync(path.join(destination, entry.executable), 0o755);
  } else {
    throw new Error(`Unsupported archive: ${entry.name}`);
  }
  if (bin !== null) {
    if (entry.name === "bun") {
      const binary = path.join(
        bin,
        process.platform === "win32" ? "bun.exe" : "bun",
      );
      const alias = path.join(
        bin,
        process.platform === "win32" ? "bunx.exe" : "bunx",
      );
      fs.accessSync(binary, fs.constants.X_OK);
      fs.rmSync(alias, { force: true });
      if (process.platform === "win32") fs.linkSync(binary, alias);
      else fs.symlinkSync("bun", alias);
    }
    append(process.env.GITHUB_PATH, bin);
  }
  return destination;
}

function main(args) {
  const [command, lockPath, ...names] = args;
  const lock = readLock(lockPath);
  const bunVersion = process.env.CI_TOOLS_BUN_VERSION;
  if (
    bunVersion &&
    !lock.artifacts.some(
      (entry) => entry.name === "bun" && entry.version === bunVersion,
    )
  ) {
    throw new Error("Bun version does not match CI tool lock");
  }
  if (command === "cache-paths") {
    append(process.env.GITHUB_OUTPUT, `lock-digest=${sha256(lockPath)}`);
    if (!names.every((name) => /^[a-z0-9-]+$/.test(name)))
      throw new Error("Invalid tool cache name");
    const paths = names.map((name) =>
      path.join(process.env.CI_TOOLS_CACHE, "archives", name),
    );
    if (process.env.CI_TOOLS_BYPASS_CACHE === "true") {
      for (const directory of paths)
        fs.rmSync(directory, { recursive: true, force: true });
    }
    append(
      process.env.GITHUB_OUTPUT,
      `paths<<CI_TOOL_PATHS\n${paths.join("\n")}\nCI_TOOL_PATHS`,
    );
    return;
  }
  if (command === "list") {
    for (const entry of lock.artifacts)
      console.log(`${objectKey(entry)}\t${entry.sha256}\t${entry.upstreamUrl}`);
    return;
  }
  if (command === "fetch") {
    downloadLockedUrl(lock, names[0], names[1]);
    append(process.env.GITHUB_OUTPUT, "executed=true");
    return;
  }
  if (command !== "install")
    throw new Error(`Unknown CI tools command: ${command}`);
  const cache =
    process.env.CI_TOOLS_CACHE || path.join(os.tmpdir(), "traycer-ci-tools");
  const mirror = process.env.CI_TOOLS_MIRROR || null;
  if (mirror !== null) {
    if (!secureOrigin(mirror)) throw new Error("Unsafe CI mirror origin");
    const origin = new URL(mirror);
    if (origin.search || origin.hash)
      throw new Error("CI mirror base URL cannot carry a query or fragment");
    append(
      process.env.GITHUB_ENV,
      `CI_TOOLS_MIRROR=${origin.toString().replace(/\/$/, "")}`,
    );
  } else {
    append(process.env.GITHUB_ENV, "CI_TOOLS_MIRROR=");
  }
  // The macOS packaging gate packs both desktop architectures in one job.
  const requests = names.flatMap((name) =>
    name === "electron" && process.platform === "darwin"
      ? ["electron:x64", "electron:arm64"]
      : [name],
  );
  for (const request of requests) {
    const [name, requestedArch] = request.split(":");
    if (name === "hooks") {
      const configSha256 = sha256(".pre-commit-config.yaml");
      const home = `/opt/traycer-ci/hooks/${configSha256}`;
      append(process.env.GITHUB_ENV, `PRE_COMMIT_HOME=${home}`);
      const hook = (lock.hookEnvironments || []).find(
        (candidate) =>
          candidate.configSha256 === configSha256 &&
          candidate.os === process.platform &&
          candidate.arch === process.arch,
      );
      let source = "fallback";
      if (hook && mirror) {
        const archive = path.join(
          cache,
          "archives",
          "hooks",
          `${hook.sha256}-hooks.tar.gz`,
        );
        try {
          fs.mkdirSync(path.dirname(archive), { recursive: true });
          const cached =
            fs.existsSync(archive) &&
            fs.statSync(archive).size === hook.bytes &&
            sha256(archive) === hook.sha256;
          if (!cached) downloadHookArchive(hook, archive, mirror);
          execFileSync("tar", ["-xzf", archive, "-C", "/opt/traycer-ci"], {
            stdio: "inherit",
          });
          source = cached ? "cache" : "mirror";
        } catch {
          fs.rmSync(archive, { force: true });
          // pre-commit builds environments at the config's pinned revisions.
          fs.rmSync(home, { recursive: true, force: true });
        }
      }
      console.log(`[ci-tools] hooks executed (${source})`);
      append(process.env.GITHUB_OUTPUT, `hooks=${source}`);
      continue;
    }
    const entry = select(
      lock,
      name,
      process.platform,
      requestedArch || process.arch,
    );
    const archive = path.join(
      cache,
      "archives",
      name,
      `${entry.sha256}-${path.basename(objectKey(entry))}`,
    );
    // A restored archive is untrusted until its digest is checked again.
    let archiveOrigin = "cache";
    if (!fs.existsSync(archive) || sha256(archive) !== entry.sha256) {
      const source = download(entry, archive, mirror);
      archiveOrigin = source === entry.upstreamUrl ? "upstream" : "mirror";
    } else {
      console.log(`[ci-tools] ${name} verified (cache)`);
    }
    if (entry.kind === "electron") {
      const metadata = lock.artifacts.find(
        (candidate) =>
          candidate.name === "electron" &&
          candidate.version === entry.version &&
          candidate.role === "metadata",
      );
      if (!metadata)
        throw new Error("Electron checksum metadata is missing from the lock");
      const metadataPath = path.join(
        cache,
        `${metadata.sha256}-SHASUMS256.txt`,
      );
      const source = download(metadata, metadataPath, mirror);
      const remote = new URL(source);
      remote.pathname = path.posix.dirname(remote.pathname);
      const cacheKey = crypto
        .createHash("sha256")
        .update(remote.toString())
        .digest("hex");
      const electronCache = path.join(cache, "electron");
      fs.mkdirSync(path.join(electronCache, cacheKey), { recursive: true });
      fs.copyFileSync(
        archive,
        path.join(electronCache, cacheKey, path.basename(objectKey(entry))),
      );
      fs.copyFileSync(
        metadataPath,
        path.join(electronCache, cacheKey, path.basename(objectKey(metadata))),
      );
      append(process.env.GITHUB_ENV, `electron_config_cache=${electronCache}`);
      append(process.env.GITHUB_ENV, `ELECTRON_CACHE=${electronCache}`);
      append(
        process.env.GITHUB_ENV,
        `ELECTRON_MIRROR=${remote.origin}${path.posix.dirname(remote.pathname)}/`,
      );
      append(
        process.env.GITHUB_ENV,
        `ELECTRON_CUSTOM_DIR=${path.posix.basename(remote.pathname)}`,
      );
    } else {
      install(entry, archive, path.join(cache, "installed"));
    }
    append(process.env.GITHUB_OUTPUT, `${name}=executed`);
    if (name === "bun")
      append(process.env.GITHUB_OUTPUT, `bun-origin=${archiveOrigin}`);
  }
  append(process.env.GITHUB_OUTPUT, "executed=true");
}

module.exports = {
  readLock,
  objectKey,
  download,
  downloadLockedUrl,
  downloadHookArchive,
  sha256,
  install,
};
if (require.main === module) main(process.argv.slice(2));
