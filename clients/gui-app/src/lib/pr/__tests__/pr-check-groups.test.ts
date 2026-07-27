import { describe, it, expect } from "vitest";
import type { PrCheckContext } from "@traycer/protocol/host/pr-schemas";
import {
  formatPrCheckName,
  groupPrChecks,
  prCheckContextKey,
  prCheckOutcome,
} from "../pr-check-groups";

function check(overrides: Partial<PrCheckContext>): PrCheckContext {
  return {
    name: "build",
    workflowName: null,
    event: null,
    appName: null,
    appLogoUrl: null,
    description: null,
    status: "completed",
    conclusion: "success",
    detailsUrl: null,
    ...overrides,
  };
}

describe("prCheckOutcome", () => {
  it("keeps skipped apart from successful", () => {
    // The list previously drew a green tick over a skipped job, claiming a
    // pass that never happened.
    expect(prCheckOutcome(check({ conclusion: "skipped" }))).toBe("skipped");
    expect(prCheckOutcome(check({ conclusion: "success" }))).toBe("successful");
  });

  it("does not call a cancelled or stale run a failure", () => {
    // Neither ran to a verdict. Labelling them failing sends a reader hunting
    // for a defect that isn't there.
    expect(prCheckOutcome(check({ conclusion: "cancelled" }))).toBe("skipped");
    expect(prCheckOutcome(check({ conclusion: "stale" }))).toBe("skipped");
    expect(prCheckOutcome(check({ conclusion: "neutral" }))).toBe("skipped");
  });

  it("treats a timeout and action-required as failing", () => {
    expect(prCheckOutcome(check({ conclusion: "timed_out" }))).toBe("failing");
    expect(prCheckOutcome(check({ conclusion: "action_required" }))).toBe(
      "failing",
    );
    expect(prCheckOutcome(check({ conclusion: "failure" }))).toBe("failing");
  });

  it("treats anything not completed as pending, whatever its conclusion", () => {
    expect(prCheckOutcome(check({ status: "queued", conclusion: null }))).toBe(
      "pending",
    );
    expect(
      prCheckOutcome(check({ status: "in_progress", conclusion: "success" })),
    ).toBe("pending");
    expect(prCheckOutcome(check({ conclusion: null }))).toBe("pending");
  });
});

describe("groupPrChecks", () => {
  it("orders by how much attention a group wants, and pluralizes its heading", () => {
    const groups = groupPrChecks([
      check({ name: "ok-1", conclusion: "success" }),
      check({ name: "skip", conclusion: "skipped" }),
      check({ name: "bad", conclusion: "failure" }),
      check({ name: "ok-2", conclusion: "success" }),
      check({ name: "running", status: "in_progress", conclusion: null }),
    ]);
    expect(groups.map((group) => group.heading)).toEqual([
      "1 failing check",
      "1 pending check",
      "1 skipped check",
      "2 successful checks",
    ]);
  });

  it("drops empty groups, so a green PR shows exactly one heading", () => {
    const groups = groupPrChecks([
      check({ name: "a", conclusion: "success" }),
      check({ name: "b", conclusion: "success" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.outcome).toBe("successful");
  });

  it("keeps every context - grouping never drops a row", () => {
    const contexts = [
      check({ name: "a", conclusion: "success" }),
      check({ name: "b", conclusion: "failure" }),
      check({ name: "c", conclusion: "skipped" }),
      check({ name: "d", status: "queued", conclusion: null }),
    ];
    const total = groupPrChecks(contexts).reduce(
      (sum, group) => sum + group.contexts.length,
      0,
    );
    expect(total).toBe(contexts.length);
  });
});

describe("formatPrCheckName", () => {
  it("composes workflow, job and event the way GitHub names a run", () => {
    expect(
      formatPrCheckName(
        check({
          name: "pre-commit",
          workflowName: "Run Pre-commit",
          event: "pull_request",
        }),
      ),
    ).toBe("Run Pre-commit / pre-commit (pull_request)");
  });

  it("separates jobs that share a name", () => {
    // The bug this exists for: one reusable workflow across several packages
    // reports `build` every time, and a list showing only the job name has
    // five identical rows.
    const rows = [
      check({ name: "build", workflowName: "Build Host", event: "push" }),
      check({ name: "build", workflowName: "Build GUI", event: "push" }),
    ].map(formatPrCheckName);
    expect(new Set(rows).size).toBe(2);
  });

  it("degrades to the bare name for a check outside a workflow run", () => {
    // A third-party app's check has no workflow and no event; a placeholder
    // would read worse than the name alone.
    expect(formatPrCheckName(check({ name: "Mintlify Deployment" }))).toBe(
      "Mintlify Deployment",
    );
    expect(
      formatPrCheckName(check({ name: "CodeRabbit", workflowName: "" })),
    ).toBe("CodeRabbit");
  });

  it("keeps the workflow when only the event is missing", () => {
    expect(
      formatPrCheckName(check({ name: "build", workflowName: "Build Host" })),
    ).toBe("Build Host / build");
  });
});

describe("prCheckContextKey", () => {
  it("distinguishes two rows identical in every carried field", () => {
    // Keying on `name` alone gave duplicate React keys for the five `build`
    // rows this PR actually reports.
    const twin = check({ name: "build" });
    expect(prCheckContextKey(twin, 0)).not.toBe(prCheckContextKey(twin, 1));
  });

  it("prefers the per-run details url where there is one", () => {
    const context = check({ detailsUrl: "https://ci/run/1" });
    expect(prCheckContextKey(context, 3)).toBe("https://ci/run/1");
  });
});
