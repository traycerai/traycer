import { describe, expect, it } from "vitest";
import { viewReplicaEvictionForVerdictLoss } from "@/lib/view-replica/view-replica-store";

describe("viewReplicaEvictionForVerdictLoss", () => {
  it("keeps pages when authn is unreachable", () => {
    expect(viewReplicaEvictionForVerdictLoss("unreachable", "user-a")).toEqual({
      kind: "transport-unavailable",
    });
  });

  it.each(["session-rejected", "ended-elsewhere"] as const)(
    "keeps pages when the credential is refused (%s)",
    (loss) => {
      expect(viewReplicaEvictionForVerdictLoss(loss, "user-a")).toEqual({
        kind: "credential-refused",
      });
    },
  );

  it("drops the account's pages when the account is unavailable", () => {
    expect(
      viewReplicaEvictionForVerdictLoss("account-unavailable", "user-a"),
    ).toEqual({ kind: "account-refused", accountId: "user-a" });
  });
});
