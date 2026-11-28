import commands from "../commands.cjs";
import {
  parseStopIntent,
  hostStopIntentPath,
} from "@traycer/protocol/config/host-stop-intent";
import { getPublishedProcessIdentityVerdict } from "../../../src/store/process-identity";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildScheduledTaskXml,
  queryScheduledTaskXml,
  parseWindowsTaskExecAction,
  buildWindowsTaskActionForLauncher,
  buildWindowsHiddenHostLauncher,
  windowsHiddenHostLauncherPath,
} from "../../../src/service/platforms/windows";
import { serviceLabelFor, windowsTaskName } from "../../../src/service/label";
import {
  cliInstallHomeDir,
  cliLogPath,
  cliManifestPath,
  cliSharedHomeDir,
  hostHomeDir,
  hostInstallDir,
} from "../../../src/store/paths";
import { writeHostInstallRecord } from "../../../src/manifest/host-install";
import { writeCliManifest } from "../../../src/manifest/cli-manifest";
import { trustedKeysOverlayPath } from "../../../src/registry/trusted-keys";
import { readSupervisorRunState } from "../../../src/host/lifecycle-files";
import { readHostPidMetadata } from "../../../src/host/pid-metadata";
import { probeHostReady } from "@traycer-clients/shared/host-client/host-activity-probe";
import { acquireUpdateAttemptLock } from "@traycer-clients/shared/host-update";
import { releaseFeedTarget } from "../../../src/config";
import {
  createFeedSigningKey,
  feedPayload,
  signFeedPayload,
} from "../../../src/registry/__tests__/signed-feed-test-helpers";
import {
  WINDOWS_RESTART_RECOVERY_ADMISSION_MS,
  WINDOWS_RESTART_RECOVERY_MS,
} from "../../../src/upgrade/finalize-helper";
import {
  WINDOWS_RESTORE_RECEIPT_WRITE_WARNING,
  WINDOWS_RESTORE_UNCONFIRMED,
} from "../../../src/service/windows-task-restoration";

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
  (oldCli !== undefined && (mode !== "Logon" || proofCase !== "legacy")) ||
  ![
    "cold",
    "legacy",
    "prepare",
    "parent-exit",
    "busy",
    "disabled",
    "receipt",
    "hold-lock",
  ].includes(proofCase)
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
const scratch = join(root, "scratch");
const cliHome = cliInstallHomeDir("dev");
const hostHome = hostHomeDir("dev");
for (const path of [cliHome, hostHome, cliSharedHomeDir()]) {
  if (
    !resolve(path)
      .toLowerCase()
      .startsWith(root.toLowerCase() + sep)
  ) {
    throw new Error("The Traycer fixture must use its disposable home");
  }
}
process.env.TEMP = scratch;
process.env.TMP = scratch;
const stagedCli = join(root, "staged-traycer.exe");

function command(path: string, args: string[]): string {
  const result = spawnSync(path, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 25_000,
  });
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim();
    throw new Error(
      `Disposable command ${path} failed (exit ${result.status}): ${detail}`,
    );
  }
  return result.stdout;
}
function changeFixtureTask(action: "register" | "disable" | "remove"): void {
  command(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(dirname(process.execPath), "Set-ProofTask.ps1"),
    "-Action",
    action,
    "-Root",
    root,
  ]);
}

const installId = "t18-disposable";
const stagedVersion = "1.5.0";
const initialVersion = "1.4.0";
const initialCli = join(dirname(cli), "traycer-live.exe");
const stopProgress = "stopping the host service for a restart";
const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

function signal(name: string): void {
  writeFileSync(join(root, name), "1");
}

async function waitFor<T>(
  explanation: string,
  timeoutMs: number,
  observe: () => T | null | Promise<T | null>,
): Promise<T> {
  const end = performance.now() + timeoutMs;
  do {
    const value = await observe();
    if (value !== null) return value;
    await delay(50);
  } while (performance.now() < end);
  throw new Error(`Timed out waiting for ${explanation}`);
}

function fixtureProcess(
  binary: string,
  args: string[],
  observeLine: ((line: string) => void) | null,
): { child: ChildProcess; done: Promise<number | null> } {
  const child = spawn(binary, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done = new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  void done.catch(() => undefined);
  let partial = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    const lines = (partial + chunk).split(/\r?\n/u);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      observeLine?.(line);
      try {
        const event = JSON.parse(line);
        if (event?.type === "result" && event.status === "ok") {
          console.log("CLI result: ok");
        } else if (event?.type === "result" && event.status === "error") {
          console.error(
            `CLI result: ${event.error.code}: ${event.error.message}`,
          );
        } else if (
          event?.type === "progress" &&
          event.message === stopProgress
        ) {
          console.log(`CLI progress: ${stopProgress}`);
        }
      } catch {}
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    console.error(chunk.trimEnd());
  });
  return { child, done };
}

function runCli(args: string[], observeLine: ((line: string) => void) | null) {
  return fixtureProcess(liveCli, args, observeLine);
}

async function serving(afterPid: number | null): Promise<number | null> {
  const record = await readSupervisorRunState("dev");
  const metadata = await readHostPidMetadata("dev");
  if (record.kind !== "valid" || metadata === null) return null;
  const witness = record.record.spawnedRuntime;
  if (
    metadata.pid === afterPid ||
    witness?.pid !== metadata.pid ||
    witness.processStartIdentity !== metadata.processStartIdentity ||
    witness.installGeneration !== `id:${installId}`
  )
    return null;
  return (await probeHostReady(metadata.websocketUrl, 1000))
    ? metadata.pid
    : null;
}

async function registrationXml(): Promise<string> {
  const result = await queryScheduledTaskXml(task);
  if (result.kind !== "xml")
    throw new Error(`The registered task XML was not readable: ${result.kind}`);
  return result.xml;
}

function fixtureReceiptPath(parentPid: number): string | null {
  const prefix = /^traycer-cli-finalize-dev-[0-9]+-([0-9]+)-[a-f0-9]+\.ps1$/u;
  for (const name of readdirSync(scratch)) {
    if (prefix.exec(name)?.[1] !== String(parentPid)) continue;
    const script = join(scratch, name);
    if (!existsSync(script.replace(/\.ps1$/u, ".armed"))) continue;
    const receiptName =
      /post-finalize\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json/u.exec(
        readFileSync(script, "utf8"),
      )?.[0];
    if (receiptName !== undefined) return join(cliHome, receiptName);
  }
  return null;
}

function helperControl(action: "suspend" | "resume", parentPid: number): void {
  command(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(dirname(process.execPath), "Set-ProofTask.ps1"),
    "-Action",
    action,
    "-Root",
    root,
    "-RestartPid",
    String(parentPid),
  ]);
}

async function holdFixtureLock(): Promise<void> {
  const lock = await acquireUpdateAttemptLock({
    hostHomeDir: hostHome,
    reason: "host-restart",
    waitMs: 15_000,
    pollIntervalMs: 50,
  });
  if (lock.kind !== "acquired")
    throw new Error("The disposable update lock was not acquired");
  try {
    signal("lock-held");
    await waitFor(
      "release of the disposable lock",
      WINDOWS_RESTART_RECOVERY_MS,
      () => (existsSync(join(root, "release-lock")) ? true : null),
    );
  } finally {
    await lock.handle.release();
  }
}

async function writePendingUpgrade(): Promise<void> {
  copyFileSync(cli, stagedCli);
  if (oldCli !== undefined) {
    if (
      resolve(oldCli) !==
      join(dirname(process.execPath), "traycer-win-restore-legacy-writer.exe")
    )
      throw new Error("The legacy writer does not belong to this proof kit");
    command(oldCli, [root, liveCli, stagedCli]);
    return;
  }

  const key = createFeedSigningKey();
  const overlay = trustedKeysOverlayPath();
  mkdirSync(dirname(overlay), { recursive: true });
  writeFileSync(overlay, key.publicKeyText);
  const evidence = signFeedPayload(
    JSON.stringify(
      feedPayload({
        feed: "cli",
        target: releaseFeedTarget(),
        latest: stagedVersion,
        versions: [
          {
            version: stagedVersion,
            releaseNotesUrl: "https://example.test/cli-release",
            platforms: {
              "win32-x64": {
                available: true,
                url: "https://example.test/cli.exe",
                sha256: sha256(stagedCli),
                sizeBytes: statSync(stagedCli).size,
                signatureUrl: "https://example.test/cli.exe.minisig",
                signatureAlgorithm: "minisign",
                publicKeyId: key.keyId,
              },
            },
          },
        ],
      }),
    ),
    key,
  );
  writeFileSync(`${stagedCli}.release-evidence.json`, evidence);
  const now = new Date().toISOString();
  await writeCliManifest("dev", {
    version: initialVersion,
    installedAt: now,
    binaryPath: liveCli,
    source: "manual",
    pendingUpgrade: {
      version: stagedVersion,
      stagedBinaryPath: stagedCli,
      stagedAt: now,
      reason: "binary-locked",
      allowDowngrade: false,
      windowsEvidence: "signed-feed-v1",
    },
  });
}

async function prepareTask(): Promise<void> {
  mkdirSync(dirname(installedExe), { recursive: true });
  mkdirSync(dirname(windowsHiddenHostLauncherPath(label)), { recursive: true });
  mkdirSync(scratch, { recursive: true });
  copyFileSync(proofHost, installedExe);
  copyFileSync(initialCli, liveCli);
  if (
    sha256(initialCli) === sha256(cli) ||
    command(liveCli, ["--version"]).trim() !== initialVersion ||
    command(cli, ["--version"]).trim() !== stagedVersion
  )
    throw new Error(
      "The live and staged CLI fixtures do not have distinct build identities",
    );
  writeFileSync(
    join(dirname(installedExe), "t18-fixture.json"),
    JSON.stringify({
      root,
      pidFile: hostPath,
      hostVersion: version,
      powerShellPath: powershell,
      stopIntentPath:
        proofCase === "parent-exit" ? hostStopIntentPath(hostHome) : null,
    }),
  );
  await writeHostInstallRecord("dev", {
    version,
    runtimeVersion: null,
    platform: "win32",
    arch: "x64",
    installId,
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
    args: commands.supervisor,
  };
  const fixtureVariables = [
    ["HOME", root],
    ["USERPROFILE", root],
    ["DEV_DESKTOP_SLOT", slot],
    ["TEMP", scratch],
    ["TMP", scratch],
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
    `Set shell = CreateObject("WScript.Shell")\r\n${fixtureVariables}`,
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
}

let ownsTask = false;
let parent: ChildProcess | null = null;
let locker: { child: ChildProcess; done: Promise<number | null> } | null = null;
let suspendedParent: number | null = null;

async function run(): Promise<void> {
  console.log(`Preparing ${proofCase} ${mode}: ${root}`);
  if (proofCase === "hold-lock") return holdFixtureLock();
  if (proofCase === "prepare") return prepareTask();
  if (mode === "Logon") {
    await prepareTask();
    changeFixtureTask("register");
  } else {
    const xml = await registrationXml();
    const action = parseWindowsTaskExecAction(xml);
    const expected = buildWindowsTaskActionForLauncher(
      windowsHiddenHostLauncherPath(label),
    );
    if (
      !xml.includes("<BootTrigger>") ||
      action?.command.toLowerCase() !== expected.command.toLowerCase() ||
      action.argumentsLine !== expected.argumentsLine
    ) {
      throw new Error("The boot task does not match its disposable launcher");
    }
  }
  ownsTask = true;
  const first = runCli(commands.serviceStart, null);
  parent = first.child;
  if ((await first.done) !== 0)
    throw new Error("The original service did not start");
  const incumbent = await waitFor("original serving runtime", 30_000, () =>
    serving(null),
  );
  const original = await readHostPidMetadata("dev");
  if (original?.pid !== incumbent)
    throw new Error("The incumbent runtime identity is missing");
  const stagedDigest = sha256(cli);
  await writePendingUpgrade();

  let inStop = false;
  const startedAt = performance.now();
  const restart = runCli(commands.restart, (line) => {
    if (line.includes(stopProgress)) inStop = true;
  });
  parent = restart.child;
  const pid = parent.pid;
  if (pid === undefined) throw new Error("The real host restart did not start");
  const receiptPath = await waitFor(
    "pre-stop ownership by the real helper",
    60_000,
    () => {
      if (parent?.exitCode !== null && !inStop) {
        throw new Error("The real host restart refused before stop");
      }
      return inStop ? fixtureReceiptPath(pid) : null;
    },
  );
  let lockObservedAt: number | null = null;
  if (proofCase === "parent-exit") {
    await waitFor("the restarting parent's durable stop intent", 20_000, () => {
      const path = hostStopIntentPath(hostHome);
      if (!existsSync(path)) return null;
      const intent = parseStopIntent(JSON.parse(readFileSync(path, "utf8")));
      return intent?.requestedByPid === pid && intent.reason === "restart"
        ? true
        : null;
    });
    if (restart.child.exitCode !== null || !restart.child.kill())
      throw new Error("The restart parent exited before fault injection");
    await waitFor("the original runtime to exit", 30_000, async () => {
      const verdict = await getPublishedProcessIdentityVerdict(
        original.pid,
        original.processStartIdentity,
      );
      return verdict === "dead" || verdict === "mismatch" ? true : null;
    });
  }
  if (
    proofCase === "busy" ||
    proofCase === "disabled" ||
    proofCase === "receipt"
  ) {
    helperControl("suspend", pid);
    suspendedParent = pid;
  }

  const exit = await restart.done;
  if (proofCase !== "parent-exit" && exit !== 0)
    throw new Error(`The real restart command exited ${exit}`);

  if (proofCase === "busy") {
    const hold = fixtureProcess(
      process.execPath,
      [
        "--case",
        "hold-lock",
        "--mode",
        mode,
        "--root",
        root,
        "--cli",
        cli,
        "--task",
        task,
      ],
      null,
    );
    locker = hold;
    await waitFor("external update lock", 15_000, () =>
      existsSync(join(root, "lock-held")) ? true : null,
    );
    lockObservedAt = performance.now();
  } else if (proofCase === "disabled") {
    changeFixtureTask("disable");
  } else if (proofCase === "receipt") {
    // A directory at the generated receipt pathname prevents file publication.
    mkdirSync(receiptPath);
  }
  if (suspendedParent !== null) {
    helperControl("resume", suspendedParent);
    suspendedParent = null;
  }

  if (proofCase === "receipt") {
    await waitFor(
      "the bounded receipt-write warning",
      WINDOWS_RESTART_RECOVERY_MS,
      () =>
        existsSync(cliLogPath("dev")) &&
        readFileSync(cliLogPath("dev"), "utf8").includes(
          WINDOWS_RESTORE_RECEIPT_WRITE_WARNING,
        )
          ? true
          : null,
    );
    if (!statSync(receiptPath).isDirectory())
      throw new Error("An unwritable receipt was published");
  } else {
    const receipt = await waitFor(
      "the real coordinator's receipt",
      WINDOWS_RESTART_RECOVERY_MS,
      () =>
        existsSync(receiptPath)
          ? JSON.parse(readFileSync(receiptPath, "utf8"))
          : null,
    );
    const expectedStatus =
      proofCase === "busy"
        ? "swap-failed"
        : proofCase === "parent-exit"
          ? "start-only"
          : "swapped";
    const failedStart = proofCase === "disabled" || proofCase === "busy";
    if (
      receipt.status !== expectedStatus ||
      receipt.serviceStartError !==
        (failedStart ? WINDOWS_RESTORE_UNCONFIRMED : null)
    )
      throw new Error(
        `Unexpected terminal receipt for ${proofCase}: ${receipt.status}`,
      );
    if (failedStart) {
      if (
        proofCase === "disabled" &&
        !/<Settings>[\s\S]*?<Enabled>false<\/Enabled>[\s\S]*?<\/Settings>/u.test(
          await registrationXml(),
        )
      )
        throw new Error("The recovery changed the disabled task");
      if (
        proofCase === "busy" &&
        (lockObservedAt === null ||
          performance.now() - lockObservedAt <
            WINDOWS_RESTART_RECOVERY_ADMISSION_MS)
      )
        throw new Error(
          "The external lock was not held through the admission share",
        );
      if ((await serving(null)) !== null || runtimePids().length !== 1)
        throw new Error("A recovery runtime started despite the refusal");
      console.log(`PASS ${proofCase} ${mode} refused with a terminal receipt`);
      return;
    }
  }

  await waitFor("the expected generation serving after recovery", 30_000, () =>
    serving(incumbent),
  );
  if (runtimePids().length !== 2) {
    throw new Error("The recovery spawned more than one replacement");
  }
  const manifest = JSON.parse(readFileSync(cliManifestPath("dev"), "utf8"));
  if (
    proofCase === "parent-exit"
      ? manifest.pendingUpgrade === null
      : manifest.pendingUpgrade !== null
  )
    throw new Error(
      "The coordinator applied the wrong pending upgrade outcome",
    );
  if (
    proofCase !== "parent-exit" &&
    (sha256(liveCli) !== stagedDigest ||
      command(liveCli, ["--version"]).trim() !== stagedVersion)
  )
    throw new Error(
      "The installed CLI did not change to the staged bytes and version",
    );
  const elapsedMs = Math.round(performance.now() - startedAt);
  console.log(
    `PASS ${proofCase} ${mode} expected generation served in ${elapsedMs} ms`,
  );
}

function runtimePids(): string[] {
  return readdirSync(root).filter((name) =>
    /^runtime\.[0-9]+\.json$/u.test(name),
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
    if (proofCase === "hold-lock" || proofCase === "prepare") return;
    try {
      if (suspendedParent !== null) helperControl("resume", suspendedParent);
    } finally {
      if (parent?.exitCode === null) parent.kill();
      if (locker?.child.exitCode === null) signal("release-lock");
      try {
        if (locker !== null && (await locker.done) !== 0)
          throw new Error("The disposable lock holder did not release cleanly");
      } finally {
        if (ownsTask) changeFixtureTask("remove");
      }
    }
  })
  .catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "The restoration fixture could not clean up",
    );
    process.exitCode = 1;
  });
