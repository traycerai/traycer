import type {
  SelectionAuthorityClient,
  SelectionSubscription,
} from "../host-selection/selection-authority-contract";

const NO_SUBSCRIPTION: SelectionSubscription = {
  dispose: () => undefined,
};

/**
 * A {@link SelectionAuthorityClient} that never attaches - for test doubles
 * and shell fixtures whose subject has nothing to do with host selection.
 *
 * Every arm is a truthful refusal rather than a silent no-op: `attach`
 * answers `superseded` (this client holds no issued generation and never
 * will), and `activate` answers `not-attached`. A fixture that accidentally
 * depends on the authority therefore fails visibly instead of observing an
 * empty selection that looks like a real one.
 *
 * Production shells never use this: desktop binds the main-process engine and
 * a shell with no main process mounts the engine in-window
 * (`MockRunnerHost`), because "which host is effective" must have exactly one
 * answer per app.
 */
export function createInertSelectionAuthorityClient(): SelectionAuthorityClient {
  return {
    attach: () => Promise.resolve({ ok: false, kind: "superseded" }),
    reportEvidence: () => Promise.resolve(),
    activate: () => Promise.resolve({ ok: false, reason: "not-attached" }),
    onSelectionChanged: () => NO_SUBSCRIPTION,
    onLeasesChanged: () => NO_SUBSCRIPTION,
    onReattachRequired: () => NO_SUBSCRIPTION,
  };
}
