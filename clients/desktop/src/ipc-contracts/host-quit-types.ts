// The quit round-trip between desktop main's quit transaction and the
// renderer's host quit modal (host-lifecycle-modes T06 / T07), exposed on
// `window.runnerHost.hostLifecycle`. The shapes are the renderer's contract,
// so their one definition lives in `@traycer-clients/shared/platform/runner-host`
// beside `IRunnerHost`; main and preload import them through this module.
//
// Main owns the transaction and the stop; the renderer owns the modal, the
// `host.status` query against the LOCAL host entry and the list it shows. The
// modal answers one `HostQuitDecisionRequest` with exactly one
// `HostQuitDecisionResponse`; main ignores an answer whose `requestId` is
// unknown or stale. Progress after the answer arrives as `HostQuitStateEvent`s.
export type {
  HostQuitDecision,
  HostQuitDecisionMode,
  HostQuitDecisionRequest,
  HostQuitDecisionResponse,
  HostQuitPhase,
  HostQuitStateEvent,
} from "@traycer-clients/shared/platform/runner-host";
