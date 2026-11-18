/**
 * A host that publishes while the authority check in front of a service
 * call is still being awaited: the verifier a test passes to
 * `withServiceMutationAuthority`, counting its own invocations and running
 * `publish` on one chosen invocation.
 *
 * The invocation to pick is the LAST one before the call under test, so that
 * every earlier check still reads the confirmed host and only a stop-target
 * read taken AFTER the verifier returns can see the replacement. A test finds
 * that ordinal with an unscoped dry run of the same scenario
 * (`publishAt: null`), recording `verifyCount()` as each call is issued.
 */
export interface VerifyRace {
  readonly verify: () => Promise<void>;
  readonly verifyCount: () => number;
}

export function createVerifyRace(
  publishAt: number | null,
  publish: () => void,
): VerifyRace {
  let verifications = 0;
  return {
    verify: async () => {
      verifications += 1;
      if (verifications === publishAt) publish();
    },
    verifyCount: () => verifications,
  };
}
