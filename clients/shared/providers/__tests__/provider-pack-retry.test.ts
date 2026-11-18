import { describe, expect, it } from "vitest";
import {
  providerManagedInstallErrorReasonSchema,
  type ProviderManagedInstallErrorReason,
} from "@traycer/protocol/host/provider-schemas";
import { providerPackReasonRetryable } from "../provider-pack-retry";

const EXPECTED: Readonly<Record<ProviderManagedInstallErrorReason, boolean>> = {
  "disk-full": true,
  network: true,
  verification: true,
  "live-owner-stalled": true,
  unknown: true,
  unrepairable: false,
  "trust-unavailable": false,
  "local-storage-mismatch": false,
};

describe("providerPackReasonRetryable", () => {
  it.each(providerManagedInstallErrorReasonSchema.options)(
    "answers for %s as the allow-list says",
    (reason) => {
      expect(providerPackReasonRetryable(reason)).toBe(EXPECTED[reason]);
    },
  );

  it("covers all eight reasons of the protocol's closed vocabulary", () => {
    expect(providerManagedInstallErrorReasonSchema.options).toHaveLength(8);
    expect(Object.keys(EXPECTED).sort()).toEqual(
      [...providerManagedInstallErrorReasonSchema.options].sort(),
    );
  });

  it("allows retry for exactly the five transient reasons", () => {
    const retryable = providerManagedInstallErrorReasonSchema.options.filter(
      (reason) => providerPackReasonRetryable(reason),
    );
    expect([...retryable].sort()).toEqual([
      "disk-full",
      "live-owner-stalled",
      "network",
      "unknown",
      "verification",
    ]);
  });
});
