import type { CommandRunner } from "./run-command";

/**
 * The Windows half of Chromium's `v10` key. `Local State` holds
 * `os_crypt.encrypted_key`: base64 of the literal bytes `DPAPI` followed by
 * the AES-256 key sealed to the current user with DPAPI. Unsealing needs the
 * Win32 `CryptUnprotectData`, which this shell reaches through PowerShell's
 * `ProtectedData` rather than a native module.
 *
 * The sealed blob goes to PowerShell on **stdin**. On argv it would sit in
 * the process table for every other process on the machine to read.
 */

const POWERSHELL_BINARY = "powershell.exe";
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

/**
 * The AES-256-GCM key, or `null` when the blob is not one this user can
 * open: another account's profile, a missing prefix, or PowerShell refusing.
 */
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
    file: POWERSHELL_BINARY,
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
