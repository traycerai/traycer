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
  personalScope: false,
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

function listed(
  evidence: ClaimedSandboxRow | null,
  order: number | undefined,
): ClaimedSandboxEvent {
  return {
    kind: "list-result",
    answer: {
      order: evidence?.order ?? order ?? 100,
      sentAt: 101,
      row: evidence?.row ?? null,
    },
  };
}

function bootstrap(
  row: ClaimedSandboxRow | null,
  order: number,
): ClaimedSandboxEvent {
  return {
    kind: "bootstrap-result",
    answer: { order, sentAt: 101, row: row?.row ?? null },
  };
}

function account(
  dispatched: number,
  verified: number,
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
        verified,
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
      const hold = account(12, when === "before" ? 18 : 22, true, []);
      if (when === "before") step(hold);
      const parked = step(
        finish(10, 20, { kind: "not-found", sentAt: 101, holdsTeam: false }),
      );
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
      step(
        finish(10, 20, { kind: "not-found", sentAt: 101, holdsTeam: false }),
      );
      step(account(21, 31, true, []));
      step(start(32, true));
      step(account(21, 31, true, [34]));
      const live = finish(32, 40, {
        kind: "row",
        row: row("awake", 32, "exact"),
      });
      const verified = account(34, first === "row first" ? 44 : 38, holds, []);
      const next = first === "row first" ? step(live) : step(verified);
      expect(next.row).toBeNull();
      const settled = first === "row first" ? step(verified) : step(live);
      expect(settled.passive).toBe(!holds);
      expect(settled.row?.row?.state).toBe(holds ? "awake" : undefined);
    },
  );

  it.each(["probe", "verdict"] as const)(
    "releases a live probe after a later verification exhausts, %s first",
    (first) => {
      const step = trace(true);
      step(start(10, false));
      step(
        finish(10, 20, { kind: "not-found", sentAt: 101, holdsTeam: false }),
      );
      step(account(21, 31, true, []));
      step(start(32, true));
      step(account(21, 31, true, [34]));
      const live = finish(32, 40, {
        kind: "row",
        row: row("awake", 32, "exact"),
      });
      const exhausted = account(21, 31, true, []);
      expect(step(first === "probe" ? live : exhausted).row).toBeNull();
      expect(step(first === "probe" ? exhausted : live).row?.row?.state).toBe(
        "awake",
      );
    },
  );

  it.each(["before", "after"])(
    "applies a terminal probe with a later exclusion arriving %s it",
    (when) => {
      const step = trace(true);
      step(start(10, false));
      step(
        finish(10, 20, { kind: "not-found", sentAt: 101, holdsTeam: false }),
      );
      step(account(21, 31, true, []));
      step(start(32, true));
      step(account(21, 31, true, [34]));
      const terminal = finish(32, 40, {
        kind: "row",
        row: row("destroyed", 32, "exact"),
      });
      if (when === "before") step(account(34, 38, false, []));
      expect(step(terminal).row?.row?.state).toBe("destroyed");
      if (when === "after")
        expect(step(account(34, 44, false, [])).row?.row?.state).toBe(
          "destroyed",
        );
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
      const end = listed(row("destroyed", 16, "list"), undefined);
      if (when === "terminal before") {
        expect(step(end).row).toBeNull();
        expect(step(listed(null, undefined)).row).toBeNull();
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
      expect(step(listed(null, undefined)).row?.row?.state).toBe("destroyed");
    },
  );

  it.each(["before", "after"])(
    "fences a terminal list received %s a newer observed loss",
    (when) => {
      const step = trace(true);
      step(start(10, false));
      const listedEnd = listed(row("destroyed", 11, "list"), undefined);
      if (when === "before") expect(step(listedEnd).row).toBeNull();
      const loss = step(
        finish(10, 20, { kind: "not-found", sentAt: 101, holdsTeam: false }),
      );
      expect(loss.passive).toBe(true);
      expect(loss.row).toBeNull();
      if (when === "after") expect(step(listedEnd).row).toBeNull();
    },
  );

  it.each(["account first", "access first"] as const)(
    "uses a later-dispatched hold against a legacy access loss, %s",
    (first) => {
      const step = trace(true);
      step(start(10, false));
      const fieldless = finish(10, 11, {
        kind: "not-found",
        sentAt: 101,
        holdsTeam: undefined,
      });
      expect(step(fieldless).read).toBe("access");
      step({ kind: "access-start" });
      const verified = account(
        14,
        first === "account first" ? 15 : 20,
        true,
        [],
      );
      const lost = {
        kind: "access-result",
        dispatched: 12,
        holdsTeam: false,
        finished: 18,
      } as const;
      if (first === "account first") {
        expect(step(verified).read).toBeNull();
        expect(step(lost).read).toBe("probe");
      } else {
        expect(step(lost).read).toBeNull();
        expect(step(verified).read).toBe("probe");
      }
    },
  );

  it.each(["legacy-passive", "lost"] as const)(
    "resumes ordinary reads after fresh independent evidence clears %s",
    (kind) => {
      const step = trace(true);
      step(start(10, false));
      if (kind === "lost") {
        expect(
          step(
            finish(10, 20, {
              kind: "not-found",
              sentAt: 101,
              holdsTeam: false,
            }),
          ).passive,
        ).toBe(true);
      } else {
        expect(
          step(
            finish(10, 20, {
              kind: "not-found",
              sentAt: 101,
              holdsTeam: undefined,
            }),
          ).read,
        ).toBe("access");
        step({ kind: "access-start" });
        expect(
          step({
            kind: "access-result",
            dispatched: 15,
            holdsTeam: true,
            finished: 20,
          }).passive,
        ).toBe(true);
      }
      expect(step(listed(row("awake", 21, "list"), undefined)).passive).toBe(
        false,
      );
      expect(step(listed(null, undefined)).read).toBe("exact");
    },
  );

  it.each(["before", "after"] as const)(
    "uses newer independent evidence delivered %s an inconclusive probe",
    (when) => {
      const step = trace(true);
      step(start(10, false));
      step(
        finish(10, 20, { kind: "not-found", sentAt: 101, holdsTeam: false }),
      );
      step(account(21, 30, true, []));
      step(start(32, true));
      const live = listed(row("awake", 35, "list"), undefined);
      const inconclusive = finish(32, 40, { kind: "inconclusive" });
      const first = step(when === "before" ? live : inconclusive);
      expect(first.row).toBeNull();
      const settled = step(when === "before" ? inconclusive : live);
      expect(settled.row?.row?.state).toBe("awake");
      expect(settled.passive).toBe(false);
      expect(step(listed(null, 45)).read).toBe("exact");
    },
  );

  it("does one isolated bootstrap and one exact attempt with no route and an errored list", () => {
    const step = trace(false);
    expect(step(listed(null, undefined)).read).toBe("bootstrap");
    step({ kind: "bootstrap-start" });
    expect(step(bootstrap(null, 5)).read).toBe("exact");
    step(start(10, false));
    expect(step(finish(10, 20, { kind: "inconclusive" })).observeList).toBe(
      false,
    );
    expect(step(listed(null, 110)).read).toBeNull();
    expect(step({ kind: "route", live: true }).read).toBe("exact");
  });

  it.each(["bootstrap", "shared"])(
    "selects the newer live list row when %s answers first",
    (first) => {
      const step = trace(false);
      step({ kind: "bootstrap-start" });
      step({ kind: "route", live: true });
      step({ kind: "list-start" });
      const startup = bootstrap(row("stopped", 10, "list"), 10);
      const shared = listed(row("awake", 11, "list"), undefined);
      const pending = step(first === "bootstrap" ? startup : shared);
      expect(pending.row).toBeNull();
      expect(pending.awaitingEvidence).toBe(true);
      const settled = step(first === "bootstrap" ? shared : startup);
      expect(settled.row?.row?.state).toBe("awake");
      expect(settled.awaitingEvidence).toBe(false);
    },
  );

  it.each(["startup", "shared"] as const)(
    "keeps the newer omission when %s answers first",
    (first) => {
      const step = trace(false);
      step({ kind: "bootstrap-start" });
      step({ kind: "route", live: true });
      step({ kind: "list-start" });
      const startup = bootstrap(row("awake", 10, "list"), 10);
      const omission = listed(null, 11);
      expect(step(first === "startup" ? startup : omission).row).toBeNull();
      const settled = step(first === "startup" ? omission : startup);
      expect(settled.row).toBeNull();
      expect(settled.read).toBe("exact");
    },
  );

  it.each(["startup", "shared"] as const)(
    "settles the shared terminal row after both startup reads, %s first",
    (first) => {
      const step = trace(false);
      step({ kind: "bootstrap-start" });
      step({ kind: "list-start" });
      const startup = bootstrap(null, 5);
      const shared = listed(row("destroyed", 10, "list"), undefined);
      const firstResult = step(first === "startup" ? startup : shared);
      expect(firstResult.read).toBeNull();
      expect(firstResult.row).toBeNull();
      const settled = step(first === "startup" ? shared : startup);
      expect(settled.read).toBeNull();
      expect(settled.row?.row?.state).toBe("destroyed");
    },
  );

  it.each(["list", "held 404"] as const)(
    "keeps a held exact 404 over an overlapping live list, %s first",
    (first) => {
      const step = trace(true);
      step(start(10, false));
      step({ kind: "list-start" });
      const held = finish(10, 20, {
        kind: "not-found",
        sentAt: 101,
        holdsTeam: true,
      });
      const live = listed(row("awake", 11, "list"), undefined);
      const leading = step(first === "list" ? live : held);
      expect(leading.row?.row ?? null).toBeNull();
      const settled = step(first === "list" ? held : live);
      expect(settled.row).toMatchObject({ row: null, source: "exact" });
    },
  );

  it.each(["old", "current"] as const)(
    "rejects an exact reply from a superseded order, %s first",
    (first) => {
      const step = trace(true);
      step(start(10, false));
      step(finish(10, 15, { kind: "inconclusive" }));
      step(start(20, false));
      const old = finish(10, 30, {
        kind: "not-found",
        sentAt: 101,
        holdsTeam: true,
      });
      const current = finish(20, 31, {
        kind: "row",
        row: row("awake", 20, "exact"),
      });
      const leading = step(first === "old" ? old : current);
      expect(leading.row?.row?.state).toBe(
        first === "old" ? undefined : "awake",
      );
      expect(step(first === "old" ? current : old).row?.row?.state).toBe(
        "awake",
      );
    },
  );

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
