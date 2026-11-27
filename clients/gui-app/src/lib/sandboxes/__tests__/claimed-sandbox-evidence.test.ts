import { describe, expect, it } from "vitest";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  initialClaimedSandboxEvidence,
  reduceClaimedSandboxEvidence,
  type ClaimedSandboxEvent,
  type ClaimedSandboxExactOutcome,
  type ClaimedSandboxRow,
} from "@/lib/sandboxes/claimed-sandbox-evidence";

const identity = {
  sandboxId: "sandbox-1",
  hostId: "host-1",
  userId: "user-1",
  teamId: "team-1",
  boundary: 100,
  liveRoute: true,
};

function trace(liveRoute: boolean) {
  let state = initialClaimedSandboxEvidence({ ...identity, liveRoute });
  return (event: ClaimedSandboxEvent) => {
    const decision = reduceClaimedSandboxEvidence(state, event);
    state = decision.state;
    return decision;
  };
}

function row(
  state: "awake" | "stopped" | "destroyed",
  order: number,
  source: ClaimedSandboxRow["source"],
): ClaimedSandboxRow {
  return {
    row: sandboxSummaryFixture({
      id: identity.sandboxId,
      hostId: identity.hostId,
      state,
    }),
    order,
    source,
    sentAt: 101,
  };
}

function start(order: number, probe: boolean): ClaimedSandboxEvent {
  return { kind: "exact-start", request: { order, probe } };
}

function finish(
  order: number,
  finished: number,
  outcome: ClaimedSandboxExactOutcome,
): ClaimedSandboxEvent {
  return { kind: "exact-result", order, finished, outcome };
}

function listed(evidence: ClaimedSandboxRow | null): ClaimedSandboxEvent {
  return { kind: "list-result", row: evidence };
}

function account(
  dispatched: number,
  holds: boolean,
  pending: number[],
): ClaimedSandboxEvent {
  return {
    kind: "account",
    account: {
      pending,
      verdict: {
        userId: identity.userId,
        dispatched,
        verified: dispatched + 10,
        teamIds: holds ? [identity.teamId] : [],
      },
    },
  };
}

describe("claim evidence and its effects", () => {
  it.each(["before", "after"])(
    "requires no second probe for one verified hold received %s loss",
    (when) => {
      const step = trace(true);
      step(start(10, false));
      const hold = account(12, true, []);
      if (when === "before") step(hold);
      const parked = step(finish(10, 20, { kind: "lost", witness: "exact" }));
      expect(parked.passive).toBe(true);
      const ready = when === "before" ? parked : step(hold);
      expect(ready.read).toBe("probe");
      step(start(23, true));
      expect(step(finish(23, 25, { kind: "inconclusive" })).read).toBeNull();
      expect(step(hold).read).toBeNull();
    },
  );

  it.each([
    ["row first", false],
    ["verdict first", false],
    ["row first", true],
    ["verdict first", true],
  ] as const)(
    "gates a live probe, %s, later verification holds = %s",
    (first, holds) => {
      const step = trace(true);
      step(start(10, false));
      step(finish(10, 20, { kind: "lost", witness: "exact" }));
      step(account(21, true, []));
      step(start(32, true));
      step(account(21, true, [34]));
      const live = finish(32, 40, {
        kind: "row",
        row: row("awake", 32, "exact"),
      });
      const verified = account(34, holds, []);
      const next = first === "row first" ? step(live) : step(verified);
      expect(next.row).toBeNull();
      const settled = first === "row first" ? step(verified) : step(live);
      expect(settled.passive).toBe(!holds);
      expect(settled.row?.row?.state).toBe(holds ? "awake" : undefined);
    },
  );

  it("releases a live probe after a later verification exhausts", () => {
    const step = trace(true);
    step(start(10, false));
    step(finish(10, 20, { kind: "lost", witness: "exact" }));
    step(account(21, true, []));
    step(start(32, true));
    step(account(21, true, [34]));
    expect(
      step(finish(32, 40, { kind: "row", row: row("awake", 32, "exact") })).row,
    ).toBeNull();
    expect(step(account(21, true, [])).row?.row?.state).toBe("awake");
  });

  it.each(["before", "after"])(
    "applies a terminal probe with a later exclusion arriving %s it",
    (when) => {
      const step = trace(true);
      step(start(10, false));
      step(finish(10, 20, { kind: "lost", witness: "exact" }));
      step(account(21, true, []));
      step(start(32, true));
      step(account(21, true, [34]));
      const terminal = finish(32, 40, {
        kind: "row",
        row: row("destroyed", 32, "exact"),
      });
      if (when === "before") step(account(34, false, []));
      expect(step(terminal).row?.row?.state).toBe("destroyed");
      if (when === "after")
        expect(step(account(34, false, [])).row?.row?.state).toBe("destroyed");
    },
  );

  it.each([
    ["terminal before", "live"],
    ["terminal after", "live"],
    ["terminal before", "inconclusive"],
    ["terminal after", "inconclusive"],
  ] as const)(
    "keeps a terminal row through an omission, %s exact %s",
    (when, exact) => {
      const step = trace(true);
      step(start(15, false));
      const end = listed(row("destroyed", 16, "list"));
      if (when === "terminal before") {
        expect(step(end).row).toBeNull();
        expect(step(listed(null)).row).toBeNull();
      }
      const decision = step(
        finish(
          15,
          20,
          exact === "live"
            ? { kind: "row", row: row("awake", 15, "exact") }
            : { kind: "inconclusive" },
        ),
      );
      if (when === "terminal before")
        expect(decision.row?.row?.state).toBe("destroyed");
      else expect(step(end).row?.row?.state).toBe("destroyed");
      expect(step(listed(null)).row?.row?.state).toBe("destroyed");
    },
  );

  it.each(["before", "after"])(
    "fences a terminal list received %s a newer observed loss",
    (when) => {
      const step = trace(true);
      step(start(10, false));
      const listedEnd = listed(row("destroyed", 11, "list"));
      if (when === "before") expect(step(listedEnd).row).toBeNull();
      const loss = step(finish(10, 20, { kind: "lost", witness: "exact" }));
      expect(loss.passive).toBe(true);
      expect(loss.row).toBeNull();
      if (when === "after") expect(step(listedEnd).row).toBeNull();
    },
  );

  it.each(["legacy-passive", "lost"] as const)(
    "resumes ordinary reads after fresh independent evidence clears %s",
    (kind) => {
      const step = trace(true);
      step(start(10, false));
      expect(
        step(
          finish(
            10,
            20,
            kind === "lost" ? { kind, witness: "exact" } : { kind },
          ),
        ).passive,
      ).toBe(true);
      expect(step(listed(row("awake", 21, "list"))).passive).toBe(false);
      expect(step(listed(null)).read).toBe("exact");
    },
  );

  it("does one isolated bootstrap and one exact attempt with no route and an errored list", () => {
    const step = trace(false);
    expect(step(listed(null)).read).toBe("bootstrap");
    step({ kind: "bootstrap-start" });
    expect(step({ kind: "bootstrap-result", row: null }).read).toBe("exact");
    step(start(10, false));
    expect(step(finish(10, 20, { kind: "inconclusive" })).observeList).toBe(
      false,
    );
    expect(step(listed(null)).read).toBeNull();
    expect(step({ kind: "route", live: true }).read).toBe("exact");
  });

  it.each(["bootstrap", "shared"])(
    "selects the newer live list row when %s answers first",
    (first) => {
      const step = trace(false);
      step({ kind: "bootstrap-start" });
      step({ kind: "route", live: true });
      step({ kind: "list-start" });
      const bootstrap: ClaimedSandboxEvent = {
        kind: "bootstrap-result",
        row: row("stopped", 10, "list"),
      };
      const shared = listed(row("awake", 11, "list"));
      const pending = step(first === "bootstrap" ? bootstrap : shared);
      expect(pending.row).toBeNull();
      expect(pending.awaitingEvidence).toBe(true);
      const settled = step(first === "bootstrap" ? shared : bootstrap);
      expect(settled.row?.row?.state).toBe("awake");
      expect(settled.awaitingEvidence).toBe(false);
    },
  );

  it("can finish no-route startup while another observer is still fetching", () => {
    const step = trace(false);
    step({ kind: "list-start" });
    step({ kind: "bootstrap-start" });
    expect(step({ kind: "bootstrap-result", row: null }).read).toBe("exact");
    step(start(10, false));
    const done = step(finish(10, 20, { kind: "inconclusive" }));
    expect(done.read).toBeNull();
    expect(done.observeList).toBe(false);
    expect(step(listed(null)).read).toBeNull();
  });

  it("drops replies from retired work", () => {
    const step = trace(true);
    step(start(10, false));
    step({ kind: "retire" });
    const ended = step(
      finish(10, 20, { kind: "row", row: row("destroyed", 10, "exact") }),
    );
    expect(ended.row).toBeNull();
    expect(ended.read).toBeNull();
    expect(ended.observeList).toBe(false);
  });
});
