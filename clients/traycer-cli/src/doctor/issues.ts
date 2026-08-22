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
  // The host held its own delegated credential, the cloud refused it in a way
  // refreshing cannot repair, and it burned it - leaving a sticky marker and
  // falling back to whatever bearer a connected client carries.
  //
  // Every symptom of this state points AWAY from it. Epic opens, notifications
  // and artifact rooms fail with sign-in-flavoured errors that reloading and
  // re-logging-in cannot change (the host, not the renderer, chooses what to
  // spend), the service is running, the port answers, and every other probe
  // here reads healthy. That is exactly the gap doctor exists to close: the
  // marker is the one durable trace, and it is on disk the whole time.
  //
  // Error rather than warning: work the user asked for is failing right now.
  // It clears itself the moment the app re-provisions the host, so it can only
  // be reported while genuinely true.
  HOST_CREDENTIAL_NEEDS_REAUTH: "HOST_CREDENTIAL_NEEDS_REAUTH",
  // The credential probe could not reach a verdict, because the directory the
  // marker lives in cannot be inspected at all.
  //
  // A THIRD answer, and it exists because the other two are both assertions.
  // `HOST_CREDENTIAL_NEEDS_REAUTH` says "your credential was burned" and
  // silence says "it was not"; an unsearchable auth directory supports
  // neither, and the probe used to resolve it as the first - a confident,
  // wrong error naming a repair (open the app, let it re-provision) that does
  // nothing about the real fault, which is a permission on a directory. The
  // rule it broke is narrower than it looks: "only ENOENT is clean" was right
  // about the MARKER, and wrong to assume the marker's parent is always
  // probeable.
  //
  // Warning rather than error: nothing is known to be broken. Nothing is known
  // to be WORKING either, which is why it is not silence.
  HOST_AUTH_DIR_INACCESSIBLE: "HOST_AUTH_DIR_INACCESSIBLE",
  // A SECOND needs-reauth marker, on the host's IDENTITY plane
  // (`<identity home>/identity/needs-reauth.json`), and deliberately its own
  // code rather than a variant of the one above.
  //
  // The auth-plane marker says the host's own delegated credential was burned
  // and a connected owner client has to mint a replacement. This one says the
  // host's COORDINATION identity paused after a refresh was rejected, and it
  // recovers the moment somebody signs in again on this machine - a fresh user
  // bearer in the shared CLI credentials file is the exit condition the host
  // is watching for. Same filename, different directory, different plane,
  // opposite repair: reporting them as one verdict would send half the readers
  // to the wrong fix, which is the misdiagnosis this pair exists to prevent.
  HOST_IDENTITY_NEEDS_REAUTH: "HOST_IDENTITY_NEEDS_REAUTH",
  // The identity plane's indeterminate answer - the counterpart of
  // HOST_AUTH_DIR_INACCESSIBLE, for the same reason and about the other
  // directory.
  HOST_IDENTITY_DIR_INACCESSIBLE: "HOST_IDENTITY_DIR_INACCESSIBLE",
  // The scope statement, and the reason silence is not available to this probe
  // on a dev machine that runs an identity pool.
  //
  // A host resolves its identity home as `devIdentityHomeOverride ?? <host
  // home>`, and that override is installed inside the host process by the pool
  // walk. Nothing on disk records which identity a running host acquired. So
  // on an eligible pool machine, "no marker in the default identity home" is
  // not evidence of a healthy identity plane - it is evidence that this probe
  // was looking somewhere else, which is precisely the environment the
  // original incident was filed from. Saying nothing there would report a
  // stranded host as clean.
  //
  // Scoped to hosts that could actually have taken a pool identity: a `dev`
  // environment (the host's own walk is `not-applicable` otherwise) AND a
  // non-empty pool root. A production doctor is definitive about the default
  // identity home even on a developer's machine that carries a pool, and
  // captioning it there would be the same false noise in the other direction.
  //
  // Info rather than warning: nothing is claimed to be wrong, and the host
  // itself answers this definitively (`host.doctor` substitutes its own
  // verdict for every code in this group, silence included). It is a caption
  // on the report's coverage, not a fault.
  HOST_IDENTITY_HOME_UNVERIFIED: "HOST_IDENTITY_HOME_UNVERIFIED",
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
