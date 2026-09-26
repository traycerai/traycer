// The lifecycle IPC shapes are the renderer's contract, so their one
// definition lives in `@traycer-clients/shared/platform/runner-host` beside
// `IRunnerHost` (the pattern `auth-types.ts` and `traycer-cli-types.ts`
// follow). Desktop main and preload import them through this module.
export type {
  HostLifecycleMode,
  HostLifecyclePolicyWriter,
} from "@traycer/protocol/config/host-lifecycle-policy";

export type {
  HostLifecyclePending,
  HostLifecycleSetFailure,
  HostLifecycleSetRequest,
  HostLifecycleSetResult,
  HostLifecycleStopChoice,
  HostLifecycleStopRefusal,
  HostLifecycleSupervisorState,
  HostLifecycleView,
  LocalHostCapability,
} from "@traycer-clients/shared/platform/runner-host";
