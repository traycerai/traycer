import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { uptime } from "node:os";
import {
  buildScheduledTaskXml,
  buildWindowsHiddenHostLauncher,
  windowsHiddenHostLauncherPath,
} from "../../src/service/platforms/windows";
import { serviceLabelFor, windowsTaskName } from "../../src/service/label";
import {
  cliManifestPath,
  hostHomeDir,
  hostInstallDir,
} from "../../src/store/paths";
import { writeHostInstallRecord } from "../../src/manifest/host-install";
import { HOST_START_ADOPTION_MAX_AGE_MS } from "@traycer-clients/shared/host-start-adoption/spawn-edge-bounds";
import { powershellSingleQuoted } from "@traycer-clients/shared/platform/powershell-quote";
import {
  HELPER_ARM_WAIT_MS,
  scheduleFinalizationHelper,
} from "../../src/upgrade/finalize-helper";
import {
  WINDOWS_FINALIZE_FILE_IO_MS,
  WINDOWS_RESTORE_RECEIPT_WRITE_WARNING,
} from "../../src/service/windows-task-restoration";

const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  if (
    key === undefined ||
    !key.startsWith("--") ||
    value === undefined ||
    flags.has(key)
  ) {
    throw new Error("Invalid proof arguments");
  }
  flags.set(key, value);
}
function flag(name: string): string {
  const value = flags.get(name);
  if (value === undefined || value === "")
    throw new Error("Missing proof argument");
  return value;
}
const root = resolve(flag("--root"));
const id = readFileSync(join(root, "fixture.id"), "utf8");
const mode = flag("--mode");
const proofCase = flag("--case");
const cli = resolve(flag("--cli"));
const oldCli = flags.get("--old-cli");
if (
  process.platform !== "win32" ||
  !/^[a-f0-9]{32}$/.test(id) ||
  !root.endsWith(`traycer-win-restore-${id}`) ||
  !["Logon", "Boot"].includes(mode) ||
  (oldCli !== undefined && (mode !== "Logon" || proofCase !== "freshness")) ||
  !["freshness", "cold", "prepare", "deadline"].includes(proofCase)
) {
  throw new Error("A disposable Windows logon or boot fixture is required");
}

const slot = `restoreproof-${id}`;
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.DEV_DESKTOP_SLOT = slot;
const windows = process.env.SystemRoot ?? "C:\\Windows";
const powershell = join(
  windows,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const schtasks = join(windows, "System32", "schtasks.exe");
const whoami = join(windows, "System32", "whoami.exe");
const label = serviceLabelFor("dev");
const task = windowsTaskName(label);
if (!task.endsWith(id) || task !== flag("--task"))
  throw new Error("Task does not match fixture");
const version = "1.5.0";
const installedExe = join(hostInstallDir("dev"), "traycer-host.exe");
const hostPath = join(hostHomeDir("dev"), "pid.json");
const proofHost = join(
  dirname(process.execPath),
  "traycer-win-restore-test-host.exe",
);
const liveCli = join(root, "traycer.exe");
const workerCli = join(root, "verified-worker", "traycer.exe");
const stagedCli = join(root, "staged-traycer.exe");
const resultPath = resolve(flag("--result"));
if (dirname(resultPath) !== root)
  throw new Error("Result must be inside fixture");

function command(path: string, args: string[]): string {
  const result = spawnSync(path, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.status !== 0)
    throw new Error(
      `A disposable fixture command failed: ${args[0] ?? "unknown"}`,
    );
  return result.stdout;
}
function touch(name: string): void {
  writeFileSync(join(root, name), "1");
}
async function awaitFile(name: string, maxMs: number): Promise<string> {
  const path = join(root, name);
  const end = performance.now() + maxMs;
  while (!existsSync(path)) {
    if (performance.now() >= end)
      throw new Error(`Unavailable fixture signal: ${name}`);
    await new Promise<void>((wake) => setTimeout(wake, 30));
  }
  return path;
}
function cliRestore(legacy: boolean): {
  child: ChildProcess;
  finished: Promise<string>;
} {
  const child = spawn(
    workerCli,
    [
      "--json",
      "--no-bootstrap",
      "--non-interactive",
      "cli",
      "finalize-upgrade",
      `--expected-staged-path=${stagedCli}`,
      ...(legacy ? ["--legacy-windows-handoff"] : []),
      `--windows-worker-receipt-id=${randomUUID()}`,
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const stdout = child.stdout;
  if (stdout === null) throw new Error("Finalizer output was not captured");
  child.stderr?.resume();
  const chunks: Buffer[] = [];
  stdout.on("data", (data: Buffer) => chunks.push(data));
  const finished = new Promise<string>((accept, refuse) => {
    child.once("error", refuse);
    child.once("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf8");
      if (code === 0 || restorationOutcome(output) === "restore-failed")
        accept(output);
      else refuse(new Error("The disposable CLI finalizer returned an error"));
    });
  });
  void finished.catch(() => undefined);
  child.stdin?.end(
    legacy ? "restore\n" : `start ${Math.floor(uptime() * 1000) + 30_000}\n`,
  );
  return { child, finished };
}
async function awaitCount(name: string, minimum: number): Promise<void> {
  const end = performance.now() + 45_000;
  const path = join(root, name);
  for (;;) {
    if (existsSync(path) && Number(readFileSync(path, "utf8")) >= minimum)
      return;
    if (performance.now() >= end)
      throw new Error(`Missing completed probe decision: ${name}`);
    await new Promise<void>((wake) => setTimeout(wake, 30));
  }
}

function restorationOutcome(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    try {
      const event = JSON.parse(line);
      const outcome =
        event?.data?.serviceRestore ??
        event?.error?.details?.commandResult?.serviceRestore;
      if (outcome === "restored" || outcome === "restore-failed")
        return outcome;
    } catch {}
  }
  return null;
}

async function watchdogFault(
  name: "parent" | "launch" | "manifest" | "receipt",
): Promise<number> {
  const folder = join(root, `watchdog-${name}`);
  mkdirSync(folder);
  const script = join(folder, "helper.ps1");
  const swapping = join(folder, "swap-admitted");
  const started = join(folder, "guarded-start");
  const control = join(folder, "worker.json");
  const childFolder = join(folder, "private-copy");
  mkdirSync(childFolder);
  writeFileSync(
    control,
    JSON.stringify({
      swapping,
      started,
      hangManifest: name === "manifest",
    }),
  );
  let body = "";
  const scheduled = await scheduleFinalizationHelper({
    environment: "dev",
    currentWindowsRunner: {
      path: workerCli,
      sha256: createHash("sha256")
        .update(readFileSync(workerCli))
        .digest("hex"),
      legacyDetached: false,
    },
    stagedBinaryPath: stagedCli,
    livePath: liveCli,
    parentPid: process.pid,
    parentExitTimeoutSeconds: 10,
    platform: "win32",
    coordinateWindowsRestart: true,
    spawnImpl: () => ({
      pid: undefined,
      unref: () => undefined,
      kill: () => undefined,
      exited: Promise.resolve({ exitCode: 1, errorMessage: null }),
    }),
    writeImpl: async (path, source) => {
      if (path.endsWith(".ps1")) body = source;
    },
    armWait: {
      now: () => 0,
      sleep: async () => {
        throw new Error("The fixture records the generated coordinator");
      },
      waitMs: 1_000,
      pollIntervalMs: 100,
    },
  });
  if (!scheduled.markerPath.startsWith(root + "\\") || body.length === 0) {
    throw new Error("The coordinator did not bind its fixture receipt path");
  }
  const guardAt = body.indexOf("$jobCheckFailed = $false");
  const tailAt = body.indexOf("function Get-BootMilliseconds");
  const phasesAt = body.indexOf("  $swapLaunchUntil = ", tailAt);
  const handshakeAt = body.indexOf("try {\n  if (-not $connect.Wait", tailAt);
  if (guardAt <= 0 || handshakeAt <= tailAt || phasesAt <= handshakeAt) {
    throw new Error("Missing verified Windows recovery script");
  }
  const commit = join(folder, "committed");
  writeFileSync(commit, "fixture");
  const tail = body
    .slice(tailAt, handshakeAt)
    .replace(
      /\$invokeBinary, '[^\n]*'\)/u,
      () =>
        `$invokeBinary, ${powershellSingleQuoted(`--t18-record-worker "${control}"`)})`,
    )
    .replace(
      ".AddScript({ param($info) [Diagnostics.Process]::Start($info) }).AddArgument($info)",
      name === "launch"
        ? ".AddScript({ param($info, $mode) if ($mode -ceq 'swap') { [Threading.Thread]::Sleep(120000) }; [Diagnostics.Process]::Start($info) }).AddArgument($info).AddArgument($Mode)"
        : ".AddScript({ param($info) [Diagnostics.Process]::Start($info) }).AddArgument($info)",
    );
  const phases = body
    .slice(phasesAt)
    .replace(
      "$parent.WaitForExit((Read-Remaining $swapLaunchUntil))",
      name === "parent"
        ? "($parentGate.WaitOne((Read-Remaining $swapLaunchUntil)))"
        : "$true",
    )
    .replace(".AddArgument([string]$PID)", ".AddArgument('fixture')")
    .replace(
      "if ($null -ne $payload) { & ([scriptblock]::Create($write))",
      name === "receipt"
        ? "if ($null -ne $payload) { [Threading.Thread]::Sleep(120000); & ([scriptblock]::Create($write))"
        : "if ($null -ne $payload) { & ([scriptblock]::Create($write))",
    );
  const monotonic =
    "function Get-BootMilliseconds { [long]([Diagnostics.Stopwatch]::GetTimestamp() * 1000 / [Diagnostics.Stopwatch]::Frequency) }";
  writeFileSync(
    script,
    [
      body.slice(0, guardAt),
      `$invokeBinary = ${powershellSingleQuoted(installedExe)}`,
      `$invokeDir = ${powershellSingleQuoted(childFolder)}`,
      `$CommittedPath = ${powershellSingleQuoted(commit)}`,
      "$stagedHandle = $null",
      tail,
      monotonic,
      "try {",
      "  $canSwap = $true",
      "  $stopMs = Get-BootMilliseconds",
      "  $parentGate = [Threading.ManualResetEvent]::new($false)",
      phases,
    ].join("\n"),
  );
  const began = performance.now();
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-File", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: HELPER_ARM_WAIT_MS + WINDOWS_FINALIZE_FILE_IO_MS + 5_000,
    },
  );
  const elapsed = Math.round(performance.now() - began);
  if (
    result.status !== 0 ||
    !existsSync(started) ||
    readFileSync(started, "utf8") !== "start\n"
  ) {
    throw new Error(
      `The ${name} fault did not finish with one guarded start admission`,
    );
  }
  if (existsSync(swapping) !== (name === "manifest" || name === "receipt")) {
    throw new Error(`The ${name} fault admitted the wrong swap worker`);
  }
  if (
    name === "receipt" &&
    (!result.stderr.includes(WINDOWS_RESTORE_RECEIPT_WRITE_WARNING) ||
      existsSync(scheduled.markerPath))
  ) {
    throw new Error("A timed-out receipt writer published after the attempt");
  }
  return elapsed;
}

let ownsTask = false;
let old: ChildProcess | null = null;
let finalizer: ChildProcess | null = null;
async function run(): Promise<void> {
  mkdirSync(dirname(installedExe), { recursive: true });
  mkdirSync(dirname(windowsHiddenHostLauncherPath(label)), { recursive: true });
  mkdirSync(dirname(workerCli), { recursive: true });
  copyFileSync(proofHost, installedExe);
  copyFileSync(cli, liveCli);
  copyFileSync(cli, workerCli);
  writeFileSync(
    join(dirname(installedExe), "t18-fixture.json"),
    JSON.stringify({
      root,
      pidFile: hostPath,
      hostVersion: version,
      powerShellPath: powershell,
    }),
  );
  await writeHostInstallRecord("dev", {
    version,
    runtimeVersion: null,
    platform: "win32",
    arch: "x64",
    installId: "t18-disposable",
    installedAt: new Date().toISOString(),
    source: { kind: "local-file", value: installedExe },
    archiveSha256: null,
    executableSha256: createHash("sha256")
      .update(readFileSync(installedExe))
      .digest("hex"),
    signatureVerifiedAt: null,
    signatureKeyId: "local-file:unsigned",
    sizeBytes: statSync(installedExe).size,
    executablePath: installedExe,
  });
  const user = command(whoami, ["/user", "/fo", "csv", "/nh"]).match(
    /S-1(?:-\d+){3,}/,
  )?.[0];
  if (user === undefined)
    throw new Error("The ordinary Windows principal was not confirmed");
  const argumentsForCli = {
    command: liveCli,
    args: ["--no-bootstrap", "--non-interactive"],
  };
  const environment = [
    ["HOME", root],
    ["USERPROFILE", root],
    ["DEV_DESKTOP_SLOT", slot],
  ]
    .map(
      ([name, value]) =>
        `shell.Environment("Process").Item("${name}") = "${value?.replaceAll('"', '""')}"`,
    )
    .join("\r\n");
  const launcher = buildWindowsHiddenHostLauncher(
    argumentsForCli,
    label,
  ).replace(
    'Set shell = CreateObject("WScript.Shell")',
    `Set shell = CreateObject("WScript.Shell")\r\n${environment}`,
  );
  const launcherPath = windowsHiddenHostLauncherPath(label);
  writeFileSync(launcherPath, `\uFEFF${launcher}`);
  const taskXmlPath = join(root, "task.xml");
  const taskXml = buildScheduledTaskXml(
    {
      label,
      cli: argumentsForCli,
      windowsBootRunLevel: mode === "Boot" ? "HighestAvailable" : null,
    },
    user,
    true,
  );
  writeFileSync(taskXmlPath, `\uFEFF${taskXml}`, "utf16le");
  if (proofCase === "prepare") return;
  if (mode === "Logon") {
    command(schtasks, ["/Create", "/TN", task, "/XML", taskXmlPath]);
    ownsTask = true;
  } else {
    const query = command(schtasks, ["/Query", "/TN", task, "/XML"]);
    if (!query.includes("<BootTrigger>") || !query.includes(launcherPath)) {
      throw new Error(
        "The administrator-provisioned boot fixture does not match",
      );
    }
    ownsTask = true;
  }
  if (oldCli !== undefined) {
    if (
      resolve(oldCli) !==
      join(dirname(process.execPath), "traycer-win-restore-legacy-writer.exe")
    ) {
      throw new Error("The legacy writer does not belong to this proof kit");
    }
    copyFileSync(cli, stagedCli);
    command(oldCli, [root, liveCli, stagedCli]);
  }
  const cold = proofCase === "cold" || proofCase === "deadline";
  if (cold) {
    touch("fresh.allow-metadata");
    touch("fresh.allow-ready");
  } else {
    old = spawn(installedExe, ["--t18-stale-runtime"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await awaitFile("stale.metadata.json", 10_000);
  }
  const began = performance.now();
  const attempt = cliRestore(oldCli !== undefined);
  finalizer = attempt.child;
  let drainingRefused = false;
  let unreadyRefused = false;
  let wrongGenerationRefused = false;
  let expectedGenerationMatched = false;
  if (!cold) {
    await awaitFile("fresh.metadata.json", 100_000);
    const stale = await awaitFile("stale.metadata.json", 5_000);
    const temporary = `${hostPath}.stale`;
    copyFileSync(stale, temporary);
    renameSync(temporary, hostPath);
    // A second TCP check can only run after the previous readiness decision
    // has refused. Observing the first connection would leave that decision
    // still in flight.
    await awaitCount("stale.probed", 2);
    drainingRefused = !existsSync(join(root, "stale.activity"));
    if (!drainingRefused)
      throw new Error("The stale runtime was used as readiness evidence");

    const witnessPath = join(dirname(hostPath), "supervisor-run.json");
    const end = performance.now() + 5_000;
    while (!existsSync(witnessPath)) {
      if (performance.now() >= end)
        throw new Error("The supervisor did not publish its spawn");
      await new Promise<void>((wake) => setTimeout(wake, 30));
    }
    const originalWitness = JSON.parse(readFileSync(witnessPath, "utf8"));
    const freshMetadata = JSON.parse(
      readFileSync(join(root, "fresh.metadata.json"), "utf8"),
    );
    const expected = originalWitness.spawnedRuntime;
    if (
      expected.installGeneration !== "id:t18-disposable" ||
      expected.pid !== freshMetadata.pid ||
      expected.processStartIdentity !== freshMetadata.processStartIdentity ||
      freshMetadata.version !== version
    )
      throw new Error(
        "The runtime's actual install generation was not witnessed",
      );
    const writeWitness = (value: object): void => {
      const temporary = `${witnessPath}.fixture`;
      writeFileSync(temporary, JSON.stringify(value));
      renameSync(temporary, witnessPath);
    };
    writeWitness({
      ...originalWitness,
      spawnedRuntime: {
        ...expected,
        installGeneration: "id:t18-different-generation",
      },
    });
    touch("fresh.allow-metadata");
    await awaitCount("fresh.probed", 2);
    wrongGenerationRefused = !existsSync(join(root, "fresh.activity"));
    if (!wrongGenerationRefused)
      throw new Error(
        "The same-version runtime with a different generation reached readiness",
      );
    writeWitness(originalWitness);
    expectedGenerationMatched =
      expected.installGeneration === "id:t18-disposable";
    await awaitCount("fresh.activity", 2);
    unreadyRefused = !existsSync(join(root, "fresh.served"));
    if (!unreadyRefused) throw new Error("Restoration accepted a 503 response");
    touch("fresh.allow-ready");
  }
  const finalizerTerminated = await Promise.race([
    attempt.finished,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error("The disposable finalizer exceeded its deadline")),
        HOST_START_ADOPTION_MAX_AGE_MS,
      );
      timer.unref();
    }),
  ]);
  const elapsed = Math.round(performance.now() - began);
  if (
    restorationOutcome(finalizerTerminated) !== "restored" ||
    !existsSync(join(root, "fresh.served")) ||
    existsSync(join(root, "stale.activity"))
  ) {
    throw new Error("The finalizer did not require the fresh serving fixture");
  }
  const pendingWrittenByOldCli =
    oldCli !== undefined &&
    !existsSync(stagedCli) &&
    JSON.parse(readFileSync(cliManifestPath("dev"), "utf8")).pendingUpgrade ===
      null;
  if (oldCli !== undefined && !pendingWrittenByOldCli) {
    throw new Error("The old writer's pending upgrade did not finalize");
  }
  touch("fresh.stop");
  await awaitFile("fresh.published", 5_000);
  if (cold) {
    let watchdog = {};
    if (proofCase === "deadline") {
      watchdog = {
        parentExitMs: await watchdogFault("parent"),
        launchMs: await watchdogFault("launch"),
        manifestMs: await watchdogFault("manifest"),
        receiptMs: await watchdogFault("receipt"),
      };
    }
    writeFileSync(
      resultPath,
      JSON.stringify({
        coldRecovered: true,
        coldElapsedMs: elapsed,
        coldStartBudgetMs: HOST_START_ADOPTION_MAX_AGE_MS,
        ...watchdog,
      }),
      { flag: "wx" },
    );
    return;
  }
  spawnSync(schtasks, ["/End", "/TN", task], {
    stdio: "ignore",
    timeout: 10_000,
  });
  command(schtasks, ["/Change", "/TN", task, "/DISABLE"]);
  rmSync(hostPath, { force: true });
  const disabled = cliRestore(false);
  finalizer = disabled.child;
  const disabledRefused =
    restorationOutcome(await disabled.finished) === "restore-failed";
  const afterDisable = command(schtasks, ["/Query", "/TN", task, "/XML"]);
  const disabledTaskStillDisabled =
    /<Settings>[\s\S]*?<Enabled>false<\/Enabled>[\s\S]*?<\/Settings>/u.test(
      afterDisable,
    );
  writeFileSync(
    resultPath,
    JSON.stringify({
      staleRestored: !drainingRefused,
      unreadyRestored: !unreadyRefused,
      freshRestored: true,
      expectedGenerationMatched,
      wrongGenerationRefused,
      disabledRefused,
      disabledTaskStillDisabled,
      pendingWrittenByOldCli,
    }),
    { flag: "wx" },
  );
}

void run()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "The restoration fixture failed",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (proofCase === "prepare") return;
    touch("fresh.stop");
    touch("stale.stop");
    if (old?.exitCode === null) old.kill();
    if (finalizer?.exitCode === null) finalizer.kill();
    if (ownsTask) {
      spawnSync(schtasks, ["/End", "/TN", task], {
        stdio: "ignore",
        timeout: 10_000,
      });
      spawnSync(schtasks, ["/Delete", "/TN", task, "/F"], {
        stdio: "ignore",
        timeout: 10_000,
      });
    }
    const metadata = join(root, "fresh.metadata.json");
    if (!existsSync(metadata)) return;
    const pid = JSON.parse(readFileSync(metadata, "utf8")).pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    const end = performance.now() + 5_000;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH")
          return;
        throw error;
      }
      if (performance.now() >= end)
        throw new Error("The disposable host did not stop");
      await new Promise<void>((wake) => setTimeout(wake, 50));
    }
  });
