import { describe, expect, it } from "vitest";
import type { HostLeaseDeadState } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { BoundedHostLoad } from "@/hooks/host/use-bounded-host-load";
import { tileHostLoadMessage, tileLoadNoun } from "../tile-host-load-copy";

const NOUN = tileLoadNoun("agent");

const DEAD_REASONS: readonly HostLeaseDeadState[] = [
  { reason: "offline" },
  { reason: "plan-restricted" },
  { reason: "removed" },
  {
    reason: "incompatible",
    detail: {
      code: "protocol-major-behind",
      hostVersion: null,
      minSupportedVersion: null,
      clientCompatibility: null,
    },
  },
];

describe("tileLoadNoun", () => {
  it.each([
    ["agent", "agent"],
    ["terminal", "terminal"],
    ["shell-output", "output"],
    ["diff", "diff"],
    ["pull-request", "pull request"],
    ["document", "document"],
  ] as const)("names the %s subject '%s'", (subject, noun) => {
    expect(tileLoadNoun(subject)).toBe(noun);
  });
});

describe("tileHostLoadMessage", () => {
  it("connecting: says it is waiting for the host to start", () => {
    const load: BoundedHostLoad = {
      kind: "connecting",
      hostLabel: "Work laptop",
    };
    expect(tileHostLoadMessage(load, NOUN)).toBe(
      'Waiting for "Work laptop" to start…',
    );
  });

  it("loading: names the subject and the host it is loading from", () => {
    const load: BoundedHostLoad = { kind: "loading", hostLabel: "Work laptop" };
    expect(tileHostLoadMessage(load, NOUN)).toBe(
      'Loading this agent from "Work laptop"…',
    );
  });

  it("timed-out: says the host hasn't answered, without claiming it is dead", () => {
    const load: BoundedHostLoad = {
      kind: "timed-out",
      hostLabel: "Work laptop",
    };
    const message = tileHostLoadMessage(load, NOUN);
    expect(message).toContain("hasn't answered");
    // The host may be fine and merely slow - this arm must not say the
    // stronger, unproven thing.
    expect(message).not.toContain("offline");
    expect(message).not.toContain("dead");
  });

  it.each(DEAD_REASONS)(
    "dead ($reason): renders the reason-specific sentence",
    (dead) => {
      const load: BoundedHostLoad = {
        kind: "dead",
        dead,
        hostLabel: "Work laptop",
      };
      const message = tileHostLoadMessage(load, NOUN);
      switch (dead.reason) {
        case "offline":
          expect(message).toContain("is offline");
          expect(message).toContain("will load once that host is back");
          break;
        case "plan-restricted":
          expect(message).toContain("local only on your current plan");
          expect(message).toContain("Upgrade");
          break;
        case "removed":
          expect(message).toContain("was removed from your account");
          break;
        case "incompatible":
          expect(message).toContain("needs to be updated");
          break;
      }
    },
  );

  it("every dead reason produces a DISTINCT sentence, not one generic fallback", () => {
    const messages = DEAD_REASONS.map((dead) =>
      tileHostLoadMessage(
        { kind: "dead", dead, hostLabel: "Work laptop" },
        NOUN,
      ),
    );
    expect(new Set(messages).size).toBe(DEAD_REASONS.length);
  });

  const NULL_LABEL_LOADS: readonly Exclude<
    BoundedHostLoad,
    { kind: "ready" } | { kind: "dead" }
  >[] = [
    { kind: "connecting", hostLabel: null },
    { kind: "loading", hostLabel: null },
    { kind: "timed-out", hostLabel: null },
  ];

  it.each(NULL_LABEL_LOADS)(
    "hostLabel null renders 'the host', never a raw id, for $kind",
    (load) => {
      const message = tileHostLoadMessage(load, NOUN);
      expect(message).toContain("the host");
      expect(message).not.toContain("host-1");
      expect(message).not.toContain("null");
    },
  );

  it("hostLabel null renders 'the host' on every dead reason too", () => {
    for (const dead of DEAD_REASONS) {
      const message = tileHostLoadMessage(
        { kind: "dead", dead, hostLabel: null },
        NOUN,
      );
      expect(message).toContain("the host");
      expect(message).not.toContain('""');
    }
  });
});
