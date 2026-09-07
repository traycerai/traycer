import { randomUUID } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { attestLaunchdSupervisorPid } from "../lifecycle-probe";
import { parseBootstrapLogLine } from "../bootstrap-log";
import {
  interpretProbeMarker,
  type ProbeMarker,
  type ProbeSupervisorAttestation,
} from "@traycer-clients/shared/host-lifecycle";

/** Real-launchd scaffolding for macOS annex cases the in-process fakes cannot reproduce. */

const ENABLED = process.env.TRAYCER_RUN_REAL_SUPERVISOR_MACOS === "1";

/** `not-internal-checkout` used to be **computed and dropped**. `layer0Availability()` returned it, `assertRealLaunchdReady` pushed a problem only for `kind === "broken"`, and a repo-wide grep for the string found exactly two hits: the type declaration and the return statement. */
const LAYER0 = layer0Availability();
const LAYER0_MISSING = LAYER0.kind === "not-internal-checkout";
const REQUIRE_LAYER0 = process.env.TRAYCER_REQUIRE_LAYER0 === "1";

/** Setting the opt-in claims this machine can host the real-launchd rows. If it cannot, that is a failure, not a skip - a CI job that flips the opt-in on and then silently skips proves nothing, which is the exact defect the cutover verification standard §2 exists to remove. */
async function assertRealLaunchdReady(): Promise<void> {
  const problems: string[] = [];
  if (process.platform !== "darwin") {
    problems.push(
      `platform is "${process.platform}", but these rows drive launchd and ` +
        'require "darwin". Unset TRAYCER_RUN_REAL_SUPERVISOR_MACOS to skip ' +
        "them here, or run the job on a darwin runner.",
    );
  } else {
    const uid = String(process.getuid?.() ?? 0);
    const domain = await runCommand("launchctl", ["print", `gui/${uid}`])
      .then(() => true)
      .catch(() => false);
    if (!domain) {
      problems.push(
        `launchctl print gui/${uid} failed; a session without a reachable GUI ` +
          "domain cannot bootstrap LaunchAgents.",
      );
    }
    if (LAYER0.kind === "broken") problems.push(LAYER0.reason);
    if (LAYER0_MISSING && REQUIRE_LAYER0) {
      problems.push(
        "TRAYCER_REQUIRE_LAYER0=1 says this checkout must be able to contend " +
          `on the real Layer-0 lock, but ${layer0ModulePath()} does not ` +
          "exist. That module lives in the internal monorepo only. Either " +
          "this job is running in the OSS repository — where it cannot be " +
          "honoured and the variable must not be set — or the submodule " +
          "layout moved.",
      );
    }
    if (LAYER0_MISSING && !REQUIRE_LAYER0) {
      // Standard §8: report what did not run.
      // `process.stderr.write`, not `console.warn`: vitest's reporter swallows console output written from a hook** - measured, a `console.warn` here produced no output at all while a direct stderr write from the same hook printed.
      process.stderr.write(
        "\n[real-launchd] Layer-0 rows NOT EXECUTED: this is an OSS " +
          `checkout, and ${layer0ModulePath()} exists only in the internal ` +
          "monorepo. M9's real-lock decline and the layer0-status-fd " +
          "contract are UNEARNED here and are skipped, not passed. They run " +
          "in the internal repository's real-supervisor-internal.yml, which " +
          "sets TRAYCER_REQUIRE_LAYER0=1 so their absence fails there.\n\n",
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      [
        "TRAYCER_RUN_REAL_SUPERVISOR_MACOS=1 is set, but the real-launchd " +
          "annex rows cannot run on this machine:",
        ...problems.map((problem) => `  - ${problem}`),
      ].join("\n"),
    );
  }
}

let cleanupTargets: readonly string[] = [];

afterEach(async () => {
  for (const target of cleanupTargets) {
    await runCommand("launchctl", ["bootout", "--wait", target]).catch(
      () => undefined,
    );
  }
  cleanupTargets = [];
});

/** Teardown for a scoped launchd job, shared by every `withScoped*` helper so the two hazards below are answered once rather than re-derived per copy. A `throw` from `finally` REPLACES whatever the body was already throwing, so a teardown complaint would silently overwrite the actual row failure - the one thing the row exists to report. */
async function releaseScopedTarget(release: {
  readonly bodyCompleted: boolean;
  readonly leakDescription: string;
  readonly scratchDir: string;
  readonly target: string;
}): Promise<void> {
  const { bodyCompleted, leakDescription, scratchDir, target } = release;
  await runCommand("launchctl", ["bootout", "--wait", target]).catch(
    () => undefined,
  );
  const remainsLoaded = await runCommand("launchctl", ["print", target])
    .then(() => true)
    .catch(() => false);
  await rm(scratchDir, { recursive: true, force: true });
  if (!remainsLoaded) {
    cleanupTargets = cleanupTargets.filter((candidate) => candidate !== target);
    return;
  }
  if (bodyCompleted) {
    throw new Error(
      `${leakDescription} remained loaded after teardown: ${target}`,
    );
  }
}

describe.skipIf(!ENABLED)(
  "real macOS lifecycle supervisor — T6 spawn-probe/readiness/wedge (opt-in)",
  () => {
    beforeAll(async () => {
      await assertRealLaunchdReady();
    }, 60_000);

    it("M9: attests a real, still-alive scoped launchd job's pid — producer-side attestation succeeds while the job is alive", async () => {
      await withScopedJob(
        { sleepSeconds: "5", labelArgument: "matching" },
        async ({ label, pid }) => {
          const attestation = await attestLaunchdSupervisorPid(label, pid);
          expect(attestation).not.toBeNull();
          expect(attestation?.serviceLabel).toBe(label);
          expect(attestation?.supervisorPid).toBe(pid);
          expect(attestation?.capturedAt.length).toBeGreaterThan(0);
        },
      );
    });

    it.skipIf(LAYER0_MISSING)(
      "M9 (needs the internal checkout): a real label-bound supervisor consumes a real fd-3 Layer0 producer frame and leaves an attested marker for a later reconciler",
      async () => {
        await withScopedSupervisorProbe(
          { argvLabel: "matching" },
          async ({ label, marker, target }) => {
            if (marker === null)
              throw new Error("real supervisor did not write a probe marker");
            expect(marker.serviceLabel).toBe(label);
            expect(marker.attestation.serviceLabel).toBe(label);
            expect(marker.attestation.supervisorPid).toBe(marker.supervisorPid);
            expect(marker.outcome.kind).toBe("lock-declined");

            // The reconciler starts only after the supervisor is gone.
            // It must validate the producer's embedded attestation, never query this short-lived job after the fact.
            await runCommand("launchctl", ["bootout", "--wait", target]);
            const postExitPrint = await runCommand("launchctl", [
              "print",
              target,
            ])
              .then(() => "still-present")
              .catch(() => "gone");
            expect(postExitPrint).toBe("gone");
            expect(
              interpretProbeMarker({
                marker,
                transitionId: marker.transitionId,
                probeNonce: marker.probeNonce,
                expectedServiceLabel: label,
                readiness: { kind: "not-ready", attemptId: null },
              }),
            ).toEqual({ kind: "lock-declined" });
          },
        );
      },
      20_000,
    );

    /** The `--layer0-status-fd` contract, end to end. Both halves of this contract were verified against their own mock and never against each other: the host side proved "absent flag is a hard no-op" with a synthetic fd, and the supervisor side proved "the flag is passed exactly when the pipe is opened" with a synthetic host. */
    it.skipIf(LAYER0_MISSING)(
      "layer0-status-fd (needs the internal checkout): a host launched WITHOUT the flag writes nothing, even when fd 3 is a Node IPC channel",
      async () => {
        const result = await runLayer0Producer({ passStatusFdFlag: false });

        // The bug this row exists for: raw length-prefixed frames written into an fd 3 that belongs to someone else's protocol.
        // Node's IPC decoder dies on them with "Unable to deserialize cloned data", corrupting a channel the Layer-0 code does not own.
        expect(result.ipcMessages).toEqual([{ layer0ProducerFinished: true }]);
        expect(result.stderr).not.toContain("Unable to deserialize");
        expect(result.ipcError).toBeNull();
        expect(result.exitCode).toBe(0);
      },
      30_000,
    );

    /** The producer's frame is the CURRENT Layer-0 contract, not the one this row was written against. `unavailable` used to be a terminal outcome: no lock, no host. */
    it.skipIf(LAYER0_MISSING)(
      "layer0-status-fd (needs the internal checkout): the same host WITH the flag writes exactly one framed degraded record to the pipe it names",
      async () => {
        const result = await runLayer0Producer({ passStatusFdFlag: true });

        expect(result.framedPayloads.length).toBe(1);
        const frame: unknown = JSON.parse(result.framedPayloads[0] ?? "null");
        expect(frame).toMatchObject({
          attemptId: "status-fd-contract",
          layer0: "degraded",
          cause: "addon-load-failed",
        });
        expect(
          typeof (frame as { readonly evidence: unknown }).evidence === "string"
            ? (frame as { readonly evidence: string }).evidence.length
            : 0,
        ).toBeGreaterThan(0);
        expect(result.exitCode).toBe(0);
      },
      30_000,
    );

    it.skipIf(LAYER0_MISSING)(
      "M9 (needs the internal checkout): a real job whose argv label disagrees with its launchd label cannot produce an attested marker",
      async () => {
        await withScopedSupervisorProbe(
          { argvLabel: "mismatched" },
          async ({ label, marker }) => {
            expect(marker).toBeNull();
            // The registration remains scoped and untouched; absent evidence is
            // deliberately indeterminate rather than a fabricated mismatch.
            expect(label).toContain("ai.traycer.host.test.");
          },
        );
      },
      15_000,
    );

    it("M9: fast decline — attestation captured while the scoped, label-bound job is alive validates after it exits; the reconciler consumes the embedded proof without re-sampling", async () => {
      await withScopedJob(
        { sleepSeconds: "5", labelArgument: "matching" },
        async ({ argvServiceLabel, label, pid, target }) => {
          const attestation = await attestLaunchdSupervisorPid(label, pid);
          expect(attestation).not.toBeNull();
          expect(argvServiceLabel).toBe(label);

          // Reconciler deliberately does not run until after the fastest useful
          // decline window: launchd has already removed the short-lived job.
          await runCommand("launchctl", ["bootout", "--wait", target]);
          const postExitPrint = await runCommand("launchctl", ["print", target])
            .then(() => "still-present")
            .catch(() => "gone");
          expect(postExitPrint).toBe("gone");

          const marker = lockDeclinedMarker({
            serviceLabel: argvServiceLabel,
            attestation: attestation ?? fail("live job did not attest"),
          });
          expect(
            interpretProbeMarker({
              marker,
              transitionId: marker.transitionId,
              probeNonce: marker.probeNonce,
              expectedServiceLabel: label,
              readiness: { kind: "not-ready", attemptId: null },
            }),
          ).toEqual({ kind: "lock-declined" });
        },
      );
    });

    it("M9: a real scoped registration whose argv binds a different label produces an uncorrelated marker", async () => {
      await withScopedJob(
        { sleepSeconds: "5", labelArgument: "mismatched" },
        async ({ argvServiceLabel, label, pid, printed }) => {
          expect(printed).toContain("--service-label");
          expect(printed).toContain(argvServiceLabel);
          expect(argvServiceLabel).not.toBe(label);
          const attestation = await attestLaunchdSupervisorPid(label, pid);
          expect(attestation).not.toBeNull();
          const marker = lockDeclinedMarker({
            serviceLabel: argvServiceLabel,
            attestation: attestation ?? fail("live job did not attest"),
          });
          expect(
            interpretProbeMarker({
              marker,
              transitionId: marker.transitionId,
              probeNonce: marker.probeNonce,
              expectedServiceLabel: label,
              readiness: { kind: "not-ready", attemptId: null },
            }),
          ).toEqual({ kind: "indeterminate", reason: "marker-uncorrelated" });
        },
      );
    });

    it("M9: a pid that does NOT match the real job's pid is rejected — label/pid mismatch never attests", async () => {
      await withScopedJob(
        { sleepSeconds: "5", labelArgument: "matching" },
        async ({ label, pid }) => {
          const wrongPid = pid + 1;
          const attestation = await attestLaunchdSupervisorPid(label, wrongPid);
          expect(attestation).toBeNull();
        },
      );
    });

    it("M9: an unloaded (never-bootstrapped) label attests to null, never throws", async () => {
      const runId = randomUUID().replaceAll("-", "");
      const label = `ai.traycer.host.test.${process.pid}.${runId}.never-loaded`;
      const attestation = await attestLaunchdSupervisorPid(label, 99_999);
      expect(attestation).toBeNull();
    });

    it(
      "M8: fallback label provision + bootstrap + attempt-scoped readiness marker",
      async () => {
        await withScopedFallbackReadiness(
          async ({
            baseline,
            hostRoot,
            installRecordPath,
            label,
            pidPath,
            supervisorMarker,
          }) => {
            // Baseline is captured before provisioning.
            // The supervisor evidence is its real production `starting` log marker, not child-authored state.
            const install = JSON.parse(
              await readFile(installRecordPath, "utf8"),
            ) as {
              readonly installId: string;
            };

            // The poll is inlined rather than driven through `waitForAttemptReadiness`.
            // That helper had zero production callers and went with the parked decision layer; what M8 proves does not depend on it.
            const readiness = await pollForEndpointReadiness({
              deadlineMs: READINESS_BUDGET_MS,
              pollIntervalMs: 500,
              observe: async () => {
                const pidMetadata = await readFallbackPidMetadata(pidPath);
                if (pidMetadata === null) return { rung: "supervisor" };
                if (pidMetadata.generation !== install.installId) {
                  return { rung: "pid", detail: "generation mismatch" };
                }
                const answered = await fetch(pidMetadata.websocketUrl).then(
                  (response) => response.ok,
                  () => false,
                );
                return answered ? { rung: "endpoint" } : { rung: "pid" };
              },
            });

            expect(
              readiness.rung,
              // On failure this is the difference between "the harness is slow" and "R3 reproduced on a clean machine", so the message has to carry the evidence rather than make someone re-run it with logging added.
              `fallback host never reached the endpoint rung within ${READINESS_BUDGET_MS}ms. ` +
                `Highest rung: ${readiness.rung}${readiness.detail === undefined ? "" : ` (${readiness.detail})`}. ` +
                `attemptId=${supervisorMarker.attemptId} launchdPid=${supervisorMarker.launchdPid} ` +
                `supervisorPid=${supervisorMarker.supervisorPid}\n` +
                `launchctl print:\n${await describeJobState(label)}\n` +
                `host.log tail:\n${await tailFile(join(hostRoot, "host.log"), 40)}`,
            ).toBe("endpoint");
            expect(label).toContain(".fallback");
            expect(hostRoot).toContain(".traycer/host/dev");
            expect(baseline).not.toBeNull();
          },
        );
      },
      READINESS_BUDGET_MS + 20_000,
    );

    /** Parked decision layer removed; this case is no longer a launchd wedge. */

    it.skip("M3 (live arm): a real CDHash-invalidating registration reaches the wedge verdict — deliberately never attempted, see below", async () => {
      // Deliberately never attempted, even under opt-in: forcing a real CDHash-invalidating wedge means re-signing (or corrupting the signature of) a real bundled binary registered with launchd - that is destructive to whatever signing identity runs the suite.
      // The parse-only arm (golden "spawn failed" / EX_CONFIG 78 / LWCR-marker text) is already covered by T3/T5 fixtures per the ticket.
    });
  },
);

type RealCommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

async function runCommand(
  command: string,
  args: readonly string[],
): Promise<RealCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on(
      "data",
      (chunk: Buffer) => (stdout += chunk.toString("utf8")),
    );
    child.stderr?.on(
      "data",
      (chunk: Buffer) => (stderr += chunk.toString("utf8")),
    );
    child.once("error", reject);
    child.once("close", (status) => {
      if (status === 0) {
        resolve({ status, stdout, stderr });
      } else {
        reject(
          Object.assign(new Error(`${command} exited ${String(status)}`), {
            status,
            stdout,
            stderr,
          }),
        );
      }
    });
  });
}

/** M8's raw fallback is intentionally independent from the reclaim probe. It provisions a scoped `.fallback` launchd registration, bootstraps the real CLI supervisor, reads that supervisor's production starting marker, and lets its child provide only the later pid metadata and endpoint rungs. */
async function withScopedFallbackReadiness(
  work: (result: {
    readonly baseline: {
      readonly priorPid: number | null;
      readonly markerIdentity: string | null;
      readonly markerLength: number;
    };
    readonly hostRoot: string;
    readonly installRecordPath: string;
    readonly label: string;
    readonly pidPath: string;
    readonly supervisorMarker: {
      readonly attemptId: string;
      readonly identity: string;
      readonly launchdPid: number;
      readonly length: number;
      readonly supervisorPid: number;
    };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-fallback-m8-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const uid = process.getuid?.() ?? 0;
  const runId = randomUUID().replaceAll("-", "");
  const label = `ai.traycer.host.test.${process.pid}.${runId}.fallback`;
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const plistPath = join(root, "fallback.plist");
  // launchd gives a job no stdio unless the plist asks for it, so a supervisor that dies before its first log line leaves NOTHING anywhere: `host.log` empty, `launchctl print` happily exit 0 on a loaded label, and the temp root deleted on the way out.
  // That is exactly the state the hosted runner reported, and it is unclassifiable without these.
  const supervisorStdoutPath = join(root, "supervisor.out");
  const supervisorStderrPath = join(root, "supervisor.err");
  const hostScript = join(bin, "fallback-ready-host.ts");
  const hostWrapper = join(bin, "fallback-ready-host.sh");
  const cliEntry = resolve(process.cwd(), "src/index.ts");
  const bunPath = resolveBunPath();
  const hostRoot = join(home, ".traycer", "host", "dev");
  const installRecordPath = join(hostRoot, "install", "install.json");
  const pidPath = join(hostRoot, "pid.json");
  const bootstrapLogPath = join(hostRoot, "host.log");

  await mkdir(dirname(installRecordPath), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    hostScript,
    `import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const dataIndex = process.argv.indexOf("--host-data-dir");
const dataDir = dataIndex >= 0 ? process.argv[dataIndex + 1] : null;
if (typeof dataDir !== "string") throw new Error("missing fallback data dir");
mkdirSync(dataDir, { recursive: true });
const server = createServer((_request, response) => { response.writeHead(200); response.end("ready"); });
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fallback endpoint unavailable");
  writeFileSync(join(dataDir, "pid.json"), JSON.stringify({ pid: process.pid, hostId: "m8-fallback", websocketUrl: "http://127.0.0.1:" + address.port, version: "test", startedAt: "2026-07-27T00:00:00.000Z", processStartTimeMs: 1, generation: "fallback-generation-1" }), "utf8");
});
setInterval(() => undefined, 1_000);
`,
    "utf8",
  );
  await writeFile(
    hostWrapper,
    `#!/bin/sh\nexec ${shellQuote(bunPath)} ${shellQuote(hostScript)} "$@"\n`,
    "utf8",
  );
  await chmod(hostWrapper, 0o700);
  await writeFile(
    installRecordPath,
    JSON.stringify({
      installId: "fallback-generation-1",
      version: "test",
      runtimeVersion: null,
      platform: "darwin",
      arch: process.arch,
      installedAt: "2026-07-27T00:00:00.000Z",
      source: { kind: "registry", value: "test" },
      archiveSha256: "a".repeat(64),
      signatureVerifiedAt: "2026-07-27T00:00:00.000Z",
      signatureKeyId: "test",
      sizeBytes: 1,
      executablePath: hostWrapper,
    }),
    "utf8",
  );
  await writeFile(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${bunPath}</string><string>${cliEntry}</string><string>host</string><string>start</string><string>--service-label</string><string>${label}</string></array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${home}</string><key>PATH</key><string>${process.env.PATH ?? "/usr/bin:/bin"}</string></dict>
<key>WorkingDirectory</key><string>${process.cwd()}</string>
<key>StandardOutPath</key><string>${supervisorStdoutPath}</string>
<key>StandardErrorPath</key><string>${supervisorStderrPath}</string>
<key>RunAtLoad</key><true/>
</dict></plist>`,
    "utf8",
  );
  cleanupTargets = [...cleanupTargets, target];
  let bodyCompleted = false;
  try {
    const baselineLog = await readFile(bootstrapLogPath, "utf8").catch(
      () => "",
    );
    const baselinePid = await readFallbackPidMetadata(pidPath);
    await runCommand("launchctl", ["bootstrap", domain, plistPath]);
    const supervisorStart = await waitForSupervisorStart(
      bootstrapLogPath,
      SUPERVISOR_START_BUDGET_MS,
      target,
      [supervisorStdoutPath, supervisorStderrPath],
    );
    const printed = await runCommand("launchctl", ["print", target]);
    const pidMatch = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(printed.stdout);
    if (pidMatch === null)
      throw new Error("scoped fallback supervisor has no launchd pid");
    const launchdPid = Number(pidMatch[1]);
    if (supervisorStart.supervisorPid !== launchdPid) {
      throw new Error("supervisor starting marker pid does not match launchd");
    }
    await work({
      baseline: {
        priorPid: baselinePid?.pid ?? null,
        markerIdentity: baselineLog.length === 0 ? null : baselineLog,
        markerLength: Buffer.byteLength(baselineLog),
      },
      hostRoot,
      installRecordPath,
      label,
      pidPath,
      supervisorMarker: {
        attemptId: supervisorStart.attemptId,
        identity: supervisorStart.identity,
        launchdPid,
        length: supervisorStart.length,
        supervisorPid: supervisorStart.supervisorPid,
      },
    });
    bodyCompleted = true;
  } finally {
    await releaseScopedTarget({
      bodyCompleted,
      leakDescription: "scoped M8 fallback",
      scratchDir: root,
      target,
    });
  }
}

type SupervisorStartMarker = {
  readonly attemptId: string;
  readonly identity: string;
  readonly length: number;
  readonly supervisorPid: number;
};

async function waitForSupervisorStart(
  path: string,
  timeoutMs: number,
  target: string,
  stdioPaths: readonly string[],
): Promise<SupervisorStartMarker> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, "utf8");
      for (const line of text.split(/\r?\n/).reverse()) {
        const marker = parseBootstrapLogLine(line);
        if (marker?.phase !== "starting") continue;
        const attemptId = marker.fields.attempt;
        const pidText = marker.fields.supervisorPid;
        const supervisorPid =
          pidText === undefined ? Number.NaN : Number(pidText);
        if (
          attemptId !== undefined &&
          attemptId.length > 0 &&
          Number.isInteger(supervisorPid) &&
          supervisorPid > 0
        ) {
          return {
            attemptId,
            identity: line,
            length: Buffer.byteLength(line),
            supervisorPid,
          };
        }
      }
    } catch {
      // The log does not exist before the supervisor's write-ahead marker.
    }
    await sleep(50);
  }
  // A bare "timed out" here is unclassifiable: it looks identical whether the runner was starving on cold I/O or the shipped `host start` genuinely fails to bootstrap under a LaunchAgent.
  // The temp root is deleted on the way out, so whatever is not captured now is gone - dump the job state and the log the supervisor was supposed to write into the failure itself.
  const stdio = await Promise.all(
    stdioPaths.map(
      async (stdioPath) => `${stdioPath}:\n${await tailFile(stdioPath, 40)}`,
    ),
  );
  throw new Error(
    [
      `timed out after ${timeoutMs}ms waiting for the supervisor 'starting' marker at ${path}`,
      `launchctl print:\n${await describeJobState(target)}`,
      `log tail:\n${await tailFile(path, 40)}`,
      ...stdio,
    ].join("\n"),
  );
}

// Budgets live together so the vitest deadline is always derived from them rather than drifting apart, which is how M8 ended up with a 30 s policy budget inside a 15 s deadline.
// Generous on purpose: a hosted runner can spend tens of seconds on cold module resolution alone before the CLI's first line of work, and a slow machine must read as slow, not as broken.
const SUPERVISOR_START_BUDGET_MS = 60_000;
const READINESS_BUDGET_MS = 60_000;

/** The interpreter the scoped LaunchAgents must run, resolved to an absolute path because launchd gives a job only `/usr/bin:/bin:/usr/sbin:/sbin`. This used to fall back to `process.execPath`, which is wrong in the one environment that matters: these suites run under vitest, and **vitest runs on Node**, so `process.execPath` is the Node binary. */
function resolveBunPath(): string {
  const candidates: string[] = [];
  if (process.env.BUN_INSTALL !== undefined) {
    candidates.push(join(process.env.BUN_INSTALL, "bin", "bun"));
  }
  if (process.execPath.endsWith("/bun")) {
    candidates.push(process.execPath);
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir.length > 0) candidates.push(join(dir, "bun"));
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      "these rows launch the CLI's TypeScript entrypoint under launchd and " +
        "need a real bun binary, but none was found via BUN_INSTALL, " +
        `process.execPath (${process.execPath}), or PATH. Install bun or set ` +
        "BUN_INSTALL; do NOT fall back to the current interpreter - under " +
        "vitest that is Node, which cannot run the entrypoint at all.",
    );
  }
  return found;
}

async function describeJobState(target: string): Promise<string> {
  const printed = await runCommand("launchctl", ["print", target]).catch(
    (cause: unknown) => ({
      status: null,
      stdout: "",
      stderr: `launchctl print failed: ${String(cause)}`,
    }),
  );
  return `  exit=${String(printed.status)}\n${indent(printed.stdout || printed.stderr)}`;
}

async function tailFile(path: string, lines: number): Promise<string> {
  const text = await readFile(path, "utf8").catch(
    (cause: unknown) => `<unreadable: ${String(cause)}>`,
  );
  return indent(text.split(/\r?\n/).slice(-lines).join("\n"));
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  | ${line}`)
    .join("\n");
}

type ReadinessRungObservation = {
  readonly rung: "supervisor" | "pid" | "endpoint";
  readonly detail?: string;
};

/** Bounded poll to the endpoint rung, reporting the HIGHEST rung reached rather than a boolean. A timeout that says "never got past `pid`" is a different bug report from one that says "never published pid.json". */
async function pollForEndpointReadiness(input: {
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
  readonly observe: () => Promise<ReadinessRungObservation>;
}): Promise<ReadinessRungObservation> {
  const deadline = Date.now() + input.deadlineMs;
  let highest: ReadinessRungObservation = { rung: "supervisor" };
  const order = { supervisor: 0, pid: 1, endpoint: 2 };
  while (Date.now() < deadline) {
    const observation = await input.observe();
    if (order[observation.rung] >= order[highest.rung]) highest = observation;
    if (observation.rung === "endpoint") return observation;
    await sleep(input.pollIntervalMs);
  }
  return highest;
}

type FallbackPidMetadata = {
  readonly generation: string;
  readonly hostId: string;
  readonly pid: number;
  readonly processStartTimeMs: number;
  readonly startedAt: string;
  readonly version: string;
  readonly websocketUrl: string;
};

async function readFallbackPidMetadata(
  path: string,
): Promise<FallbackPidMetadata | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (
    typeof value.generation !== "string" ||
    typeof value.hostId !== "string" ||
    typeof value.pid !== "number" ||
    typeof value.processStartTimeMs !== "number" ||
    typeof value.startedAt !== "string" ||
    typeof value.version !== "string" ||
    typeof value.websocketUrl !== "string"
  ) {
    return null;
  }
  return {
    generation: value.generation,
    hostId: value.hostId,
    pid: value.pid,
    processStartTimeMs: value.processStartTimeMs,
    startedAt: value.startedAt,
    version: value.version,
    websocketUrl: value.websocketUrl,
  };
}

/** A scoped launchd job that runs the real CLI supervisor from source. Its temporary host executable imports T1's production `writeLayer0Frame`, so this is an actual launchd supervisor → socket fd 3 → frame reader → attestation → marker path, not a hand-built marker around `/bin/sleep`. */
async function withScopedSupervisorProbe(
  options: {
    readonly argvLabel: "matching" | "mismatched";
  },
  work: (result: {
    readonly label: string;
    readonly marker: ProbeMarker | null;
    readonly plistPath: string;
    readonly target: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-probe-supervisor-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const uid = process.getuid?.() ?? 0;
  const runId = randomUUID().replaceAll("-", "");
  const label = `ai.traycer.host.test.${process.pid}.${runId}.supervisor`;
  const argvLabel =
    options.argvLabel === "matching" ? label : `${label}.fallback`;
  const target = `gui/${uid}/${label}`;
  const plistPath = join(root, "job.plist");
  const hostScript = join(bin, "layer0-producer.ts");
  const hostWrapper = join(bin, "host-wrapper.sh");
  const cliEntry = resolve(process.cwd(), "src/index.ts");
  const bunPath = resolveBunPath();
  const layer0Module = layer0ModulePath();
  // This source checkout is a dev-slot CLI (`config.environment === "dev"`).
  // Keep every lifecycle byte inside the scoped dev data root rather than assuming a production-baked executable.
  const hostRoot = join(home, ".traycer", "host", "dev");
  const markerPath = join(hostRoot, "transition-probe.json");
  const installRecordPath = join(hostRoot, "install", "install.json");
  const supervisorStderrPath = join(root, "supervisor.stderr");
  const transitionPath = join(hostRoot, "transition.json");
  /** Shared by the incumbent holder and the launchd-supervised challenger. */
  const layer0LockDir = join(root, "layer0");

  await mkdir(dirname(installRecordPath), { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(layer0LockDir, { recursive: true });

  /** Real Layer-0 host program, not a frame emitter. */
  await writeFile(
    hostScript,
    `import { createRequire } from "node:module";
import {
  acquireLayer0Lock,
  getLayer0AttemptId,
  writeLayer0Frame,
} from ${JSON.stringify(layer0Module)};
const attemptId = getLayer0AttemptId(process.argv);
const nativeAddon = createRequire(import.meta.url)(${JSON.stringify(layer0AddonPath())});
const outcome = await acquireLayer0Lock({
  dataDir: ${JSON.stringify(layer0LockDir)},
  attemptId,
  nativeAddon,
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
writeLayer0Frame(outcome.frame);
setTimeout(() => process.exit(0), 500);
`,
    "utf8",
  );
  await writeFile(
    hostWrapper,
    `#!/bin/sh\nexec ${shellQuote(bunPath)} ${shellQuote(hostScript)} "$@"\n`,
    "utf8",
  );
  await chmod(hostWrapper, 0o700);
  await writeFile(
    installRecordPath,
    JSON.stringify({
      installId: null,
      version: "test",
      runtimeVersion: null,
      platform: "darwin",
      arch: process.arch,
      installedAt: "2026-07-27T00:00:00.000Z",
      source: { kind: "registry", value: "test" },
      archiveSha256: "a".repeat(64),
      signatureVerifiedAt: "2026-07-27T00:00:00.000Z",
      signatureKeyId: "test",
      sizeBytes: 1,
      executablePath: hostWrapper,
    }),
    "utf8",
  );
  await writeFile(
    transitionPath,
    JSON.stringify({
      v: 1,
      transitionId: "real-m9-transition",
      probeNonce: "real-m9-nonce",
      kind: "reclaim",
      from: "raw-fallback",
      to: "smappservice",
      phase: "reclaim-awaiting-probe",
      expectedIdentities: [argvLabel],
      compensation: "reprovision-fallback",
      startedAt: "2026-07-27T00:00:00.000Z",
      probeDeadlineAt: "2099-01-01T00:00:00.000Z",
      governor: {
        lastAttemptedBuildId: null,
        lastAttemptedCDHash: null,
        failureClass: null,
        attemptCount: 0,
        nextEligibleAt: null,
        breaker: null,
        lastSustainedHealthAt: null,
      },
      terminal: null,
    }),
    "utf8",
  );
  await writeFile(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${bunPath}</string><string>${cliEntry}</string><string>host</string><string>start</string><string>--service-label</string><string>${argvLabel}</string></array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${home}</string><key>PATH</key><string>${process.env.PATH ?? "/usr/bin:/bin"}</string></dict>
<key>StandardErrorPath</key><string>${supervisorStderrPath}</string>
<key>RunAtLoad</key><true/>
</dict></plist>`,
    "utf8",
  );
  cleanupTargets = [...cleanupTargets, target];
  // A real incumbent must already hold the kernel lock, or the challenger would acquire it and there would be no decline to observe.
  // This is the contention the row's name has always claimed.
  const incumbent = await startLayer0Incumbent(
    root,
    layer0LockDir,
    bunPath,
    layer0Module,
  );
  let bodyCompleted = false;
  try {
    await runCommand("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    const marker = await waitForProbeMarker(
      markerPath,
      // A first real launch can compile the source CLI/host fixture before it reaches fd 3.
      // This remains a bounded test-only wait; the probe protocol itself has its own, shorter frame deadline.
      options.argvLabel === "matching" ? 12_000 : 1_000,
    );
    if (marker === null && options.argvLabel === "matching") {
      const hostLog = await readFile(join(hostRoot, "host.log"), "utf8").catch(
        () => "<host log unavailable>",
      );
      const supervisorStderr = await readFile(
        supervisorStderrPath,
        "utf8",
      ).catch(() => "<supervisor stderr unavailable>");
      const printed = await runCommand("launchctl", ["print", target])
        .then((result) => result.stdout)
        .catch(() => "<launchd job no longer loaded>");
      throw new Error(
        `real supervisor did not write a marker\nhost.log:\n${hostLog}\nstderr:\n${supervisorStderr}\nlaunchctl:\n${printed}`,
      );
    }
    await work({ label, marker, plistPath, target });
    bodyCompleted = true;
  } finally {
    incumbent?.kill("SIGKILL");
    await releaseScopedTarget({
      bodyCompleted,
      leakDescription: "scoped real-launchd supervisor",
      scratchDir: root,
      target,
    });
  }
}

type Layer0ProducerResult = {
  readonly ipcMessages: readonly unknown[];
  readonly framedPayloads: readonly string[];
  readonly stderr: string;
  readonly ipcError: string | null;
  readonly exitCode: number | null;
};

/** Run the real `writeLayer0Frame` in a child whose fd 3 is a Node IPC channel when the flag is withheld, and a dedicated pipe when it is passed. Both arms run the *same* producer program, so the only variable is the flag - which is the contract under test. */
async function runLayer0Producer(options: {
  readonly passStatusFdFlag: boolean;
}): Promise<Layer0ProducerResult> {
  const root = await mkdtemp(join(tmpdir(), "layer0-status-fd-"));
  try {
    const script = join(root, "producer.ts");
    await writeFile(
      script,
      `import { acquireHostLayer0Lock, getLayer0AttemptId, writeLayer0Frame } from ${JSON.stringify(layer0ModulePath())};
const attemptId = getLayer0AttemptId(process.argv);
const outcome = await acquireHostLayer0Lock({
  dataDir: ${JSON.stringify(join(root, "data"))},
  attemptId,
});
writeLayer0Frame(outcome.frame);
// Proves the channel is still usable *after* the write attempt. If a raw
// framed record had gone into an IPC fd, this send — or the parent's decode
// of it — is what breaks.
process.send?.({ layer0ProducerFinished: true });
setTimeout(() => process.exit(0), 100);
`,
      "utf8",
    );

    // `resolveBunPath` rather than a local fallback: falling back to `process.execPath` is precisely what that helper's error message forbids, because under vitest it is Node, which cannot run the entrypoint this row spawns.
    // A silent wrong-interpreter spawn fails in a way that looks like the behaviour under test.
    const bunPath = resolveBunPath();
    const args = [script, "--layer0-attempt-id", "status-fd-contract"];
    if (options.passStatusFdFlag) args.push("--layer0-status-fd=3");

    return await new Promise<Layer0ProducerResult>((resolveResult, reject) => {
      const framePipe = options.passStatusFdFlag ? "pipe" : "ipc";
      const child = spawn(bunPath, args, {
        stdio: ["ignore", "pipe", "pipe", framePipe],
      });
      const ipcMessages: unknown[] = [];
      const framedPayloads: string[] = [];
      let stderr = "";
      let ipcError: string | null = null;
      let collected = Buffer.alloc(0);

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("message", (message: unknown) => {
        ipcMessages.push(message);
      });
      child.once("error", (error: Error) => {
        ipcError = error.message;
      });
      const statusStream = child.stdio[3];
      if (
        statusStream !== null &&
        statusStream !== undefined &&
        "on" in statusStream
      ) {
        statusStream.on("data", (chunk: Buffer) => {
          collected = Buffer.concat([collected, chunk]);
          while (collected.length >= 4) {
            const length = collected.readUInt32BE(0);
            if (collected.length < length + 4) break;
            framedPayloads.push(
              collected.subarray(4, length + 4).toString("utf8"),
            );
            collected = collected.subarray(length + 4);
          }
        });
      }
      child.once("close", (exitCode) => {
        resolveResult({
          ipcMessages,
          framedPayloads,
          stderr,
          ipcError,
          exitCode,
        });
      });
      setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("layer0 producer did not exit"));
      }, 25_000).unref();
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The Layer-0 lock lives in `traycer-host`, which is **not part of the OSS repository** - it exists only in the internal monorepo checkout. Rows that contend on the real lock therefore cannot run from an OSS-only clone, and they say so rather than passing. */
function layer0ModulePath(): string {
  return resolve(
    process.cwd(),
    "../../../traycer-host/src/lifecycle/layer0-lock.ts",
  );
}

function layer0AddonPath(): string {
  return resolve(
    process.cwd(),
    "../../../traycer-host/native/lifecycle-lock/build/Release/lifecycle_lock.node",
  );
}

/** Null when this checkout cannot host the real-lock rows at all (OSS-only), a reason string when it should be able to but something is missing (internal checkout with an unbuilt addon - a hard failure, not a skip). */
function layer0Availability():
  | { readonly kind: "available" }
  | { readonly kind: "not-internal-checkout" }
  | { readonly kind: "broken"; readonly reason: string } {
  if (!existsSync(layer0ModulePath())) {
    return { kind: "not-internal-checkout" };
  }
  if (!existsSync(layer0AddonPath())) {
    return {
      kind: "broken",
      reason:
        `the internal checkout is present but the lifecycle-lock addon is not built at ${layer0AddonPath()}. ` +
        "Run `node traycer-host/scripts/build-lifecycle-lock.cjs`. Skipping " +
        "here would report a Layer-0 gate as covered when the lock was never " +
        "contended.",
    };
  }
  return { kind: "available" };
}

/** A real second process holding the real kernel lock on `lockDir`. Resolves only once it has actually acquired - starting the challenger before the incumbent holds the lock would let the challenger win and silently turn the decline row into an acquisition row. */
async function startLayer0Incumbent(
  root: string,
  lockDir: string,
  bunPath: string,
  layer0Module: string,
): Promise<ChildProcess> {
  const script = join(root, "layer0-incumbent.ts");
  const readyPath = join(root, "incumbent-ready.json");
  await writeFile(
    script,
    `import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { acquireLayer0Lock } from ${JSON.stringify(layer0Module)};
const nativeAddon = createRequire(import.meta.url)(${JSON.stringify(layer0AddonPath())});
const outcome = await acquireLayer0Lock({
  dataDir: ${JSON.stringify(lockDir)},
  attemptId: "real-m9-incumbent",
  nativeAddon,
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify(outcome.frame));
if (outcome.kind !== "acquired") process.exit(1);
setInterval(() => {}, 1 << 30);
`,
    "utf8",
  );
  const child = spawn(bunPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const frame = await readFile(readyPath, "utf8").catch(() => null);
    if (frame !== null) {
      const parsed: unknown = JSON.parse(frame);
      const layer0 =
        parsed !== null && typeof parsed === "object" && "layer0" in parsed
          ? String((parsed as { readonly layer0: unknown }).layer0)
          : "";
      if (layer0 !== "acquired") {
        child.kill("SIGKILL");
        throw new Error(
          `the Layer-0 incumbent could not take the lock (${layer0}); ` +
            "without a held lock the challenger would acquire and this row " +
            "would assert a decline that never happened",
        );
      }
      return child;
    }
    if (Date.now() >= deadline) {
      child.kill("SIGKILL");
      throw new Error("the Layer-0 incumbent never reported acquisition");
    }
    await sleep(50);
  }
}

async function waitForProbeMarker(
  markerPath: string,
  timeoutMs: number,
): Promise<ProbeMarker | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(markerPath, "utf8")) as ProbeMarker;
    } catch {
      await sleep(50);
    }
  }
  return null;
}

/** POSIX single-quote for the `/bin/sh` wrappers these rows write. This carried the exact defect `posixShellQuote` documents as already fixed in `service/platforms/host-start-script.ts`: `"'\\\"'\\\"'"` is the JS string `'\"'\"'`, which is neither `'\''` nor `'"'"'` and leaves the quote unterminated, so `sh` dies with "unexpected EOF" before anything runs. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function withScopedJob(
  options: {
    readonly sleepSeconds: string;
    readonly labelArgument: "matching" | "mismatched";
  },
  work: (job: {
    readonly argvServiceLabel: string;
    readonly domain: string;
    readonly label: string;
    readonly pid: number;
    readonly plistPath: string;
    readonly printed: string;
    readonly target: string;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "lifecycle-probe-m9-"));
  const uid = process.getuid?.() ?? 0;
  const runId = randomUUID().replaceAll("-", "");
  const label = `ai.traycer.host.test.${process.pid}.${runId}`;
  const argvServiceLabel =
    options.labelArgument === "matching" ? label : `${label}.fallback`;
  const target = `gui/${uid}/${label}`;
  const domain = `gui/${uid}`;
  const plistPath = join(dataDir, "job.plist");
  const supervisorPath = join(dataDir, "scoped-supervisor.sh");
  await writeFile(supervisorPath, '#!/bin/sh\nexec /bin/sleep "$3"\n', "utf8");
  await chmod(supervisorPath, 0o700);
  await writeFile(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${supervisorPath}</string><string>--service-label</string><string>${argvServiceLabel}</string><string>${options.sleepSeconds}</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>`,
    "utf8",
  );
  cleanupTargets = [...cleanupTargets, target];
  let bodyCompleted = false;
  try {
    await runCommand("launchctl", ["bootstrap", domain, plistPath]);
    // Give the job a moment to actually spawn before reading its pid back.
    await sleep(100);
    const printed = await runCommand("launchctl", ["print", target]);
    const pidMatch = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(printed.stdout);
    if (pidMatch === null) {
      throw new Error(
        "scoped supervisor exited before launchctl reported its pid",
      );
    }
    await work({
      argvServiceLabel,
      domain,
      label,
      pid: Number(pidMatch[1]),
      plistPath,
      printed: printed.stdout,
      target,
    });
    bodyCompleted = true;
  } finally {
    await releaseScopedTarget({
      bodyCompleted,
      leakDescription: "scoped real-launchd job",
      scratchDir: dataDir,
      target,
    });
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function lockDeclinedMarker(input: {
  readonly serviceLabel: string;
  readonly attestation: ProbeSupervisorAttestation;
}): ProbeMarker {
  return {
    v: 1,
    transitionId: "real-m9-transition",
    probeNonce: "real-m9-nonce",
    serviceLabel: input.serviceLabel,
    supervisorPid: input.attestation.supervisorPid,
    attestation: input.attestation,
    outcome: {
      kind: "lock-declined",
      attemptId: "real-m9-attempt",
      incumbentEvidence: {
        kind: "held-retry-window",
        lockPath: "/tmp/scoped-layer0.lock",
        observedForMs: 1,
      },
    },
  };
}

function fail(message: string): never {
  throw new Error(message);
}
