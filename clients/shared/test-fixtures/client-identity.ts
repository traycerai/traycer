import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  type FirstPartyClientIdentity,
} from "@traycer/protocol/framework/index";

/**
 * The client identity every transport suite constructs with.
 * It carries the real current epoch rather than a made-up number: the epoch is what a host gates on, so a fixture that invented one would let a suite pass against a value no shipped client sends.
 */
export const TEST_CLIENT_IDENTITY: FirstPartyClientIdentity = {
  kind: "desktop",
  compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  appVersion: "0.0.0-test",
};
