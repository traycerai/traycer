import type { HostLifecycleSnapshot } from "../host/lifecycle-snapshot";

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
  // The detached finalize helper already swapped the staged binary onto the
  // live path, but the install manifest still records the upgrade as pending.
  //
  // This state used to be unobservable, because doctor RECONCILED the
  // helper's marker before reading the manifest - deleting the marker and
  // rewriting the manifest as a side effect of a diagnostic (CLI-007). Doctor
  // now only reads, so the drift between "disk is upgraded" and "manifest
  // says pending" has to be reportable rather than silently repaired.
  //
  // Info, deliberately: the CLI the user invokes IS the new one, nothing is
  // failing, and promoting it would flip `host doctor`'s exit code for a
  // machine whose only fault is a stale record that the next `host restart`
  // clears.
  CLI_UPGRADE_FINALIZED_UNRECONCILED: "CLI_UPGRADE_FINALIZED_UNRECONCILED",
  // The finalize helper ran and the swap itself failed - distinct from
  // CLI_UPGRADE_PENDING, whose message ("the live binary is locked, restart
  // to finalise") is actively wrong here: a helper already ran with the lock
  // released. The operator needs the helper's own error, which this carries.
  CLI_UPGRADE_FINALIZE_FAILED: "CLI_UPGRADE_FINALIZE_FAILED",
  // The finalize helper's marker exists but could not be parsed. Reported
  // independently of whether a pending upgrade is recorded: an unreadable
  // marker is a fault whether or not the manifest happens to reference an
  // upgrade right now, and staying silent about it would let doctor call the
  // CLI-upgrade state clean while an unparseable file sits on disk.
  CLI_UPGRADE_MARKER_UNREADABLE: "CLI_UPGRADE_MARKER_UNREADABLE",
  // The marker's BYTES were read and are not a marker (bad JSON, wrong shape).
  // Its own code rather than sharing UNREADABLE above, because the two have
  // opposite remediations - reconciliation unlinks an unparseable marker, so
  // `host restart` clears it, while a marker it cannot read is left in place -
  // and a consumer that groups by `code` would otherwise have to parse message
  // prose to tell which advice applies.
  CLI_UPGRADE_MARKER_UNPARSEABLE: "CLI_UPGRADE_MARKER_UNPARSEABLE",
  // The finalize helper swapped the CLI successfully and then could not start
  // the host service. Its own error is the only artifact that explains a host
  // that is down for this particular reason, and it is recorded in the marker
  // AFTER `pendingUpgrade` has already been cleared by the successful swap -
  // so it is only visible to a reader who looks at markers independently of
  // pending state. Not an upgrade to retry: the upgrade worked.
  CLI_UPGRADE_SERVICE_START_FAILED: "CLI_UPGRADE_SERVICE_START_FAILED",
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
  // The lock `traycer host update` takes beside its progress marker for each
  // conditional write (`<host home>/update-progress.json.lock`) is held past
  // the milliseconds such a write takes, by a holder that is still running
  // or one whose identity cannot be verified and so is never broken. Every
  // later update then answers `failed` on its marker step after a bounded
  // wait, with nothing on disk that says why but the lock file itself.
  //
  // Warning, not error: the host is not known to be broken, and a stale
  // lock left by a holder that has EXITED is not reported at all - the next
  // acquisition breaks it on positive evidence, so it is not a fault.
  HOST_UPDATE_MARKER_LOCK_HELD: "HOST_UPDATE_MARKER_LOCK_HELD",
  // The marker lock IS stale - its holder has exited or its pid was recycled,
  // or it is an empty file past the grace window - but the next acquisition
  // cannot break it: the break-arbitration file beside it (`<lock>.break`)
  // is held by a breaker that is alive or cannot be verified, or is dated in
  // the future. Every marker operation then exhausts its bounded wait for as
  // long as that file stays. Distinct from HELD because the remedy is the
  // OTHER file.
  HOST_UPDATE_MARKER_LOCK_UNBREAKABLE: "HOST_UPDATE_MARKER_LOCK_UNBREAKABLE",
  // The marker lock file exists and cannot be read (a permission or I/O
  // error, not a missing file). Its own code because the two states have
  // different remedies: a held lock has a holder to stop; an unreadable one
  // has a file to inspect.
  HOST_UPDATE_MARKER_LOCK_UNREADABLE: "HOST_UPDATE_MARKER_LOCK_UNREADABLE",
  // The update-attempt lock (`<host home>/update-attempt.lock`) was left by a
  // publisher that has provably exited, but its record also names the
  // installer tree that publisher supervised, and the lock's own liveness
  // rule cannot verify that tree on this platform (Windows gives Node no
  // process-group or Job-object membership proof). So it answers
  // `indeterminate` forever and no acquisition breaks it: every
  // `host maintenance-lease` - every scripted desktop install and uninstall -
  // is refused as "another host update contender is in progress" until the
  // file is removed. Fail-closed by design, because a reparented installer may
  // still be mutating the install; this is the repair that design relies on.
  //
  // Warning, not error: the running host is not affected. Not reported for a
  // publisher that is alive or unverifiable, nor for a record the rule WILL
  // break once its publisher is gone - that lock heals on the next acquisition.
  HOST_UPDATE_ATTEMPT_LOCK_UNBREAKABLE: "HOST_UPDATE_ATTEMPT_LOCK_UNBREAKABLE",
  // `lifecycle-policy.json` exists but is corrupt or cannot be read. It reads
  // as Background - the upgrade-safe default, so nothing parks - which is
  // exactly why it needs saying: a user who chose Linked or Ask gets
  // Background behaviour with nothing else anywhere to tell them.
  HOST_LIFECYCLE_POLICY_UNREADABLE: "HOST_LIFECYCLE_POLICY_UNREADABLE",
  // A non-Background mode is set while the host runs under a supervisor that
  // does not enforce it (one that predates the policy and kept running
  // through a CLI upgrade, or a record left by a supervisor that is gone).
  // The mode takes effect at the next host restart.
  HOST_LIFECYCLE_POLICY_NOT_ENFORCED: "HOST_LIFECYCLE_POLICY_NOT_ENFORCED",
  // A non-Background mode is set, but the registered service definition is
  // not in this CLI's current launcher form. The modes park only LABELLED
  // service starts, and a definition older than labelled starts launches the
  // host unlabelled at login, which no mode can park. Choosing a mode
  // refreshes the definition, so this is what is left when that refresh
  // failed, when the mode was already set before it existed, or when an older
  // CLI re-registered the service since. `host service refresh` repairs it
  // without starting or stopping anything.
  HOST_SERVICE_DEFINITION_STALE: "HOST_SERVICE_DEFINITION_STALE",
  // A non-Background mode is set, and the registration under this service's
  // own name is not one a Traycer emitter wrote (or cannot be read), so the
  // refresh leaves it alone. A full re-registration replaces it.
  HOST_SERVICE_DEFINITION_UNRECOGNIZED: "HOST_SERVICE_DEFINITION_UNRECOGNIZED",
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
  /**
   * The host lifecycle policy, desktop presence, run origin/owner and the
   * running supervisor's capability (D7). Facts, not issues: printed in the
   * report whatever they are, and additive to the payload, whose existing
   * readers take `issues` only.
   */
  readonly lifecycle: HostLifecycleSnapshot;
}
