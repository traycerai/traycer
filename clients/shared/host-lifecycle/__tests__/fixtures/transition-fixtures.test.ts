import { describe, expect, it } from "vitest";
import {
  BOTH_LABELS_ABSENT_CASE,
  allTransitionKillPointCasesIncludingExternalDamage,
  generateTransitionKillPointCases,
} from "./transition-fixtures";

// Self-test of the fixture GENERATOR (there is no reconciler yet to run
// these cases against — see the T6 test-authoring report). This only proves
// the generator itself is a faithful, total encoding of the cross product
// the cutover plan mandates, so downstream reconciler tests can iterate over
// it with confidence once T6's journal/reconciler lands.

describe("generateTransitionKillPointCases", () => {
  const cases = generateTransitionKillPointCases();

  it("covers every phase x {kill, disagreement} for both transition types", () => {
    const fallback = cases.filter((c) => c.transitionType === "fallback");
    const reclaim = cases.filter((c) => c.transitionType === "reclaim");
    // 5 fallback phases x 2 modes, 7 reclaim phases (including the
    // compensation branch and persisted probe-awaiting phase) x 2 modes.
    expect(fallback).toHaveLength(10);
    expect(reclaim).toHaveLength(14);
    expect(cases).toHaveLength(24);
  });

  it("never skips a phase index within a transition type", () => {
    for (const transitionType of ["fallback", "reclaim"] as const) {
      const indices = cases
        .filter((c) => c.transitionType === transitionType)
        .map((c) => c.phaseIndex);
      const uniqueSorted = Array.from(new Set(indices)).sort((a, b) => a - b);
      expect(uniqueSorted).toEqual(uniqueSorted.map((_, i) => i));
    }
  });

  it("pairs every phase with both kill and disagreement modes", () => {
    const byPhase = new Map<string, Set<string>>();
    for (const c of cases) {
      const key = `${c.transitionType}:${c.phase}`;
      const modes = byPhase.get(key) ?? new Set<string>();
      modes.add(c.mode);
      byPhase.set(key, modes);
    }
    for (const modes of byPhase.values()) {
      expect(Array.from(modes).sort()).toEqual(["disagreement", "kill"]);
    }
  });

  it("asserts I5 for every generated in-protocol case", () => {
    expect(cases.every((c) => c.assertsI5)).toBe(true);
  });

  it("gives each commit/cleanup phase idempotent-noop recovery", () => {
    const terminals = cases.filter(
      (c) =>
        c.phase === "fallback-committing" ||
        c.phase === "reclaim-cleaning-fallback",
    );
    expect(terminals.length).toBeGreaterThan(0);
    expect(
      terminals.every((c) => c.expectedRecovery === "idempotent-noop"),
    ).toBe(true);
  });

  it("gives the reclaim compensation phase compensate recovery, not forward-complete", () => {
    const compensating = cases.filter(
      (c) =>
        c.transitionType === "reclaim" &&
        c.phase === "reclaim-compensating-fallback",
    );
    expect(compensating.length).toBe(2);
    expect(compensating.every((c) => c.expectedRecovery === "compensate")).toBe(
      true,
    );
  });
});

describe("BOTH_LABELS_ABSENT_CASE", () => {
  it("is excluded from the generated cross product but present in the full set", () => {
    const generated = generateTransitionKillPointCases();
    expect(generated).not.toContainEqual(BOTH_LABELS_ABSENT_CASE);

    const full = allTransitionKillPointCasesIncludingExternalDamage();
    expect(full).toContainEqual(BOTH_LABELS_ABSENT_CASE);
    expect(full).toHaveLength(generated.length + 1);
  });

  it("does NOT assert I5 — external damage, not an in-protocol reachable state", () => {
    expect(BOTH_LABELS_ABSENT_CASE.assertsI5).toBe(false);
  });
});
