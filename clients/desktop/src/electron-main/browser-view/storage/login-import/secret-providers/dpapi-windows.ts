import { win32 } from "node:path";
import type { CommandRunner } from "./run-command";


/** Windows PowerShell by its absolute path, never by lookup: `spawn` would search `PATH` in order, and a writable directory ahead of System32 could supply a `powershell.exe` that. */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return win32.join(
    env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}
const DPAPI_TIMEOUT_MS = 30_000;
const DPAPI_PREFIX = Buffer.from("DPAPI", "latin1");
const CHROMIUM_GCM_KEY_LENGTH = 32;

const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$sealed = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
  "$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser",
  "$key = [System.Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, $scope)",
  "[Console]::Out.Write([Convert]::ToBase64String($key))",
].join("; ");

export async function unprotectChromiumWindowsKey(
  encryptedKeyBase64: string,
  run: CommandRunner,
): Promise<Buffer | null> {
  const sealed = Buffer.from(encryptedKeyBase64, "base64");
  if (
    sealed.length <= DPAPI_PREFIX.length ||
    !sealed.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX)
  ) {
    return null;
  }
  const result = await run({
    file: windowsPowerShellPath(process.env),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      UNPROTECT_SCRIPT,
    ],
    stdin: sealed.subarray(DPAPI_PREFIX.length).toString("base64"),
    timeoutMs: DPAPI_TIMEOUT_MS,
  });
  if (result.kind !== "exited" || result.exitCode !== 0) return null;
  const key = Buffer.from(result.stdout.trim(), "base64");
  return key.length === CHROMIUM_GCM_KEY_LENGTH ? key : null;
}
