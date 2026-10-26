import { describe, expect, it } from "vitest";
import {
  configurationChipState,
  withUnconfirmedHosts,
  type ConfigurationChipHost,
} from "@/components/settings/environment/status-chip-model";

function host(
  hostId: string,
  state: ConfigurationChipHost["state"],
  rowState: string,
): ConfigurationChipHost {
  return {
    hostId,
    name: hostId.toUpperCase(),
    state,
    lastReportedAt: null,
    rows: [
      {
        hostId,
        name: hostId.toUpperCase(),
        item: "variable:X",
        state: rowState,
        reason: null,
        at: null,
        lastReportedAt: null,
        recovery: null,
      },
    ],
  };
}

describe("withUnconfirmedHosts", () => {
  it("marks only applying hosts in the set, and their received rows", () => {
    const result = withUnconfirmedHosts(
      [
        host("a", "applying", "received"),
        host("b", "applying", "received"),
        host("c", "applied", "received"),
      ],
      new Set(["a", "c"]),
    );
    expect(result.map((entry) => entry.state)).toEqual([
      "unconfirmed",
      "applying",
      "applied",
    ]);
    expect(result[0]?.rows[0]?.state).toBe("unconfirmed");
  });
});

describe("configurationChipState", () => {
  it("says a host hasn't confirmed, with Details", () => {
    expect(
      configurationChipState(
        [host("a", "unconfirmed", "received")],
        false,
        "empty",
      ),
    ).toMatchObject({ text: "A hasn't confirmed", details: true });
  });

  it("lets a not-applied host win over an unconfirmed one", () => {
    const state = configurationChipState(
      [
        host("a", "unconfirmed", "received"),
        host("b", "not_applied", "not_applied"),
      ],
      false,
      "empty",
    );
    expect(state).toMatchObject({ text: "1 not applied on B", details: false });
  });

  it("names three hosts and counts four", () => {
    const three = ["a", "b", "c"].map((id) => host(id, "applied", "applied"));
    expect(configurationChipState(three, false, "empty").text).toBe(
      "✓ On A, B and 1 more",
    );
    expect(
      configurationChipState(
        [...three, host("d", "applied", "applied")],
        false,
        "empty",
      ).text,
    ).toBe("✓ On 4 hosts");
  });
});
