// Doctor issue codes - stable strings the Desktop failure card maps to
// concrete CLI subcommand fixes per Tech Plan §Doctor Engine. Keep this
// list authoritative; add new codes here rather than ad-hoc strings.
export const DOCTOR_ISSUE_CODES = {
  HOST_NOT_INSTALLED: "HOST_NOT_INSTALLED",
  HOST_INSTALL_RECORD_INVALID: "HOST_INSTALL_RECORD_INVALID",
  HOST_BINARY_MISSING: "HOST_BINARY_MISSING",
  HOST_BINARY_UNVERIFIED: "HOST_BINARY_UNVERIFIED",
  SERVICE_NOT_REGISTERED: "SERVICE_NOT_REGISTERED",
  // macOS: the label is registered by Traycer Desktop via SMAppService, not
  // by the CLI. A healthy configuration surfaced as info-only - the CLI has
  // no fix to offer (its own `service install` refuses SMAppService-owned
  // labels by design; the Desktop app is the management surface).
  SERVICE_EXTERNALLY_MANAGED: "SERVICE_EXTERNALLY_MANAGED",
  SERVICE_STOPPED: "SERVICE_STOPPED",
  PID_METADATA_MISSING: "PID_METADATA_MISSING",
  PID_METADATA_STALE: "PID_METADATA_STALE",
  PORT_UNREACHABLE: "PORT_UNREACHABLE",
  PORT_CONFLICT: "PORT_CONFLICT",
  // The host's TCP port is open but a real (authenticated) RPC
  // connection - the WebSocket upgrade + bearer + protocol handshake the
  // app actually uses - fails. A bare TCP probe is blind to these, which
  // is how doctor could report healthy while the Desktop kept failing to
  // connect.
  HOST_RPC_UNAUTHORIZED: "HOST_RPC_UNAUTHORIZED",
  HOST_RPC_INCOMPATIBLE: "HOST_RPC_INCOMPATIBLE",
  HOST_RPC_UNVERIFIED: "HOST_RPC_UNVERIFIED",
  HOST_CRASHED_AT_STARTUP: "HOST_CRASHED_AT_STARTUP",
  RECENT_CRASH_MARKERS: "RECENT_CRASH_MARKERS",
  REGISTRY_NOT_IMPLEMENTED: "REGISTRY_NOT_IMPLEMENTED",
  CLI_UPGRADE_PENDING: "CLI_UPGRADE_PENDING",
  // Windows-only: ~/.traycer/cli/credentials inherits permissive
  // default Windows ACLs (POSIX mode 0o600 is ignored on Windows).
  // Doctor surfaces this so VDI/shared-machine users can lock the
  // file down manually until we add per-user ACL hardening.
  WINDOWS_CREDENTIALS_ACL_PERMISSIVE: "WINDOWS_CREDENTIALS_ACL_PERMISSIVE",
} as const;

export type DoctorIssueCode =
  (typeof DOCTOR_ISSUE_CODES)[keyof typeof DOCTOR_ISSUE_CODES];

export type DoctorSeverity = "info" | "warning" | "error" | "fatal";

export interface DoctorIssue {
  readonly code: DoctorIssueCode;
  readonly severity: DoctorSeverity;
  readonly title: string;
  readonly message: string;
  // Machine identifier for the suggested remediation. Desktop maps
  // this to a CLI subcommand button on the failure card; null means
  // "no automatic fix - surface details only".
  readonly fixAction: string | null;
  // Equivalent shell command a user can copy-paste. Tracks fixAction
  // 1:1 so the failure card's `Open in Terminal` chip can offer the
  // exact invocation Desktop is about to run.
  readonly terminalCommand: string | null;
  readonly details: Record<string, unknown> | null;
}

export interface DoctorResult {
  readonly issues: readonly DoctorIssue[];
}
