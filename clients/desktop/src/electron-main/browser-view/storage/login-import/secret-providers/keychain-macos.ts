import type { ChromiumImportBrowser } from "../chromium-browsers";
import type { CommandRunner } from "./run-command";
import type { SecretReadResult } from "./secret-read-result";

/**
 * The macOS half of Chromium's `v10` key: the "<Browser> Safe Storage"
 * generic password in the user's login keychain, read with the system
 * `security` tool.
 *
 * This is the one OS prompt the whole import raises, and the dialog has said
 * which button to press before it appears: **Allow**, not Always Allow. The
 * latter writes `/usr/bin/security` into the ACL of the user's own Chrome
 * key for good, which is a wider grant than one import needs.
 */

const SECURITY_BINARY = "/usr/bin/security";
/** `errSecItemNotFound`, as `security` exits with it. */
const SECURITY_EXIT_ITEM_NOT_FOUND = 44;
/** A keychain dialog waits on a person; a minute is not a bug. */
const KEYCHAIN_PROMPT_TIMEOUT_MS = 120_000;

const KEYCHAIN_ITEMS: Readonly<
  Record<
    ChromiumImportBrowser,
    { readonly service: string; readonly account: string }
  >
> = {
  chrome: { service: "Chrome Safe Storage", account: "Chrome" },
  chromium: { service: "Chromium Safe Storage", account: "Chromium" },
  edge: { service: "Microsoft Edge Safe Storage", account: "Microsoft Edge" },
  brave: { service: "Brave Safe Storage", account: "Brave" },
  arc: { service: "Arc Safe Storage", account: "Arc" },
  vivaldi: { service: "Vivaldi Safe Storage", account: "Vivaldi" },
  opera: { service: "Opera Safe Storage", account: "Opera" },
};

export async function readMacosKeychainPassphrase(
  browser: ChromiumImportBrowser,
  run: CommandRunner,
): Promise<SecretReadResult> {
  const item = KEYCHAIN_ITEMS[browser];
  const result = await run({
    file: SECURITY_BINARY,
    args: [
      "find-generic-password",
      "-w",
      "-s",
      item.service,
      "-a",
      item.account,
    ],
    stdin: null,
    timeoutMs: KEYCHAIN_PROMPT_TIMEOUT_MS,
  });
  if (result.kind !== "exited") return { ok: false, reason: "unavailable" };
  if (result.exitCode === SECURITY_EXIT_ITEM_NOT_FOUND) {
    return { ok: false, reason: "unavailable" };
  }
  if (result.exitCode !== 0) return { ok: false, reason: "denied" };
  // `-w` prints the password alone, newline-terminated.
  const secret = result.stdout.replace(/\r?\n$/u, "");
  return secret.length === 0
    ? { ok: false, reason: "unavailable" }
    : { ok: true, secret };
}
