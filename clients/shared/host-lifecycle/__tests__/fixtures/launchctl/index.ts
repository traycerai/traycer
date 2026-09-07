import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **Captured `launchctl print` bytes.** Not hand-written.
 * That is the point: three of this changeset's findings were *fixture-level vacuity* - sound assertions over inputs launchd cannot emit.
 */
const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

function read(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

/**
 * This one blob is the counter-example to two findings at once: `has lwcr` on a job that is unambiguously fine, and a bare three-token `arguments` block ending in `host start`.
 */
export const HEALTHY_TRAYCER_AGENT_PRINT = read(
  "agent-healthy-smappservice.print.txt",
);

export const THIRD_PARTY_HAS_LWCR_PRINT = read(
  "third-party-submitted-has-lwcr.print.txt",
);

export const SYSTEM_AGENT_BARE_ARGUMENTS_PRINT = read(
  "system-agent-bare-arguments.print.txt",
);

export const PRINT_SERVICE_NOT_FOUND_STDERR = read(
  "error-service-not-found.stderr.txt",
);

export const PRINT_BAD_DOMAIN_STDERR = read("error-bad-domain.stderr.txt");
