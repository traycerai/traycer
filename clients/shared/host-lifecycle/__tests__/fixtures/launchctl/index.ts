import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **Captured `launchctl print` bytes.** Not hand-written.
 *
 * Every file here was produced by running `launchctl print gui/<uid>/<label>`
 * on a real macOS machine and redirecting the output verbatim. That is the
 * point: three of this changeset's findings were *fixture-level vacuity* —
 * sound assertions over inputs launchd cannot emit. Notably
 * `extractProgramArgumentsFromPrint` was tested against
 * `['arguments = {', '\t"a"', '\t"b"', '}']` and returned `null` for every
 * real job, because launchd emits arguments **bare, one per line**.
 *
 * Rule for adding one: capture it, do not type it. If a shape cannot be
 * produced on a real machine, it is not evidence about the parser.
 */
const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

function read(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

/**
 * The **live, healthy Traycer SMAppService agent** on the capture machine:
 * `type = Submitted`, `managed_by = com.apple.xpc.ServiceManagement`,
 * `state = running`, a live `pid`, `last exit code = (never exited)` — and
 * `properties = partial import | runatload | resolve program | has LWCR`.
 *
 * This one blob is the counter-example to two findings at once: `has LWCR` on
 * a job that is unambiguously fine, and a bare three-token `arguments` block
 * ending in `host start`.
 */
export const HEALTHY_TRAYCER_AGENT_PRINT = read(
  "agent-healthy-smappservice.print.txt",
);

/**
 * A healthy third-party SMAppService job (`last exit code = 0`,
 * `job state = exited`) that also prints `has LWCR`. Confirms the marker is a
 * property of code signing, not of this product.
 *
 * Also the source of the nested-key evidence: its `endpoints = { … }` block
 * contains `port` / `active` / `managed` / `reset` / `hide` / `watching`, all
 * of which the old `^\s*`-anchored field parser harvested as top-level.
 */
export const THIRD_PARTY_HAS_LWCR_PRINT = read(
  "third-party-submitted-has-lwcr.print.txt",
);

/**
 * A system LaunchAgent with a single bare argument whose program is
 * `/usr/libexec/enhancedloggingd` — i.e. provably not Traycer. Used to show
 * that a real, parseable argument list can *refute* identity.
 */
export const SYSTEM_AGENT_BARE_ARGUMENTS_PRINT = read(
  "system-agent-bare-arguments.print.txt",
);

/** Real exit-113 stderr for a label that is not loaded. */
export const PRINT_SERVICE_NOT_FOUND_STDERR = read(
  "error-service-not-found.stderr.txt",
);

/** Real exit-112 stderr for a domain that does not exist. */
export const PRINT_BAD_DOMAIN_STDERR = read("error-bad-domain.stderr.txt");
