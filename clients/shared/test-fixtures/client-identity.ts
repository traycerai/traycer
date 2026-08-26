import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  type FirstPartyClientIdentity,
} from "@traycer/protocol/framework/index";

/**
 * The client identity every transport suite constructs with.
 *
 * It carries the REAL current epoch rather than a made-up number: the epoch is
 * what a host gates on, so a fixture that invented one would let a suite pass
 * against a value no shipped client sends. The app version is a fixture
 * string, which is exactly the right shape - the version is a diagnostic and
 * must never change any verdict, so tests asserting admission should be
 * indifferent to it.
 */
export const TEST_CLIENT_IDENTITY: FirstPartyClientIdentity = {
  kind: "desktop",
  compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  appVersion: "0.0.0-test",
};
