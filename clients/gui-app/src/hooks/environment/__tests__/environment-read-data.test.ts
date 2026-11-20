import { describe, expect, it } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { environmentReadData } from "../environment-read-data";

function doorError(
  doorReason: NonNullable<HostRpcError["doorRefusal"]>["doorReason"],
  retryable: boolean,
): HostRpcError {
  return new HostRpcError({
    code: "UNAUTHORIZED",
    message: "the host did not admit this token",
    requestId: "environment-read",
    method: "host.status",
    fatalDetails: null,
    doorRefusal: {
      code: "UNAUTHORIZED",
      reason: "the host did not admit this token",
      incompatibleMethods: null,
      upgradeGuidance: null,
      retryable,
      doorReason,
    },
  });
}

describe("environmentReadData", () => {
  it("keeps cached data for a retryable door refusal carried only by doorRefusal", () => {
    const data = { environments: ["cached"] };

    expect(
      environmentReadData({ data, error: doorError("not_admitted", true) }),
    ).toBe(data);
  });

  it("drops cached data for the same non-retryable door refusal", () => {
    const data = { environments: ["cached"] };

    expect(
      environmentReadData({ data, error: doorError("not_admitted", false) }),
    ).toBeUndefined();
  });

  it.each(["clock_skew", "enrolment_broken"] as const)(
    "keeps cached data for a non-retryable %s door refusal",
    (doorReason) => {
      const data = { environments: ["cached"] };

      expect(
        environmentReadData({
          data,
          error: doorError(doorReason, false),
        }),
      ).toBe(data);
    },
  );
});
