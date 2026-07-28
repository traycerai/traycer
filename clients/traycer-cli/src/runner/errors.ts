// Machine-readable error codes the runner emits in NDJSON `error` events
// and on the human stderr line. The codebase should always raise CliError
// with one of these so downstream consumers (Desktop, CI, scripts) can
// switch on `code` rather than parsing free-form messages.
//
// Keep this list authoritative: add new codes here as new failure modes
// surface in CLI commands. Don't reuse codes for unrelated meanings.
export const CLI_ERROR_CODES = {
  // --- Generic ---
  UNEXPECTED: "E_UNEXPECTED",
  INVALID_ARGUMENT: "E_INVALID_ARGUMENT",
  NOT_FOUND: "E_NOT_FOUND",
  // Authenticated but not authorized - the caller is signed in but lacks
  // access to the requested resource (e.g. the host's 403 "does not have
  // required permission for task"). Distinct from NOT_FOUND ("doesn't
  // exist") and AUTH_REJECTED ("not signed in / bad token").
  FORBIDDEN: "E_FORBIDDEN",

  // --- Agent roles (mirror the host's typed role-surface wire codes 1:1) ---
  // Absent and foreign-account agents share ONE code and template - no
  // existence oracle across the account boundary.
  AGENT_NOT_FOUND: "E_AGENT_NOT_FOUND",
  // The caller's own agent lives on another host; the message names it.
  AGENT_NOT_LOCAL: "E_AGENT_NOT_LOCAL",
  // A claim held by another of the caller's own agents - role-specific copy,
  // NOT the generic epic-access denial (whose "check Task access" guidance
  // would mislead here).
  ROLE_FORBIDDEN: "E_ROLE_FORBIDDEN",

  // --- Auth ---
  AUTH_NO_CREDENTIALS: "E_AUTH_NO_CREDENTIALS",
  AUTH_REJECTED: "E_AUTH_REJECTED",
  AUTH_NETWORK: "E_AUTH_NETWORK",

  // --- Config ---
  CONFIG_INVALID: "E_CONFIG_INVALID",
  CONFIG_INVALID_VALUE: "E_CONFIG_INVALID_VALUE",
  CONFIG_MISSING_KEY: "E_CONFIG_MISSING_KEY",

  // --- Host supervisor + lifecycle ---
  HOST_NOT_RUNNING: "E_HOST_NOT_RUNNING",
  // A running host reported (or, fail-safe, was assumed to have) work in
  // progress, so the CLI refused to reinstall/restart it. The desktop maps
  // this to its "host busy" flow (surface the host, run the renderer's
  // compat probe) rather than treating it as a hard failure. Cleared with
  // `--force`.
  HOST_BUSY: "E_HOST_BUSY",
  // The host is reachable but its RPC protocol is incompatible with this
  // CLI (version skew): the host answered with INCOMPATIBLE /
  // DOWNGRADE_UNSUPPORTED, or returned a response shape this CLI could not
  // parse. Distinct from HOST_NOT_RUNNING - the host *answered*.
  // Actionable via `traycer host restart` or updating the CLI.
  HOST_INCOMPATIBLE: "E_HOST_INCOMPATIBLE",
  // The host is reachable and compatible on the floor protocol, but it does
  // not support the specific feature/method this CLI tried to use.
  HOST_UNSUPPORTED: "E_HOST_UNSUPPORTED",
  HOST_BUNDLE_MISSING: "E_HOST_BUNDLE_MISSING",
  HOST_SHELL_MISSING: "E_HOST_SHELL_MISSING",
  HOST_SPAWN_FAILED: "E_HOST_SPAWN_FAILED",

  // --- Host install + registry (NP-2 / NP-4) ---
  HOST_NOT_INSTALLED: "E_HOST_NOT_INSTALLED",
  HOST_INSTALL_RECORD_INVALID: "E_HOST_INSTALL_RECORD_INVALID",
  HOST_INSTALL_FAILED: "E_HOST_INSTALL_FAILED",
  HOST_VERIFY_FAILED: "E_HOST_VERIFY_FAILED",
  HOST_SOURCE_MISSING: "E_HOST_SOURCE_MISSING",
  HOST_ALREADY_RUNNING: "E_HOST_ALREADY_RUNNING",
  HOST_UPDATE_NOT_NEWER: "E_HOST_UPDATE_NOT_NEWER",
  REGISTRY_UNAVAILABLE: "E_REGISTRY_UNAVAILABLE",
  REGISTRY_VERSION_NOT_FOUND: "E_REGISTRY_VERSION_NOT_FOUND",
  REGISTRY_NOT_IMPLEMENTED: "E_REGISTRY_NOT_IMPLEMENTED",

  // --- OS service registration (NP-2) ---
  SERVICE_UNSUPPORTED_PLATFORM: "E_SERVICE_UNSUPPORTED_PLATFORM",
  SERVICE_INSTALL_FAILED: "E_SERVICE_INSTALL_FAILED",
  SERVICE_UNINSTALL_FAILED: "E_SERVICE_UNINSTALL_FAILED",
  SERVICE_CONTROL_FAILED: "E_SERVICE_CONTROL_FAILED",
  SERVICE_CLI_PATH_UNRESOLVED: "E_SERVICE_CLI_PATH_UNRESOLVED",

  // --- CLI install lifecycle (foundation only in NP-1) ---
  CLI_LOCK_BUSY: "E_CLI_LOCK_BUSY",
  CLI_MANIFEST_INVALID: "E_CLI_MANIFEST_INVALID",

  // --- CLI self-upgrade (NP-7) ---
  CLI_UPGRADE_PACKAGE_MANAGER_OWNED: "E_CLI_UPGRADE_PACKAGE_MANAGER_OWNED",
  CLI_UPGRADE_NO_MANIFEST: "E_CLI_UPGRADE_NO_MANIFEST",
  CLI_UPGRADE_DOWNLOAD_FAILED: "E_CLI_UPGRADE_DOWNLOAD_FAILED",
  CLI_UPGRADE_REPLACE_FAILED: "E_CLI_UPGRADE_REPLACE_FAILED",
  CLI_UPGRADE_FINALIZE_HELPER_FAILED: "E_CLI_UPGRADE_FINALIZE_HELPER_FAILED",
} as const;

export type CliErrorCode =
  (typeof CLI_ERROR_CODES)[keyof typeof CLI_ERROR_CODES];

export interface CliErrorInit {
  readonly code: CliErrorCode;
  readonly message: string;
  readonly details: Record<string, unknown> | null;
  readonly exitCode: number;
}

// A CLI-layer error carrying a stable machine-readable code, a human
// message, optional structured details (surfaced as `details` on the
// NDJSON error event), and the process exit code to use.
export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly details: Record<string, unknown> | null;
  readonly exitCode: number;

  constructor(init: CliErrorInit) {
    super(init.message);
    this.name = "CliError";
    this.code = init.code;
    this.details = init.details;
    this.exitCode = init.exitCode;
  }
}

export function cliError(init: CliErrorInit): CliError {
  return new CliError(init);
}

// Narrow an unknown thrown value to a NodeJS.ErrnoException. Centralised
// here so the dozen platform/store/installer files that need to branch on
// `err.code` don't each define their own copy.
export function isErrnoException(
  value: unknown,
): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

// Coerce an unknown thrown value into a CliError so the runner has a
// uniform shape to emit. Preserves a CliError as-is; wraps Errors with
// their message and a generic UNEXPECTED code; falls back to String().
export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof Error) {
    return new CliError({
      code: CLI_ERROR_CODES.UNEXPECTED,
      message: err.message,
      details: { name: err.name, stack: err.stack ?? null },
      exitCode: 1,
    });
  }
  return new CliError({
    code: CLI_ERROR_CODES.UNEXPECTED,
    message: String(err),
    details: null,
    exitCode: 1,
  });
}
