"use strict";

// Repro/regression gate for the win32 SEA exit-teardown abort (int#4840,
// field: OSS #955 and #995, both 1.1.9 win32):
//
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
//
// The CLI printed its complete `host available --json` document and THEN died
// with that assertion, so the operation succeeded and the exit code said it
// failed. `assert(!(handle->flags & UV_HANDLE_CLOSING))` lives inside
// `uv_async_send()`; libuv's POSIX `uv_async_send` carries no such assertion,
// which is why this reproduces on Windows and nowhere else.
//
// It is a teardown RACE, so a single run proves nothing - this loops.
//
// A separate fixture process serves a signed feed while the synchronous loop
// runs. Only a temporary SEA is stamped for it; the ordinary build and source
// must retain their original bytes. The gate needs HTTP teardown and terminal
// output, not a live release or a successful production cutover.

const { fork, spawnSync } = require("node:child_process");
const { createServer } = require("node:http");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");
const path = require("node:path");

const workspaceRoot = path.resolve(__dirname, "..");
const binaryName = process.platform === "win32" ? "traycer.exe" : "traycer";
const binaryPath = path.join(workspaceRoot, "dist-sea", binaryName);

// Every iteration is a full process spawn + an HTTP registry fetch. The org
// caps CI jobs at ten minutes and the SEA build eats most of it, so keep the
// default modest and let the workflow raise it via the env var.
const DEFAULT_ITERATIONS = 15;

function fail(msg) {
  console.error(`[cli exit-code] FAIL: ${msg}`);
  process.exit(1);
}

function resolveIterations() {
  const raw = process.env.TRAYCER_CLI_EXIT_ITERATIONS;
  if (typeof raw !== "string" || raw.length === 0) return DEFAULT_ITERATIONS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(
      `TRAYCER_CLI_EXIT_ITERATIONS must be a positive integer, got '${raw}'`,
    );
  }
  return parsed;
}

// The runner emits NDJSON: zero or more `progress` lines then exactly one
// terminal line. Mirrors `extractTerminalEnvelope` in
// clients/desktop/src/electron-main/cli/traycer-cli.ts - this gate has to
// agree with the consumer about what "the CLI succeeded" means.
function terminalStatus(stdout) {
  let status = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    if (parsed.type !== "result") continue;
    // A pre-runner CLI emitted a bare `{type:"result", data:...}`; absent
    // `status` reads as ok, same as the desktop parser.
    status = typeof parsed.status === "string" ? parsed.status : "ok";
  }
  return status;
}

async function main() {
  if (!fs.existsSync(binaryPath)) {
    fail(
      `${binaryPath} not found. Run \`bun run --filter @traycer-clients/traycer-cli build:sea\` first.`,
    );
  }

  const fixture = await createFixture();
  process.once("exit", fixture.cleanup);
  try {
    const iterations = resolveIterations();
    let okEnvelopes = 0;
    let fetchFailures = 0;

    for (let i = 1; i <= iterations; i += 1) {
      const result = spawnSync(
        fixture.binaryPath,
        ["host", "available", "--json"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: fixture.home,
            USERPROFILE: fixture.home,
          },
        },
      );
      if (result.error) {
        fail(
          `iteration ${i}/${iterations}: failed to spawn ${binaryPath}: ${result.error.message || result.error}`,
        );
      }
      const stdout = result.stdout || "";
      const stderr = result.stderr || "";

      // Unconditional: no healthy exit path ever prints a libuv assertion,
      // whatever the exit code ended up being.
      if (stderr.includes("Assertion failed")) {
        fail(
          `iteration ${i}/${iterations}: libuv assertion on stderr (exit=${result.status})\n${stderr.trim()}`,
        );
      }

      const status = terminalStatus(stdout);
      if (status === "ok") {
        okEnvelopes += 1;
        if (result.status !== 0) {
          fail(
            `iteration ${i}/${iterations}: the CLI emitted a successful terminal envelope but exited ${result.status} - ` +
              `the work completed and the exit code reported failure.\nstderr: ${stderr.trim()}`,
          );
        }
        continue;
      }
      // No terminal ok: either the registry fetch genuinely failed (error
      // envelope) or the process died before emitting one. The first is not
      // this gate's business; the second is already covered by the assertion
      // check above, so just account for it and keep going.
      fetchFailures += 1;
    }

    if (okEnvelopes === 0) {
      fail(
        `no iteration produced a successful terminal envelope across ${iterations} runs - ` +
          `the registry was unreachable for the whole job, so this gate proved nothing.`,
      );
    }

    console.log(
      `[cli exit-code] OK platform=${process.platform} arch=${process.arch} ` +
        `iterations=${iterations} clean-exits=${okEnvelopes} fetch-failures=${fetchFailures}`,
    );
  } finally {
    process.removeListener("exit", fixture.cleanup);
    fixture.cleanup();
  }
}

async function serveFixture() {
  const { makeKey, makeSignatureFile } = await import(
    pathToFileURL(
      path.join(
        workspaceRoot,
        "src",
        "registry",
        "__tests__",
        "minisign-test-helpers.ts",
      ),
    ).href
  );
  const key = makeKey();
  const generatedAt = Date.now();
  const payload = JSON.stringify({
    schemaVersion: 2,
    feed: "host",
    target: "production",
    policyRevision: 1,
    policyDigest: "a".repeat(64),
    generatedAt: new Date(generatedAt).toISOString(),
    expiresAt: new Date(generatedAt + 24 * 60 * 60 * 1000).toISOString(),
    latest: "1.0.0",
    versions: [
      {
        version: "1.0.0",
        releasedAt: new Date(generatedAt).toISOString(),
        releaseNotesUrl: "https://example.invalid/fixture",
        yanked: false,
        deprecationReason: null,
        requiredCliVersion: null,
        platforms: {},
      },
    ],
  });
  const body = JSON.stringify({
    payload,
    signature: makeSignatureFile({
      message: Buffer.from(payload, "utf8"),
      key,
      trustedComment: "exit-code smoke fixture",
      prehashed: true,
    }),
    keyId: key.trustedPublicKey.keyId,
  });
  const server = createServer((request, response) => {
    if (request.url !== "/host/versions.signed.json") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  process.once("disconnect", () => {
    server.closeAllConnections();
    server.close();
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("fixture origin did not bind");
    if (process.send === undefined)
      throw new Error("fixture origin requires an IPC parent");
    process.send({
      url: `http://127.0.0.1:${address.port}`,
      publicKey: key.trustedPublicKey.raw,
    });
  });
}

async function createFixture() {
  const root = fs.mkdtempSync(
    path.join(tmpdir(), "traycer-exit-code-fixture-"),
  );
  const child = fork(__filename, ["--serve-fixture"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const cleanup = () => {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    const origin = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("fixture origin startup timed out")),
        10_000,
      );
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`fixture origin exited ${code}`));
      });
      child.once("message", (message) => {
        clearTimeout(timeout);
        if (
          message === null ||
          typeof message !== "object" ||
          typeof message.url !== "string" ||
          typeof message.publicKey !== "string"
        ) {
          reject(new Error("fixture origin returned invalid coordinates"));
          return;
        }
        resolve(message);
      });
    });
    const configPath = path.join(workspaceRoot, "src", "config.ts");
    const sourceBytes = fs.readFileSync(configPath);
    const source = sourceBytes.toString("utf8");
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const restore = () => {
      fs.writeFileSync(configPath, sourceBytes);
      const restoredHash = createHash("sha256")
        .update(fs.readFileSync(configPath))
        .digest("hex");
      if (restoredHash !== sourceHash)
        throw new Error("fixture config restore changed its sha256");
    };
    const onSignal = (code) => {
      try {
        cleanup();
      } finally {
        restore();
        process.exit(code);
      }
    };
    const onInterrupt = () => onSignal(130);
    const onTerminate = () => onSignal(143);
    const originalBinary = fs.readFileSync(binaryPath);
    const fixtureBinary = path.join(root, binaryName);
    const stamped = source
      .replace(
        /(releaseCdnBaseUrl:\s*)"[^"]*"/,
        `$1${JSON.stringify(origin.url)}`,
      )
      .replace(
        /(hostTrustedPubkeys:\s*)\[[\s\S]*?\](\s+as readonly string\[\])/,
        `$1[${JSON.stringify(origin.publicKey)}]$2`,
      );
    if (
      stamped === source ||
      !stamped.includes(origin.url) ||
      !stamped.includes(origin.publicKey)
    )
      throw new Error("fixture config stamp failed");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    try {
      fs.writeFileSync(configPath, stamped, "utf8");
      const {
        bundleCjs,
        buildSingleSeaExecutable,
      } = require("../../../scripts/native-packaging/sea-toolchain.cjs");
      const bundleFile = path.join(root, "fixture-bundle.cjs");
      await bundleCjs({
        entry: path.join(workspaceRoot, "src", "index.ts"),
        outfile: bundleFile,
        tsconfig: path.join(workspaceRoot, "tsconfig.json"),
        externals: ["bun:sqlite"],
        bannerJs: "",
        cwd: workspaceRoot,
        defines: {},
        sourcemap: false,
        plugins: [],
      });
      const bundle = fs
        .readFileSync(bundleFile, "utf8")
        .replace(/^#![^\n]*\n/, "");
      fs.writeFileSync(bundleFile, `"use strict";\n${bundle}`, "utf8");
      buildSingleSeaExecutable({
        workDir: workspaceRoot,
        bundleFile,
        configFile: path.join(root, "sea-config.json"),
        blobFile: path.join(root, "sea-prep.blob"),
        outputBinary: fixtureBinary,
        assets: null,
      });
    } finally {
      try {
        restore();
      } finally {
        process.removeListener("SIGINT", onInterrupt);
        process.removeListener("SIGTERM", onTerminate);
      }
    }
    if (!fs.readFileSync(binaryPath).equals(originalBinary))
      throw new Error("fixture build changed the ordinary SEA");
    const fixtureBytes = fs.readFileSync(fixtureBinary);
    for (const marker of [origin.url, origin.publicKey]) {
      if (
        !fixtureBytes.includes(marker) ||
        originalBinary.includes(marker) ||
        fs.readFileSync(configPath, "utf8").includes(marker) ||
        fs
          .readFileSync(path.join(workspaceRoot, "dist-sea", "cli-bundle.cjs"))
          .includes(marker)
      ) {
        throw new Error("fixture URL/key isolation check failed");
      }
    }
    console.log(
      "[cli exit-code] fixture isolation verified: only the temporary SEA carries its URL and key",
    );
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    return { binaryPath: fixtureBinary, home, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

if (process.argv.includes("--serve-fixture")) {
  serveFixture().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  main().catch((error) => {
    console.error(`[cli exit-code] FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
