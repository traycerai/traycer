import type { ChromiumImportBrowser } from "../chromium-browsers";
import type { CommandRunner } from "./run-command";
import type { SecretReadResult } from "./secret-read-result";

/**
 * The Linux half of Chromium's `v11` key: the browser's password in the
 * Secret Service keyring (GNOME Keyring, KeePassXC's bridge, ...), read with
 * `secret-tool`. The `application` attribute is what the browsers file their
 * item under, and it is not always the browser's own name.
 *
 * A KWallet-only desktop has no Secret Service and answers `unavailable`;
 * the cookie-file import is the way through there.
 */

const SECRET_TOOL_BINARY = "secret-tool";
/** An unlock dialog for a locked keyring waits on a person. */
const KEYRING_PROMPT_TIMEOUT_MS = 120_000;

const SECRET_SERVICE_APPLICATION: Readonly<
  Record<ChromiumImportBrowser, string>
> = {
  chrome: "chrome",
  chromium: "chromium",
  edge: "chromium",
  brave: "brave",
  arc: "chromium",
  vivaldi: "chrome",
  opera: "chromium",
};

export async function readLinuxSecretServicePassphrase(
  browser: ChromiumImportBrowser,
  run: CommandRunner,
): Promise<SecretReadResult> {
  const result = await run({
    file: SECRET_TOOL_BINARY,
    args: ["lookup", "application", SECRET_SERVICE_APPLICATION[browser]],
    stdin: null,
    timeoutMs: KEYRING_PROMPT_TIMEOUT_MS,
  });
  if (result.kind !== "exited" || result.exitCode !== 0) {
    return { ok: false, reason: "unavailable" };
  }
  const secret = result.stdout.replace(/\r?\n$/u, "");
  return secret.length === 0
    ? { ok: false, reason: "unavailable" }
    : { ok: true, secret };
}
