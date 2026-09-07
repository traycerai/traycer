"use strict";

// Shared Node SEA toolchain helpers used by the CLI and host production build scripts.

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// The fuse sentinel + Mach-O segment name come straight from the official Node SEA docs - they are part of the platform contract, not a knob.
const SEA_FUSE_SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// Guard: every step in this toolchain - `--experimental-sea-config`, host-binary copy, postject injection - uses `process.execPath` to refer to the running interpreter.
// Detection is best-effort and runtime-only: we look for Bun-injected globals that Node never sets.
function assertRunningUnderNode() {
  const looksLikeBun =
    typeof globalThis.Bun !== "undefined" ||
    typeof process.versions.bun === "string";
  if (looksLikeBun) {
    throw new Error(
      "Native SEA build scripts must run under Node, not Bun. " +
        "`process.execPath` is used as the SEA host binary and as the target " +
        "of `--experimental-sea-config`; running under Bun produces a broken " +
        "artifact. Invoke the script as `node scripts/...cjs` (or via the " +
        "`build:sea` package script which now uses Node).",
    );
  }
}

function repoRoot() {
  return REPO_ROOT;
}

function currentPlatformArch() {
  return { platform: process.platform, arch: process.arch };
}

function exeName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function rimraf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

function resolveEsbuildBin() {
  // Prefer `require.resolve` so the build script honors the repo's pinned
  // esbuild rather than whatever happens to be on path.
  return require.resolve("esbuild/bin/esbuild", { paths: [REPO_ROOT] });
}

function resolvePostjectBin() {
  // postject ships as a CLI under `dist/cli.js`.
  // We resolve it programmatically so we don't depend on a globally installed npx/bunx shim; if the package hasn't been installed yet we surface a useful error.
  try {
    return require.resolve("postject/dist/cli.js", { paths: [REPO_ROOT] });
  } catch (err) {
    throw new Error(
      "postject is not installed. Run `bun install` from the repo root to fetch it. " +
        `Underlying error: ${err && err.message ? err.message : err}`,
    );
  }
}

// Bundle `entry` with esbuild into a single cjs file at `outfile`.
function bundleCjs({
  entry,
  outfile,
  tsconfig,
  externals,
  bannerJs,
  defines,
  cwd,
  plugins,
  sourcemap,
}) {
  ensureDir(path.dirname(outfile));

  const buildOptions = {
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile,
    external: externals,
    absWorkingDir: cwd || REPO_ROOT,
    // Sentry's proxy module emits this warning for entry points with no default export (e.g. main-sea.ts).
    // The proxy is never imported for its default, so the warning is noise.
    logOverride: { "import-is-undefined": "silent" },
  };
  if (tsconfig) {
    buildOptions.tsconfig = tsconfig;
  }
  if (defines) {
    buildOptions.define = defines;
  }
  if (bannerJs && bannerJs.length > 0) {
    buildOptions.banner = { js: bannerJs };
  }
  if (sourcemap) {
    buildOptions.sourcemap = sourcemap;
  }
  if (Array.isArray(plugins) && plugins.length > 0) {
    buildOptions.plugins = plugins;
  }
  return esbuild.build(buildOptions);
}

// Write the `sea-config.json` used by `node --experimental-sea-config`.
function writeSeaConfig({ mainBundle, outputBlob, assets, configPath }) {
  const seaConfig = {
    main: mainBundle,
    output: outputBlob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  if (assets && Object.keys(assets).length > 0) {
    seaConfig.assets = assets;
  }
  ensureDir(path.dirname(configPath));
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(seaConfig, null, 2)}\n`,
    "utf8",
  );
}

// Scan a `node` binary for the SEA fuse sentinel.
// postject injects the blob by overwriting the bytes that follow this sentinel inside the host binary, so a binary that does not contain it cannot be used as a SEA host.
function nodeBinaryHasSeaFuse(binaryPath) {
  const sentinel = Buffer.from(SEA_FUSE_SENTINEL, "utf8");
  // Stream in chunks so we don't slurp a ~110 MB monolithic node into one Buffer; carry a sentinel-length overlap so a match that straddles a chunk boundary is still found.
  const fd = fs.openSync(binaryPath, "r");
  try {
    const chunkSize = 1 << 20; // 1 MiB
    const overlap = sentinel.length - 1;
    const buf = Buffer.alloc(chunkSize + overlap);
    let carry = 0;
    let position = 0;
    for (;;) {
      const bytesRead = fs.readSync(fd, buf, carry, chunkSize, position);
      if (bytesRead === 0) break;
      const filled = carry + bytesRead;
      if (buf.subarray(0, filled).includes(sentinel)) return true;
      carry = Math.min(overlap, filled);
      buf.copy(buf, 0, filled - carry, filled);
      position += bytesRead;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

// Map Node's `process.platform`/`process.arch` onto the nodejs.org dist download tuple.
// Only the tuples we actually build SEA artifacts on are listed; anything else throws with a directive to install official Node rather than silently downloading a tarball that won't exist.
function officialNodeDistTuple() {
  const platform = { darwin: "darwin", linux: "linux" }[process.platform];
  const arch = { arm64: "arm64", x64: "x64" }[process.arch];
  if (!platform || !arch) {
    throw new Error(
      `No official Node auto-provision path for ${process.platform}/${process.arch}. ` +
        "Install an official (statically-linked) Node - e.g. via nvm/fnm or the " +
        "nodejs.org installer - and re-run the build under it.",
    );
  }
  return { platform, arch };
}

// Download + extract the official monolithic Node matching the running version into the gitignored repo cache, returning the path to its `bin/node`.
// Idempotent: a cached, fuse-bearing binary is reused.
function provisionOfficialNode() {
  const { platform, arch } = officialNodeDistTuple();
  const version = process.version; // e.g. "v26.0.0"
  const distName = `node-${version}-${platform}-${arch}`;
  const cacheRoot = path.join(
    REPO_ROOT,
    "node_modules",
    ".cache",
    "traycer-sea-node",
  );
  const extractRoot = path.join(cacheRoot, `${version}-${platform}-${arch}`);
  const nodeBin = path.join(extractRoot, distName, "bin", "node");

  if (fs.existsSync(nodeBin) && nodeBinaryHasSeaFuse(nodeBin)) {
    return nodeBin;
  }

  ensureDir(extractRoot);
  const tarball = path.join(cacheRoot, `${distName}.tar.gz`);
  const url = `https://nodejs.org/dist/${version}/${distName}.tar.gz`;
  console.warn(
    `[sea] host '${process.execPath}' is not SEA-capable; downloading official Node ${version} (${platform}-${arch})`,
  );
  console.warn(`[sea]   ${url}`);
  const curl = spawnSync("curl", ["-fSL", "--retry", "3", "-o", tarball, url], {
    stdio: "inherit",
  });
  if (curl.status !== 0) {
    throw new Error(
      `Failed to download official Node from ${url} (curl exit ${curl.status}). ` +
        "Check network access or install official Node manually and re-run.",
    );
  }
  const untar = spawnSync("tar", ["-xzf", tarball, "-C", extractRoot], {
    stdio: "inherit",
  });
  if (untar.status !== 0) {
    throw new Error(`Failed to extract ${tarball} (tar exit ${untar.status}).`);
  }

  if (!fs.existsSync(nodeBin)) {
    throw new Error(
      `Extracted official Node but ${nodeBin} is missing - unexpected tarball layout.`,
    );
  }
  if (!nodeBinaryHasSeaFuse(nodeBin)) {
    throw new Error(
      `Downloaded official Node at ${nodeBin} still lacks the SEA fuse sentinel - ` +
        "this should not happen for an official build; aborting.",
    );
  }
  return nodeBin;
}

// Resolve a SEA-capable `node` to use as both the blob generator and the host binary we postject into.
// Only a non-capable host (Homebrew's shared build) triggers the one-time official-Node download.
function resolveSeaHostNode() {
  if (nodeBinaryHasSeaFuse(process.execPath)) {
    return process.execPath;
  }
  return provisionOfficialNode();
}

// Generate the SEA blob by invoking a SEA-capable Node binary with the SEA config.
function generateSeaBlob({ hostNode, configPath, cwd }) {
  execFileSync(hostNode, ["--experimental-sea-config", configPath], {
    cwd: cwd || REPO_ROOT,
    stdio: "inherit",
  });
}

// Copy the host Node binary to `destination`. SEA injects the bundle into
// a *copy* of `node` so the original interpreter remains untouched.
function copyHostNodeBinary({ hostNode, destination }) {
  ensureDir(path.dirname(destination));
  fs.copyFileSync(hostNode, destination);
  if (process.platform !== "win32") {
    fs.chmodSync(destination, 0o755);
  }
}

// macOS code-signs every Mach-O binary at build time; injecting a SEA blob invalidates the existing signature, so we strip it before postject and re-sign (ad-hoc for local builds, hardware identity in CI) after.
function macosRemoveSignature(target) {
  if (process.platform !== "darwin") return;
  const res = spawnSync("codesign", ["--remove-signature", target], {
    stdio: "inherit",
  });
  if (res.status !== 0) {
    // `codesign --remove-signature` returns non-zero when the file is unsigned, which is fine for a freshly copied binary on some hosts.
    // We log instead of throwing so the build keeps moving.
    console.warn(
      `[sea] codesign --remove-signature exited with status=${res.status}; continuing`,
    );
  }
}

// Windows: node.exe ships Authenticode-signed by the OpenJS Foundation.
// postject appends the SEA blob after the PE certificate table, leaving the existing signature malformed, so a later `signtool sign` rejects the binary with 0x800700C1 (ERROR_BAD_EXE_FORMAT).
function findWindowsSigntool() {
  const fromEnv = process.env.SIGNTOOL_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const sdkBin = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (!fs.existsSync(sdkBin)) return null;
  let found = null;
  for (const ver of fs.readdirSync(sdkBin).sort()) {
    const candidate = path.join(sdkBin, ver, "x64", "signtool.exe");
    if (fs.existsSync(candidate)) found = candidate; // sorted asc -> last is newest
  }
  return found;
}

function windowsRemoveSignature(target) {
  if (process.platform !== "win32") return;
  const signtool = findWindowsSigntool();
  if (!signtool) {
    console.warn(
      "[sea] signtool.exe not found; skipping Windows signature strip. A " +
        "later `signtool sign` on this postject'd binary may fail with 0x800700C1.",
    );
    return;
  }
  const res = spawnSync(signtool, ["remove", "/s", target], {
    stdio: "inherit",
  });
  if (res.status !== 0) {
    // Non-zero when the binary is already unsigned - fine for a fresh copy.
    console.warn(
      `[sea] signtool remove /s exited with status=${res.status}; continuing`,
    );
  }
}

// Inject the SEA blob into the copied host binary using postject.
// The fuse sentinel + Mach-O segment name come straight from the official Node SEA docs - they are part of the platform contract, not a knob.
function injectSeaBlob({ binary, blob }) {
  const args = [
    binary,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    SEA_FUSE_SENTINEL,
  ];
  if (process.platform === "darwin") {
    args.push("--macho-segment-name", "NODE_SEA");
  }
  execFileSync(process.execPath, [resolvePostjectBin(), ...args], {
    stdio: "inherit",
  });
}

// Re-sign the injected binary so macOS Gatekeeper can launch it.
// Ad-hoc signing (`-`) cannot be notarized and does not benefit from these flags, so we omit them in that path to keep local builds fast and offline.
const SEA_ENTITLEMENTS_PLIST = path.join(
  __dirname,
  "sea-entitlements.mac.plist",
);

function macosSignAdHoc(target) {
  if (process.platform !== "darwin") return;
  const identity = process.env.TRAYCER_MACOS_SIGN_IDENTITY || "-";
  const args = ["--sign", identity];
  if (identity !== "-") {
    // hardened runtime required for Apple notarization
    args.push("--options", "runtime", "--timestamp");
    // JIT entitlements required for the hardened V8 binary to launch.
    const entitlements =
      process.env.TRAYCER_MACOS_ENTITLEMENTS || SEA_ENTITLEMENTS_PLIST;
    if (!fs.existsSync(entitlements)) {
      throw new Error(
        `Hardened-runtime SEA sign requires an entitlements plist, but none ` +
          `was found at '${entitlements}'. A hardened V8 binary without ` +
          `com.apple.security.cs.allow-jit crashes at startup with "Failed ` +
          `to reserve virtual memory for CodeRange".`,
      );
    }
    args.push("--entitlements", entitlements);
  }
  args.push(target);
  const res = spawnSync("codesign", args, {
    stdio: "inherit",
  });
  if (res.status !== 0) {
    throw new Error(
      `codesign --sign ${identity} ${target} failed with status=${res.status}`,
    );
  }
}

// Stub for the platform signing/notarization hook used by release workflows.
// We invoke it after injection so the hook sees the final binary.
function runPlatformSignHook(target) {
  const hook = process.env.TRAYCER_SEA_SIGN_HOOK;
  if (!hook) return;
  const res = spawnSync(hook, [target], { stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(
      `TRAYCER_SEA_SIGN_HOOK (${hook}) failed for ${target} with status=${res.status}`,
    );
  }
}

// Build a single-executable SEA artifact end-to-end: 1.
function buildSingleSeaExecutable({
  workDir,
  bundleFile,
  configFile,
  blobFile,
  outputBinary,
  assets,
}) {
  assertRunningUnderNode();
  // The running interpreter is used to *drive* the build (postject, esbuild), but the SEA host - the binary we generate the blob with and postject into - must be a monolithic, fuse-bearing Node.
  const hostNode = resolveSeaHostNode();
  writeSeaConfig({
    mainBundle: bundleFile,
    outputBlob: blobFile,
    assets: assets || null,
    configPath: configFile,
  });
  generateSeaBlob({ hostNode, configPath: configFile, cwd: workDir });
  copyHostNodeBinary({ hostNode, destination: outputBinary });
  macosRemoveSignature(outputBinary);
  windowsRemoveSignature(outputBinary);
  injectSeaBlob({ binary: outputBinary, blob: blobFile });
  const signHook = process.env.TRAYCER_SEA_SIGN_HOOK;
  if (typeof signHook === "string" && signHook.length > 0) {
    // Hook owns signing - pass the freshly-injected binary directly.
    runPlatformSignHook(outputBinary);
  } else {
    macosSignAdHoc(outputBinary);
  }
}

// Recursive copy that follows the same rules as `cp -R src/.
function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dst);
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
    return;
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, stat.mode);
}

// Resolve a workspace dependency directory (e.g. `better-sqlite3`, `node-pty`) by walking `module.paths` from a known anchor and locating the directory that contains a `package.json` for `name`.
// We don't use `require.resolve(name)` because some packages (better-sqlite3) only expose their entry through the `bindings` module's lookup, not a clean `main` resolution.
function resolveDependencyDir(name, anchorDir) {
  const candidates = [
    path.join(anchorDir, "node_modules", name),
    path.join(REPO_ROOT, "node_modules", name),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(path.join(candidate, "package.json")).isFile()) {
        return candidate;
      }
    } catch {
      // try next
    }
  }
  throw new Error(
    `Unable to resolve dependency '${name}' from anchor '${anchorDir}'. ` +
      "Run `bun install` from the repo root before building SEA artifacts.",
  );
}

// `tar -czf` is the lowest-friction archive primitive across mac/linux; Windows builds skip the tarball and ship the directory verbatim (an msi/zip wrapper is the release workflow's job, not NP-3's).
function createTarball({ sourceDir, outputArchive }) {
  if (process.platform === "win32") {
    // Defer to release workflow tooling on Windows.
    return null;
  }
  ensureDir(path.dirname(outputArchive));
  const parent = path.dirname(sourceDir);
  const leaf = path.basename(sourceDir);
  execFileSync("tar", ["-czf", outputArchive, "-C", parent, leaf], {
    stdio: "inherit",
  });
  return outputArchive;
}

// Lightweight "this is what we just built" log line shared by both CLI
// and host build scripts so CI output stays uniform.
function logBuildSummary(label, summary) {
  const lines = Object.entries(summary).map(
    ([key, value]) => `  ${key}: ${value}`,
  );
  console.log(`\n[sea] ${label} build summary:`);
  for (const line of lines) console.log(line);
}

module.exports = {
  assertRunningUnderNode,
  repoRoot,
  currentPlatformArch,
  exeName,
  rimraf,
  ensureDir,
  resolveEsbuildBin,
  resolvePostjectBin,
  bundleCjs,
  writeSeaConfig,
  nodeBinaryHasSeaFuse,
  resolveSeaHostNode,
  provisionOfficialNode,
  generateSeaBlob,
  copyHostNodeBinary,
  macosRemoveSignature,
  windowsRemoveSignature,
  injectSeaBlob,
  macosSignAdHoc,
  runPlatformSignHook,
  buildSingleSeaExecutable,
  copyRecursive,
  resolveDependencyDir,
  createTarball,
  logBuildSummary,
  os,
};
