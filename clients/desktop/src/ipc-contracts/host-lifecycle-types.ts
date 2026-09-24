import type {
  HostLifecycleMode,
  HostLifecyclePolicyWriter,
} from "@traycer/protocol/config/host-lifecycle-policy";

export type {
  HostLifecycleMode,
  HostLifecyclePolicyWriter,
} from "@traycer/protocol/config/host-lifecycle-policy";

/**
 * Whether this desktop instance runs the local-host lanes at all. Computed
 * ONCE at boot from the lifecycle policy (`none` → `"none"`, every other mode
 * → `"managed"`) and fixed for the life of the process: turning the lanes on
 * or off is restart-to-apply. Reaches the renderer synchronously through the
 * preload (`runnerHost.localHostCapability`), before any host code runs.
 */
export type LocalHostCapability = "managed" | "none";

/**
 * What the RUNNING supervisor does with the policy.
 *
 * - `enforcing` - `supervisor.json` advertises `lifecycle-policy-v1`.
 * - `not-enforcing` - a host is running (its `pid.json` parses) but no
 *   capable supervisor record exists: an older supervisor, which keeps running
 *   through a CLI upgrade until the next host restart and enforces nothing.
 * - `not-running` - neither record: there is no host to apply anything to, and
 *   the next start runs the current CLI.
 */
export type HostLifecycleSupervisorState =
  | "enforcing"
  | "not-enforcing"
  | "not-running";

/**
 * What still stands between the desired mode and the running one.
 *
 * - `restart-app` - the desired mode and this instance's lanes disagree about
 *   whether a local host exists: `none` was chosen while the lanes run, or the
 *   lanes are off (booted in `none`, or `none` was committed this session) and
 *   another mode was chosen. "Restart Traycer to apply".
 * - `restart-host` - a mode the supervisor enforces was chosen while an older
 *   supervisor is running. "Restart the host to apply".
 * - `none` - nothing is pending.
 */
export type HostLifecyclePending = "none" | "restart-app" | "restart-host";

/**
 * The renderer's view of the lifecycle policy: DESIRED (the file, which the
 * CLI co-writes) and APPLIED (what this desktop instance runs under). Every
 * view is built from a fresh read of the files; nothing here is a cached
 * hydration.
 */
export interface HostLifecycleView {
  readonly desired: {
    readonly mode: HostLifecycleMode;
    /** `0` when no valid policy file exists (Background by absence). */
    readonly rev: number;
    readonly updatedBy: HostLifecyclePolicyWriter | null;
    readonly updatedAt: string | null;
  };
  readonly applied: {
    readonly localHostCapability: LocalHostCapability;
    readonly supervisor: HostLifecycleSupervisorState;
  };
  readonly pending: HostLifecyclePending;
}

/** The stop a `→ none` transition runs, as the user confirmed it. */
export type HostLifecycleStopChoice = "if-idle" | "force";

export interface HostLifecycleSetRequest {
  readonly mode: HostLifecycleMode;
  /**
   * The confirmed stop for `→ none` while this instance runs the local-host
   * lanes: `"if-idle"` for an idle host, `"force"` after the user pressed Stop
   * on a busy list. `null` for every other transition, where it is ignored; a
   * `→ none` that needs a stop and carries `null` is refused with
   * `confirmation-required` and changes nothing.
   */
  readonly stop: HostLifecycleStopChoice | null;
}

export type HostLifecycleStopRefusal =
  | "host-busy"
  | "lock-busy"
  | "update-active";

export type HostLifecycleSetFailure =
  | "confirmation-required"
  | "stop-failed"
  | "write-failed";

/**
 * The answer to `hostLifecycle.set`. Every arm carries a fresh view, so the
 * renderer never has to guess what the file says after a refusal.
 *
 * - `applied` - the policy now says `mode` (or already did).
 * - `stop-refused` - `→ none`'s stop was refused; the policy is unchanged.
 *   `host-busy` is the if-idle probe finding work (offer Stop, then retry with
 *   `force`); `lock-busy` and `update-active` are another lifecycle actor.
 * - `failed` - nothing was committed; `message` says why.
 * - `superseded` - the policy changed underneath a `→ none` stop (the CLI
 *   wrote it), so this request committed nothing and the newer choice stands.
 */
export type HostLifecycleSetResult =
  | { readonly kind: "applied"; readonly view: HostLifecycleView }
  | {
      readonly kind: "stop-refused";
      readonly reason: HostLifecycleStopRefusal;
      readonly message: string;
      readonly view: HostLifecycleView;
    }
  | {
      readonly kind: "failed";
      readonly reason: HostLifecycleSetFailure;
      readonly message: string;
      readonly view: HostLifecycleView;
    }
  | { readonly kind: "superseded"; readonly view: HostLifecycleView };
