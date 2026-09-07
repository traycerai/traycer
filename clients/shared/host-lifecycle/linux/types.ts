import type { DurableRecord, Evidence } from "../evidence";
import type { InstallRecord, PendingActivation } from "../durable/records";
import type { SentinelIndeterminateCause } from "../durable/sentinel";
import type { TraycerIdentityAttestation } from "../identity";
import type { HostPidMetadata } from "../shared/host-process";
import type { Reachability } from "../shared/reachability";

export type LinuxIndeterminateCause =
  | "systemctl-failed"
  | "systemctl-timeout"
  | "systemctl-permission"
  | "user-bus-unavailable"
  | "user-manager-unavailable"
  | "user-manager-transitional"
  | "loginctl-failed"
  | "unit-file-unreadable"
  | "parse-error"
  | "probe-error"
  // Durable-intent sentinel decode arms (macOS annex §2.1.1). Distinct per
  // arm so doctor can say *why* a sentinel could not be read (I3).
  | SentinelIndeterminateCause;

export type LinuxEvidence<T> = Evidence<T, LinuxIndeterminateCause>;

export type UnitFileState =
  | {
      readonly kind: "observed";
      readonly path: string;
      readonly identity: TraycerIdentityAttestation;
    }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly cause: string }
  | {
      readonly kind: "indeterminate";
      readonly cause: "unit-file-unreadable" | "parse-error";
    };

export type UserBusAvailability =
  | { readonly kind: "observed"; readonly available: true }
  | {
      readonly kind: "observed";
      readonly available: false;
      readonly reason: "no-xdg-runtime" | "connection-refused" | "not-found";
    }
  | {
      readonly kind: "indeterminate";
      readonly cause:
        | "systemctl-timeout"
        | "systemctl-failed"
        | "user-bus-unavailable";
    };

    /**
     * systemd user-manager state (annex §1.4).
     * That is not rare - one failed pipewire unit or user timer produces it - and it is diagnostic evidence `doctor-report` must carry (§2.1.4), so it is a field rather than a discarded distinction.
     */
export type UserManagerState =
  | {
      readonly kind: "observed";
      readonly active: true;
      readonly health: "running" | "degraded";
    }
  | {
      readonly kind: "observed";
      readonly active: false;
      readonly reason: "user-manager-unavailable";
    }
  | { readonly kind: "indeterminate"; readonly cause: LinuxIndeterminateCause };

export type UnitLoadState =
  | {
      readonly kind: "observed";
      readonly load: "loaded" | "not-found" | "error" | "masked";
      readonly fragmentPath: string | null;
    }
  | { readonly kind: "absent" }
  | { readonly kind: "indeterminate"; readonly cause: LinuxIndeterminateCause };

  /**
   * `systemctl --user is-enabled` state words for the supported systemd range (annex §1.4, "Enablement states must cover what systemd actually emits").
   * `not-found` deliberately stays indeterminate - enablement is not a property of a unit that does not exist.
   */
export type UnitEnablementState =
  | "enabled"
  | "enabled-runtime"
  | "linked"
  | "linked-runtime"
  | "alias"
  | "masked"
  | "masked-runtime"
  | "static"
  | "indirect"
  | "disabled"
  | "generated"
  | "transient"
  | "bad";

export type UnitEnablement =
  | {
      readonly kind: "observed";
      readonly enabled: UnitEnablementState;
    }
  | { readonly kind: "indeterminate"; readonly cause: LinuxIndeterminateCause };

export type UnitActivity =
  | {
      readonly kind: "observed";
      readonly active:
        | "active"
        | "inactive"
        | "failed"
        | "activating"
        | "deactivating"
        | "reloading";
      readonly sub: string | null;
      readonly mainPid: number | null;
      readonly execMainStatus: number | null;
      readonly result: string | null;
    }
  | { readonly kind: "indeterminate"; readonly cause: LinuxIndeterminateCause };

export type DaemonReloadFreshness =
  | {
      readonly kind: "observed";
      readonly unitFileMtimeMs: number;
      readonly lastReloadAt: number | null;
      readonly stale: boolean;
    }
  | { readonly kind: "indeterminate"; readonly cause: string };

export type LingerState =
  | { readonly kind: "observed"; readonly enabled: boolean }
  | { readonly kind: "absent" }
  | {
      readonly kind: "indeterminate";
      readonly cause: "loginctl-failed" | "parse-error";
    };

    /**
     * logind sessions (annex §1.6, "Every field of `observed` must be observed").
     * `observed` is a claim about the world; a field that was not read is not part of that claim.
     */
export type LogindSession = {
  readonly id: string;
  readonly active: boolean | null;
  readonly type: string | null;
  readonly remote: boolean | null;
};

export type LogindSessionState =
  | {
      readonly kind: "observed";
      readonly sessions: readonly LogindSession[];
      readonly graphicalActive: boolean | null;
    }
  | { readonly kind: "indeterminate"; readonly cause: LinuxIndeterminateCause };

  /**
   * Linux world snapshot. Intentionally does **not** include
   * `externally-managed` - that is a macOS-only concept (annex closing note).
   */
export type LinuxWorld = {
  readonly bus: UserBusAvailability;
  readonly userManager: UserManagerState;
  readonly unitFile: UnitFileState;
  readonly load: UnitLoadState;
  readonly enablement: UnitEnablement;
  readonly activity: UnitActivity;
  readonly daemonReload: DaemonReloadFreshness;
  readonly linger: LingerState;
  readonly logind: LogindSessionState;
  readonly host: {
    readonly pidMetadata: LinuxEvidence<HostPidMetadata>;
    readonly pidLiveness: LinuxEvidence<boolean>;
    readonly endpoint: Reachability;
  };
  readonly durable: {
    readonly install: DurableRecord<InstallRecord>;
    readonly removedByUser: LinuxEvidence<boolean>;
    readonly stoppedByUser: LinuxEvidence<boolean>;
    readonly pendingActivation:
      | DurableRecord<PendingActivation>
      | { readonly kind: "absent" };
  };
};
