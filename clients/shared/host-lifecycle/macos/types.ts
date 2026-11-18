import type { DurableRecord, Evidence } from "../evidence";
import type {
  InstallRecord,
  PendingActivation,
  SubstrateRecord,
  TransitionJournal,
} from "../durable/records";
import type { SentinelIndeterminateCause } from "../durable/sentinel";
import type { TraycerIdentityAttestation } from "../identity";
import type { AttemptReadiness, HostPidMetadata } from "../shared/host-process";
import type { CliSlotValidity } from "../shared/cli-slot";
import type { Reachability } from "../shared/reachability";

/** macOS annex IndeterminateCause — keep platform-local, do not flatten. */
export type IndeterminateCause =
  | "command-failed"
  | "timeout"
  | "permission"
  | "spawn-failed"
  | "unrecognized-format"
  | "api-error"
  | "probe-error"
  // Durable-intent sentinel decode arms (annex §2.1.1). Distinct per arm so
  // doctor can say *why* a sentinel could not be read (I3).
  | SentinelIndeterminateCause;

export type MacosEvidence<T> = Evidence<T, IndeterminateCause>;

export type SmAppServiceSignals = {
  readonly managedByServiceManagement: boolean;
  readonly typeSubmitted: boolean;
  readonly inBundleLaunchAgentPath: boolean;
};

export type LabelOwnership =
  | {
      readonly kind: "smappservice";
      readonly path: string;
      readonly signals: SmAppServiceSignals;
    }
  | {
      readonly kind: "cli-or-other";
      readonly path: string | null;
      readonly identity: TraycerIdentityAttestation;
    }
  | {
      readonly kind: "indeterminate";
      readonly cause: "unrecognized-format";
      readonly path: string | null;
    };

export type LwcrEvidence =
  | { readonly kind: "observed"; readonly markers: readonly string[] }
  | { readonly kind: "absent" }
  | { readonly kind: "indeterminate"; readonly cause: "unrecognized-format" };

export type LaunchdRunState = {
  readonly jobState: MacosEvidence<string>;
  readonly lastExitCode: MacosEvidence<number>;
  readonly lastExitReason: MacosEvidence<string>;
  readonly pid: MacosEvidence<number>;
  readonly runs: MacosEvidence<number>;
  readonly lwcr: LwcrEvidence;
};

export type LaunchctlPrintProbe =
  | {
      readonly kind: "observed";
      readonly raw: string;
      readonly fields: ReadonlyMap<string, string>;
      readonly ownership: LabelOwnership;
      readonly runState: LaunchdRunState;
    }
  | { readonly kind: "absent" }
  | {
      readonly kind: "indeterminate";
      readonly cause:
        | "command-failed"
        | "timeout"
        | "permission"
        | "spawn-failed";
    };

export type ManifestProbe =
  | {
      readonly kind: "present";
      readonly path: string;
      readonly identity: TraycerIdentityAttestation;
    }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly cause: string };

export type MacosLabelRole = "cli-raw" | "agent" | "fallback";

export type MacosLabelView = {
  readonly target: string;
  readonly labelId: string;
  readonly role: MacosLabelRole;
  readonly print: LaunchctlPrintProbe;
  readonly manifest: ManifestProbe;
};

export type HostLoginItemStatus =
  | "enabled"
  | "requires-approval"
  | "not-registered"
  | "not-found"
  | "not-supported";

export type LoginItemStatus =
  | { readonly kind: "observed"; readonly status: HostLoginItemStatus }
  | { readonly kind: "unavailable"; readonly reason: "no-capability" }
  | { readonly kind: "indeterminate"; readonly cause: "api-error" };

export type WedgeReason =
  | "job-state-spawn-failed"
  | "last-exit-ex-config-78"
  | "lwcr-mismatch-markers"
  | "loaded-but-no-live-pid-and-no-attempt-progress";

export type WedgeVerdict =
  | { readonly kind: "wedged"; readonly reasons: readonly WedgeReason[] }
  | { readonly kind: "healthy-or-unknown"; readonly note: string }
  | { readonly kind: "indeterminate"; readonly cause: string };

export type HostProcessEvidenceMacos = {
  readonly pidMetadata: MacosEvidence<HostPidMetadata>;
  readonly pidLiveness: MacosEvidence<boolean>;
  readonly endpoint: Reachability;
  readonly attemptScoped: AttemptReadiness;
};

export type MacosCapabilities = {
  readonly smAppService: boolean;
  readonly desktopApp: boolean;
  readonly cliSlotHeal: boolean;
};

export type MacosWorld = {
  readonly labels: {
    readonly agent: MacosLabelView;
    readonly cliRaw: MacosLabelView;
    readonly fallback: MacosLabelView;
  };
  readonly loginItem: LoginItemStatus;
  readonly host: HostProcessEvidenceMacos;
  readonly cliSlot: CliSlotValidity;
  readonly durable: {
    readonly substrate: DurableRecord<SubstrateRecord>;
    readonly transition: DurableRecord<TransitionJournal>;
    readonly install: DurableRecord<InstallRecord>;
    readonly removedByUser: MacosEvidence<boolean>;
    readonly stoppedByUser: MacosEvidence<boolean>;
    readonly pendingActivation:
      | DurableRecord<PendingActivation>
      | { readonly kind: "absent" };
  };
  readonly capabilities: MacosCapabilities;
};

export const SMAPPSERVICE_PATH_UNKNOWN =
  "(SMAppService-managed; no plist path)" as const;

export const SERVICE_MANAGEMENT_MANAGED_BY =
  "com.apple.xpc.ServiceManagement" as const;

export const SERVICE_MANAGEMENT_JOB_TYPE = "Submitted" as const;
