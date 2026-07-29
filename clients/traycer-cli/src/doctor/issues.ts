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
  // macOS: launchd reports the label as loaded while the job itself cannot
  // run (spawn failed / EX_CONFIG last exit / LWCR mismatch). Every
  // registration-keyed check reads "healthy" in this state - the v1.1.8
  // field lockout - so doctor must read the job's run state, not just who
  // registered it.
  SERVICE_JOB_WEDGED: "SERVICE_JOB_WEDGED",
  SERVICE_STOPPED: "SERVICE_STOPPED",
  PID_METADATA_MISSING: "PID_METADATA_MISSING",
  PID_METADATA_STALE: "PID_METADATA_STALE",
  // The running host published a Layer 0 verdict that is not "I hold the
  // single-writer lock". It is serving normally - degrading to today's
  // no-lock availability is deliberate, because refusing to start would turn
  // a rare corruption into a routine outage - but the fact has to be
  // *findable*, since "did this host start without the guarantee?" is the
  // first question a two-hosts-one-data-dir investigation asks. Warning, not
  // error: nothing is broken yet, and promoting it would flip the exit code
  // of `traycer host doctor` for every user whose home is on a network
  // filesystem.
  HOST_LAYER0_NOT_GUARANTEED: "HOST_LAYER0_NOT_GUARANTEED",
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
  // The stable CLI path (`~/.traycer/cli/bin/traycer`) is a symlink the
  // Desktop app points into its own bundle; removing or replacing the app
  // leaves it dangling. `ls` (lstat) still shows the file while executing
  // it fails with ENOENT, and the only existing repair runs at the app's
  // next *successful* launch - a state users cannot self-diagnose.
  CLI_SLOT_BINARY_DANGLING: "CLI_SLOT_BINARY_DANGLING",
  // Windows-only: ~/.traycer/cli/credentials inherits permissive
  // default Windows ACLs (POSIX mode 0o600 is ignored on Windows).
  // Doctor surfaces this so VDI/shared-machine users can lock the
  // file down manually until we add per-user ACL hardening.
  WINDOWS_CREDENTIALS_ACL_PERMISSIVE: "WINDOWS_CREDENTIALS_ACL_PERMISSIVE",
  // Linux-only: `systemctl --user` cannot reach a user service manager
  // (WSL without systemd, `sudo su`, SSH with no logind session). Every
  // lifecycle operation fails in this state, and install errors steer
  // users to doctor - which previously had no Linux probes at all.
  SYSTEMD_USER_UNREACHABLE: "SYSTEMD_USER_UNREACHABLE",
  // Linux-only: the unit is `failed` or cycling `auto-restart`.
  // `service status` deliberately keys liveness off pid metadata, so this
  // state reads there as plain "stopped"; doctor is where it surfaces.
  SERVICE_UNIT_FAILED: "SERVICE_UNIT_FAILED",
  // Linux-only: systemd skipped the last start because
  // ConditionFileIsExecutable found the CLI binary the unit points at
  // missing - a stranded service definition.
  SERVICE_START_CONDITION_UNMET: "SERVICE_START_CONDITION_UNMET",
  // Linux-only: lingering disabled - the host is torn down at last
  // logout. Enable-linger is best-effort at install (polkit may refuse
  // non-interactively); this is the promised follow-up surface.
  LINGER_DISABLED: "LINGER_DISABLED",
  // Windows-only: the host's Scheduled Task launches through Windows
  // Script Host (wscript.exe), and enterprise hardening commonly disables
  // WSH via the registry Enabled=0 policy. Probed live: with the policy
  // set, the launcher never executes and NOTHING surfaces (`//B` batch
  // mode suppresses the block dialog) - the host silently never starts at
  // login. A policy applied after install is invisible to install-time
  // verification, so doctor is the surface that has to say it.
  WINDOWS_SCRIPT_HOST_DISABLED: "WINDOWS_SCRIPT_HOST_DISABLED",
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
