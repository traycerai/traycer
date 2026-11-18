import { dirname } from "node:path";
import { z } from "zod";
import type {
  ExternalAction,
  ObjectFingerprint,
} from "@traycer/protocol/config/data-migration-contracts";
import type { ServiceLabel } from "../../service/label";
import { runCommand } from "../../service/process-runner";
import { wellKnownCliBinaryPath } from "../../store/well-known-cli";
import {
  ABSENT_FINGERPRINT,
  ExternalActionConflictError,
  externalActionId,
  layoutUnderRoot,
  pathInsideRoot,
  presentFingerprint,
  rebaseRootPath,
  samePath,
  type ExternalActionBlocker,
  type ExternalActionPlan,
} from "./ledger";
import type { DataRootPair } from "./windows-task-actions";

/**
 * The user's `PATH` (`HKCU\Environment\Path`), for the one entry Traycer
 * documents: the well-known CLI bin folder (`<root>\cli\bin` for production,
 * the environment's own folder otherwise). The installers write no PATH entry
 * (`scripts/native-packaging/docs/INSTALL.md` asks the user to add it), so the
 * migration owns an entry only when its value, after `%VAR%` expansion, is
 * exactly a migrated environment's source CLI bin folder. That entry is
 * replaced IN PLACE by the destination folder; every other entry, the order,
 * the separators, empty entries and the value's registry kind (`REG_SZ` or
 * `REG_EXPAND_SZ`) are kept byte for byte.
 *
 * Any OTHER entry that resolves inside the source root is not the
 * migration's to rewrite, and after source cleanup it would name a deleted
 * folder: the planner refuses with `unowned-path-reference` so the user
 * removes or changes it first.
 *
 * Machine `PATH` (HKLM) is never read or written: a per-user install owns
 * nothing there. Shortcuts: Traycer creates none (the NSIS Start-menu and
 * desktop shortcuts target the app's install folder, which this migration
 * does not move), so there is no shortcut action.
 */
export const WINDOWS_USER_PATH_ADAPTER = "windows-user-path";

const OBJECT = "HKCU\\Environment\\Path";

const valueKindSchema = z.enum(["String", "ExpandString"]);

export const windowsUserPathForwardSchema = z.strictObject({
  adapter: z.literal(WINDOWS_USER_PATH_ADAPTER),
  version: z.literal(1),
  stage: z.literal("prepare"),
  valueKind: valueKindSchema,
  value: z.string(),
});

export const windowsUserPathInverseSchema = z.strictObject({
  adapter: z.literal(WINDOWS_USER_PATH_ADAPTER),
  version: z.literal(1),
  valueKind: valueKindSchema,
  value: z.string(),
});

export type UserPathValue =
  | { readonly kind: "absent" }
  | {
      readonly kind: "value";
      readonly valueKind: z.infer<typeof valueKindSchema>;
      readonly value: string;
    };

export type WindowsUserPathDeps = {
  readonly read: () => Promise<UserPathValue>;
  /** Writes `next` only while the value is exactly `expected`; false otherwise. */
  readonly compareAndSet: (
    expected: Extract<UserPathValue, { kind: "value" }>,
    next: Extract<UserPathValue, { kind: "value" }>,
  ) => Promise<boolean>;
  readonly env: NodeJS.ProcessEnv;
};

// Reads the raw (unexpanded) value and its registry kind. Output:
// `absent`, or `<kind>:<base64 of the UTF-16LE value>` - base64 so no console
// code page can alter a Unicode folder name on the way out.
const READ_SCRIPT =
  "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment');if($null -eq $k){[Console]::Out.Write('absent');exit 0};if(-not (@($k.GetValueNames())|Where-Object{$_ -ieq 'Path'})){[Console]::Out.Write('absent');exit 0};$kind=[string]$k.GetValueKind('Path');$v=[string]$k.GetValue('Path',$null,'DoNotExpandEnvironmentNames');[Console]::Out.Write($kind+':'+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($v)))";

// Compare-and-set inside one PowerShell: exit 3 when the value or its kind is
// not the expected one, 0 after writing. The empty-variable delete is the
// documented way to make .NET broadcast WM_SETTINGCHANGE, so a new Explorer
// shell sees the new PATH without a sign-out. Values travel base64 in the
// environment, never on the command line.
const COMPARE_AND_SET_SCRIPT =
  "try{$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true);$kind=[string]$k.GetValueKind('Path');$v=[string]$k.GetValue('Path',$null,'DoNotExpandEnvironmentNames')}catch{exit 3};$ev=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:TRAYCER_PATH_EXPECT_B64));if(($kind -cne $env:TRAYCER_PATH_EXPECT_KIND) -or ($v -cne $ev)){exit 3};$nv=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:TRAYCER_PATH_NEXT_B64));$k.SetValue('Path',$nv,[Microsoft.Win32.RegistryValueKind]$env:TRAYCER_PATH_NEXT_KIND);try{[Environment]::SetEnvironmentVariable('TRAYCER_PATH_CHANGE_NOTICE',$null,'User')}catch{};exit 0";

const POWERSHELL_TIMEOUT_MS = 30_000;

function encode(value: string): string {
  return Buffer.from(value, "utf16le").toString("base64");
}

async function readUserPathFromRegistry(): Promise<UserPathValue> {
  const result = await runCommand(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", READ_SCRIPT],
    {
      env: undefined,
      cwd: undefined,
      timeoutMs: POWERSHELL_TIMEOUT_MS,
      tolerateNonZeroExit: false,
    },
  );
  const out = result.stdout.trim();
  if (out === "absent") return { kind: "absent" };
  const match = /^(String|ExpandString):([A-Za-z0-9+/=]*)$/u.exec(out);
  if (match === null) {
    throw new Error("the user PATH is not a string value");
  }
  return {
    kind: "value",
    valueKind: valueKindSchema.parse(match[1]),
    value: Buffer.from(match[2] ?? "", "base64").toString("utf16le"),
  };
}

async function compareAndSetUserPathInRegistry(
  expected: Extract<UserPathValue, { kind: "value" }>,
  next: Extract<UserPathValue, { kind: "value" }>,
): Promise<boolean> {
  const result = await runCommand(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", COMPARE_AND_SET_SCRIPT],
    {
      env: {
        ...process.env,
        TRAYCER_PATH_EXPECT_KIND: expected.valueKind,
        TRAYCER_PATH_EXPECT_B64: encode(expected.value),
        TRAYCER_PATH_NEXT_KIND: next.valueKind,
        TRAYCER_PATH_NEXT_B64: encode(next.value),
      },
      cwd: undefined,
      timeoutMs: POWERSHELL_TIMEOUT_MS,
      tolerateNonZeroExit: true,
    },
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 3) return false;
  throw new Error(
    `the user PATH could not be written (exit ${String(result.exitCode)})`,
  );
}

let depsOverride: WindowsUserPathDeps | null = null;

/** Test-only replacement for the registry read/write and the environment. */
export function setWindowsUserPathDepsForTests(
  deps: WindowsUserPathDeps | null,
): void {
  depsOverride = deps;
}

function deps(): WindowsUserPathDeps {
  return (
    depsOverride ?? {
      read: readUserPathFromRegistry,
      compareAndSet: compareAndSetUserPathInRegistry,
      env: process.env,
    }
  );
}

function fingerprintOf(value: UserPathValue): ObjectFingerprint {
  return value.kind === "absent"
    ? ABSENT_FINGERPRINT
    : presentFingerprint({ valueKind: value.valueKind, value: value.value });
}

/** `%NAME%` expanded from `env` (names case-insensitive); unknown names kept. */
function expandEnvironment(value: string, env: NodeJS.ProcessEnv): string {
  const lookup = new Map<string, string>();
  for (const [name, entry] of Object.entries(env)) {
    if (entry !== undefined) lookup.set(name.toUpperCase(), entry);
  }
  return value.replace(
    /%([^%;]+)%/gu,
    (whole, name: string) => lookup.get(name.toUpperCase()) ?? whole,
  );
}

function unquote(segment: string): {
  readonly text: string;
  readonly quoted: boolean;
} {
  const trimmed = segment.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return { text: trimmed.slice(1, -1), quoted: true };
  }
  return { text: trimmed, quoted: false };
}

function isAbsoluteWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value);
}

/** The well-known CLI bin folder of each migrated environment, under `root`. */
function cliBinFolders(
  labels: readonly ServiceLabel[],
  root: string,
): readonly string[] {
  const folders = new Set<string>();
  for (const label of labels) {
    const binary = wellKnownCliBinaryPath(label.environment);
    folders.add(layoutUnderRoot(dirname(binary), root, "win32"));
  }
  return [...folders];
}

export async function planWindowsUserPathRelocation(input: {
  readonly labels: readonly ServiceLabel[];
  readonly roots: DataRootPair;
}): Promise<ExternalActionPlan> {
  const { roots } = input;
  const current = await deps().read();
  if (current.kind === "absent") return { actions: [], blockers: [] };
  const sourceBins = cliBinFolders(input.labels, roots.sourceRoot);
  const blockers: ExternalActionBlocker[] = [];
  let changed = false;
  const segments = current.value.split(";").map((segment) => {
    const { text, quoted } = unquote(segment);
    if (text.length === 0) return segment;
    const expanded = expandEnvironment(text, deps().env);
    if (!isAbsoluteWindowsPath(expanded)) return segment;
    const index = sourceBins.findIndex((bin) =>
      samePath(expanded, bin, "win32"),
    );
    if (index >= 0) {
      const destination =
        rebaseRootPath(
          sourceBins[index] ?? "",
          roots.sourceRoot,
          roots.destinationRoot,
          "win32",
        ) ?? "";
      changed = true;
      return quoted ? `"${destination}"` : destination;
    }
    if (pathInsideRoot(expanded, roots.sourceRoot, "win32") !== null) {
      blockers.push({
        code: "unowned-path-reference",
        object: `${OBJECT}: ${text}`,
        message:
          "this PATH entry points inside the Traycer data folder but is not the CLI folder Traycer documents; remove or change it before migrating",
      });
    }
    return segment;
  });
  if (!changed || blockers.length > 0) return { actions: [], blockers };
  const next = { ...current, value: segments.join(";") };
  return {
    actions: [
      {
        id: externalActionId("path", OBJECT),
        kind: "path-entry",
        object: OBJECT,
        before: fingerprintOf(current),
        after: fingerprintOf(next),
        forward: {
          adapter: WINDOWS_USER_PATH_ADAPTER,
          version: 1,
          stage: "prepare",
          valueKind: next.valueKind,
          value: next.value,
        },
        inverse: {
          adapter: WINDOWS_USER_PATH_ADAPTER,
          version: 1,
          valueKind: current.valueKind,
          value: current.value,
        },
        state: "planned",
      },
    ],
    blockers,
  };
}

export async function observeWindowsUserPath(): Promise<ObjectFingerprint> {
  return fingerprintOf(await deps().read());
}

async function swapUserPath(
  expected: Extract<UserPathValue, { kind: "value" }>,
  next: Extract<UserPathValue, { kind: "value" }>,
): Promise<void> {
  if (!(await deps().compareAndSet(expected, next))) {
    throw new ExternalActionConflictError(
      OBJECT,
      "the user PATH changed since the migration recorded it",
    );
  }
}

export function applyWindowsUserPath(action: ExternalAction): Promise<void> {
  const forward = windowsUserPathForwardSchema.parse(action.forward);
  const inverse = windowsUserPathInverseSchema.parse(action.inverse);
  return swapUserPath(
    { kind: "value", valueKind: inverse.valueKind, value: inverse.value },
    { kind: "value", valueKind: forward.valueKind, value: forward.value },
  );
}

export function invertWindowsUserPath(action: ExternalAction): Promise<void> {
  const forward = windowsUserPathForwardSchema.parse(action.forward);
  const inverse = windowsUserPathInverseSchema.parse(action.inverse);
  return swapUserPath(
    { kind: "value", valueKind: forward.valueKind, value: forward.value },
    { kind: "value", valueKind: inverse.valueKind, value: inverse.value },
  );
}
