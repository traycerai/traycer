import type {
  SelectionAuthorityClient,
  SelectionSubscription,
} from "../host-selection/selection-authority-contract";

const NO_SUBSCRIPTION: SelectionSubscription = {
  dispose: () => undefined,
};

/**
 * A {@link SelectionAuthorityClient} that never attaches - for test doubles and shell fixtures whose subject has nothing to do with host selection.
 * Every arm is a truthful refusal rather than a silent no-op: `attach` answers `superseded` (this client holds no issued generation and never will), and `activate` answers `not-attached`.
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
