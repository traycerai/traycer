import { describe, expect, it } from "vitest";
import {
  DATA_MIGRATION_PROTOCOL_VERSION,
  MIGRATION_PHASES,
  actionsInInverseOrder,
  canTransitionPhase,
  canonicalJson,
  checkJournalSuccessor,
  currentComponentHandshake,
  decideExternalAction,
  incompatibleHandshakes,
  phaseHoldsStartupBarrier,
  phaseIsPostActivation,
  phaseIsTerminal,
  plannedJournal,
  rollbackAllowedFrom,
  sessionImpactBlockers,
  sessionImpactDigest,
  sessionImpactRequiresAcceptance,
  sha256Digest,
  type ExternalAction,
  type MigrationJournal,
  type MigrationPhase,
  type ObjectFingerprint,
  type SessionImpact,
  type SessionImpactReport,
} from "../data-migration-contracts";

const ABSENT: ObjectFingerprint = { kind: "absent" };
const BEFORE: ObjectFingerprint = {
  kind: "present",
  digest: sha256Digest("before"),
};
const AFTER: ObjectFingerprint = {
  kind: "present",
  digest: sha256Digest("after"),
};
const THIRD: ObjectFingerprint = {
  kind: "present",
  digest: sha256Digest("third"),
};

// The authoritative phase table, restated independently of the module.
const ALLOWED: Readonly<Record<MigrationPhase, readonly MigrationPhase[]>> = {
  planned: ["quiescing", "rolled-back"],
  quiescing: ["copying", "rollback-requested"],
  copying: ["repairing", "rollback-requested"],
  repairing: ["preparing-external", "rollback-requested"],
  "preparing-external": ["ready", "rollback-requested"],
  ready: ["switching", "rollback-requested"],
  switching: ["switched", "rollback-requested"],
  switched: ["activated", "rollback-requested"],
  activated: ["cleaning", "complete"],
  cleaning: ["complete"],
  complete: ["cleaning"],
  "rollback-requested": ["rolled-back"],
  "rolled-back": [],
};

function baseJournal(): MigrationJournal {
  return plannedJournal({
    id: "m-00000000-aaaa-bbbb-cccc-000000000001",
    previousLocation: null,
    source: { path: "/home/u/.traycer", volumeId: null, directoryId: null },
    destination: { path: "/data/traycer", volumeId: "v1", directoryId: "d1" },
    nextGeneration: 1,
    coordinatorBuild: currentComponentHandshake("cli", "1.0.0"),
    coordinatorExecutableSha256: null,
    coordinator: { pid: 100, startIdentity: "start-100", lockNonce: "nonce-1" },
    now: "2026-10-16T00:00:00.000Z",
  });
}

function successor(
  current: MigrationJournal,
  phase: MigrationPhase,
  overrides: Partial<MigrationJournal>,
): MigrationJournal {
  const rollbackFromPhase =
    phase === "rollback-requested" && current.phase !== "rollback-requested"
      ? current.phase
      : current.rollbackFromPhase;
  const activationRevision =
    phase === "activated" && current.phase !== "activated"
      ? current.revision + 1
      : current.activationRevision;
  return {
    ...current,
    revision: current.revision + 1,
    phase,
    rollbackFromPhase,
    activationRevision,
    ...overrides,
  };
}

function journalAt(phase: MigrationPhase): MigrationJournal {
  // Walk the real forward chain so each step is itself a valid successor.
  const chain: MigrationPhase[] = [
    "quiescing",
    "copying",
    "repairing",
    "preparing-external",
    "ready",
    "switching",
    "switched",
    "activated",
    "cleaning",
    "complete",
  ];
  let current = baseJournal();
  if (phase === "planned") return current;
  for (const step of chain) {
    current = successor(current, step, {});
    if (step === phase) return current;
  }
  throw new Error(`journalAt does not build ${phase}`);
}

describe("phase table", () => {
  it("allows exactly the documented edges and refuses every other pair", () => {
    for (const from of MIGRATION_PHASES) {
      for (const to of MIGRATION_PHASES) {
        expect(canTransitionPhase(from, to), `${from} -> ${to}`).toBe(
          ALLOWED[from].includes(to),
        );
      }
    }
  });

  it("allows rollback from every phase before activated and none after", () => {
    for (const phase of [
      "planned",
      "quiescing",
      "copying",
      "repairing",
      "preparing-external",
      "ready",
      "switching",
      "switched",
    ] as const) {
      expect(rollbackAllowedFrom(phase), phase).toBe(true);
    }
    for (const phase of [
      "activated",
      "cleaning",
      "complete",
      "rolled-back",
    ] as const) {
      expect(rollbackAllowedFrom(phase), phase).toBe(false);
    }
    expect(canTransitionPhase("planned", "rolled-back")).toBe(true);
    expect(canTransitionPhase("planned", "rollback-requested")).toBe(false);
  });

  it("classifies barrier, post-activation and terminal phases", () => {
    const barrier = new Set<MigrationPhase>([
      "quiescing",
      "copying",
      "repairing",
      "preparing-external",
      "ready",
      "switching",
      "switched",
      "rollback-requested",
    ]);
    for (const phase of MIGRATION_PHASES) {
      expect(phaseHoldsStartupBarrier(phase), phase).toBe(barrier.has(phase));
    }
    expect(phaseHoldsStartupBarrier("planned")).toBe(false);
    expect(phaseHoldsStartupBarrier("activated")).toBe(false);
    expect(phaseIsPostActivation("activated")).toBe(true);
    expect(phaseIsPostActivation("cleaning")).toBe(true);
    expect(phaseIsPostActivation("complete")).toBe(true);
    expect(phaseIsPostActivation("switched")).toBe(false);
    expect(phaseIsTerminal("complete")).toBe(true);
    expect(phaseIsTerminal("rolled-back")).toBe(true);
    expect(phaseIsTerminal("cleaning")).toBe(false);
  });
});

describe("checkJournalSuccessor", () => {
  it("accepts a first planned revision 1 and refuses anything else as first", () => {
    const first = baseJournal();
    expect(checkJournalSuccessor(null, first)).toBeNull();
    expect(checkJournalSuccessor(null, { ...first, revision: 2 })?.code).toBe(
      "revision-not-next",
    );
    expect(
      checkJournalSuccessor(null, { ...first, phase: "quiescing" })?.code,
    ).toBe("phase-transition-refused");
    expect(
      checkJournalSuccessor(null, { ...first, activationRevision: 1 })?.code,
    ).toBe("activation-revision-invalid");
  });

  it("accepts every allowed forward edge as the next revision", () => {
    const planned = baseJournal();
    expect(
      checkJournalSuccessor(planned, successor(planned, "quiescing", {})),
    ).toBeNull();
    for (const from of [
      "quiescing",
      "copying",
      "repairing",
      "preparing-external",
      "ready",
      "switching",
      "switched",
    ] as const) {
      const current = journalAt(from);
      for (const to of ALLOWED[from]) {
        expect(
          checkJournalSuccessor(current, successor(current, to, {})),
          `${from} -> ${to}`,
        ).toBeNull();
      }
    }
  });

  it("refuses every disallowed edge", () => {
    for (const from of [
      "planned",
      "quiescing",
      "ready",
      "switched",
      "activated",
      "cleaning",
      "complete",
    ] as const) {
      const current = journalAt(from);
      for (const to of MIGRATION_PHASES) {
        if (to === from || ALLOWED[from].includes(to)) continue;
        const refusal = checkJournalSuccessor(
          current,
          successor(current, to, {}),
        );
        expect(refusal, `${from} -> ${to}`).not.toBeNull();
      }
    }
  });

  it("refuses rollback from activated, cleaning and complete with the dedicated code", () => {
    for (const from of ["activated", "cleaning", "complete"] as const) {
      const current = journalAt(from);
      const next = successor(current, "rollback-requested", {});
      expect(checkJournalSuccessor(current, next)?.code, from).toBe(
        "rollback-refused-after-activation",
      );
    }
  });

  it("allows planned -> rolled-back with a null rollback origin", () => {
    const planned = baseJournal();
    const next = successor(planned, "rolled-back", {});
    expect(next.rollbackFromPhase).toBeNull();
    expect(checkJournalSuccessor(planned, next)).toBeNull();
    expect(
      checkJournalSuccessor(planned, { ...next, rollbackFromPhase: "planned" })
        ?.code,
    ).toBe("rollback-origin-invalid");
  });

  it("requires the revision to advance by exactly one", () => {
    const current = journalAt("copying");
    for (const revision of [
      current.revision,
      current.revision + 2,
      current.revision - 1,
    ]) {
      expect(
        checkJournalSuccessor(current, {
          ...successor(current, "repairing", {}),
          revision,
        })?.code,
        String(revision),
      ).toBe("revision-not-next");
    }
  });

  it("keeps the id and the immutable fields fixed", () => {
    const current = journalAt("copying");
    const next = successor(current, "repairing", {});
    expect(
      checkJournalSuccessor(current, {
        ...next,
        id: "m-00000000-aaaa-bbbb-cccc-000000000002",
      })?.code,
    ).toBe("id-changed");
    const mutations: Partial<MigrationJournal>[] = [
      { source: { ...current.source, path: "/elsewhere" } },
      { destination: { ...current.destination, path: "/elsewhere" } },
      { nextGeneration: current.nextGeneration + 1 },
      { createdAt: "2030-01-01T00:00:00.000Z" },
      {
        previousLocation: {
          version: 1,
          generation: 1,
          root: "/prev",
          migrationId: null,
        },
      },
    ];
    for (const mutation of mutations) {
      expect(
        checkJournalSuccessor(current, { ...next, ...mutation })?.code,
        canonicalJson(mutation),
      ).toBe("immutable-field-changed");
    }
  });

  it("allows mutable fields to change without a phase change", () => {
    const current = journalAt("copying");
    const next = {
      ...current,
      revision: current.revision + 1,
      inventoryDigest: sha256Digest("inv"),
      updatedAt: "2026-10-16T01:00:00.000Z",
    };
    expect(checkJournalSuccessor(current, next)).toBeNull();
  });

  it("sets activationRevision exactly once, by the activating revision", () => {
    const switched = journalAt("switched");
    const activated = successor(switched, "activated", {});
    expect(activated.activationRevision).toBe(activated.revision);
    expect(checkJournalSuccessor(switched, activated)).toBeNull();
    // Missing on the activating revision.
    expect(
      checkJournalSuccessor(switched, {
        ...activated,
        activationRevision: null,
      })?.code,
    ).toBe("activation-revision-invalid");
    // Wrong revision number on the activating revision.
    expect(
      checkJournalSuccessor(switched, { ...activated, activationRevision: 1 })
        ?.code,
    ).toBe("activation-revision-invalid");
    // Set before activation.
    const copying = journalAt("copying");
    expect(
      checkJournalSuccessor(copying, {
        ...successor(copying, "repairing", {}),
        activationRevision: copying.revision + 1,
      })?.code,
    ).toBe("activation-revision-invalid");
    // Changed after activation.
    expect(
      checkJournalSuccessor(activated, {
        ...successor(activated, "cleaning", {}),
        activationRevision: activated.revision + 1,
      })?.code,
    ).toBe("activation-revision-invalid");
    // Carried forward unchanged after activation.
    expect(
      checkJournalSuccessor(activated, successor(activated, "cleaning", {})),
    ).toBeNull();
  });

  it("records rollbackFromPhase once, from the phase rollback was requested in", () => {
    const switching = journalAt("switching");
    const requested = successor(switching, "rollback-requested", {});
    expect(requested.rollbackFromPhase).toBe("switching");
    expect(checkJournalSuccessor(switching, requested)).toBeNull();
    expect(
      checkJournalSuccessor(switching, {
        ...requested,
        rollbackFromPhase: null,
      })?.code,
    ).toBe("rollback-origin-invalid");
    expect(
      checkJournalSuccessor(switching, {
        ...requested,
        rollbackFromPhase: "switched",
      })?.code,
    ).toBe("rollback-origin-invalid");
    // Carried unchanged into rolled-back; changing it is refused.
    const rolledBack = successor(requested, "rolled-back", {});
    expect(rolledBack.rollbackFromPhase).toBe("switching");
    expect(checkJournalSuccessor(requested, rolledBack)).toBeNull();
    expect(
      checkJournalSuccessor(requested, {
        ...rolledBack,
        rollbackFromPhase: "ready",
      })?.code,
    ).toBe("rollback-origin-invalid");
    // Set without requesting rollback.
    const copying = journalAt("copying");
    expect(
      checkJournalSuccessor(copying, {
        ...successor(copying, "repairing", {}),
        rollbackFromPhase: "copying",
      })?.code,
    ).toBe("rollback-origin-invalid");
  });
});

describe("decideExternalAction", () => {
  function action(
    state: ExternalAction["state"],
  ): Pick<ExternalAction, "before" | "after" | "state"> {
    return { before: BEFORE, after: AFTER, state };
  }

  it("forward direction", () => {
    expect(decideExternalAction(action("planned"), BEFORE, "forward")).toBe(
      "apply",
    );
    // Action applied but the receipt never landed.
    expect(decideExternalAction(action("planned"), AFTER, "forward")).toBe(
      "record-applied",
    );
    expect(decideExternalAction(action("planned"), THIRD, "forward")).toBe(
      "conflict",
    );
    expect(decideExternalAction(action("applied"), AFTER, "forward")).toBe(
      "none",
    );
    expect(decideExternalAction(action("applied"), BEFORE, "forward")).toBe(
      "conflict",
    );
    expect(decideExternalAction(action("applied"), THIRD, "forward")).toBe(
      "conflict",
    );
    for (const state of ["abandoned", "inverted"] as const) {
      for (const observed of [BEFORE, AFTER, THIRD]) {
        expect(
          decideExternalAction(action(state), observed, "forward"),
          state,
        ).toBe("conflict");
      }
    }
  });

  it("inverse direction", () => {
    // Never applied: only the before image is on the object.
    expect(decideExternalAction(action("planned"), BEFORE, "inverse")).toBe(
      "record-abandoned",
    );
    // Applied but the receipt never landed.
    expect(decideExternalAction(action("planned"), AFTER, "inverse")).toBe(
      "invert",
    );
    expect(decideExternalAction(action("planned"), THIRD, "inverse")).toBe(
      "conflict",
    );
    expect(decideExternalAction(action("applied"), AFTER, "inverse")).toBe(
      "invert",
    );
    // Inverse applied but the receipt never landed.
    expect(decideExternalAction(action("applied"), BEFORE, "inverse")).toBe(
      "record-inverted",
    );
    expect(decideExternalAction(action("applied"), THIRD, "inverse")).toBe(
      "conflict",
    );
    for (const state of ["abandoned", "inverted"] as const) {
      expect(
        decideExternalAction(action(state), BEFORE, "inverse"),
        state,
      ).toBe("none");
      expect(decideExternalAction(action(state), AFTER, "inverse"), state).toBe(
        "conflict",
      );
      expect(decideExternalAction(action(state), THIRD, "inverse"), state).toBe(
        "conflict",
      );
    }
  });

  it("treats absent fingerprints as images like any other", () => {
    const created = { before: ABSENT, after: AFTER, state: "planned" } as const;
    expect(decideExternalAction(created, ABSENT, "forward")).toBe("apply");
    expect(decideExternalAction(created, AFTER, "forward")).toBe(
      "record-applied",
    );
    const removed = {
      before: BEFORE,
      after: ABSENT,
      state: "applied",
    } as const;
    expect(decideExternalAction(removed, ABSENT, "forward")).toBe("none");
    expect(decideExternalAction(removed, BEFORE, "inverse")).toBe(
      "record-inverted",
    );
    expect(decideExternalAction(removed, THIRD, "inverse")).toBe("conflict");
  });

  it("orders inverses last-in-first-out without mutating the ledger", () => {
    const make = (id: string): ExternalAction => ({
      id,
      kind: "shortcut",
      object: id,
      before: BEFORE,
      after: AFTER,
      forward: null,
      inverse: null,
      state: "applied",
    });
    const ledger = [make("a"), make("b"), make("c")];
    expect(actionsInInverseOrder(ledger).map((a) => a.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(ledger.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });
});

describe("session impact", () => {
  function session(overrides: Partial<SessionImpact>): SessionImpact {
    return {
      sessionId: "s1",
      surface: "gui",
      provider: "claude",
      providerVersion: "1.0.0",
      profileRef: "profile-a",
      oldPrimaryDirectory: "/old",
      newPrimaryDirectory: "/new",
      providerStoreMoved: true,
      route: { primary: "native-resume", onFailure: "hold" },
      blocker: false,
      reason: "",
      ...overrides,
    };
  }

  function report(sessions: SessionImpact[]): SessionImpactReport {
    return {
      version: 1,
      sourceRoot: "/src",
      destinationRoot: "/dst",
      sessions,
    };
  }

  it("is order-independent and ignores fields the user does not acknowledge", () => {
    const a = session({ sessionId: "a" });
    const b = session({ sessionId: "b", surface: "tui", provider: "codex" });
    const c = session({ sessionId: "c" });
    const reference = sessionImpactDigest(report([a, b, c]));
    expect(sessionImpactDigest(report([c, a, b]))).toBe(reference);
    expect(sessionImpactDigest(report([b, c, a]))).toBe(reference);
    expect(
      sessionImpactDigest(
        report([
          { ...a, reason: "different prose", newPrimaryDirectory: "/x" },
          b,
          c,
        ]),
      ),
    ).toBe(reference);
  });

  it("changes when route, version, profile, provider, surface or the root mapping changes", () => {
    const base = session({});
    const reference = sessionImpactDigest(report([base]));
    const variants: SessionImpact[] = [
      session({ route: { primary: "fresh-context", onFailure: "hold" } }),
      session({
        route: { primary: "native-resume", onFailure: "fresh-context" },
      }),
      session({ providerVersion: "2.0.0" }),
      session({ providerVersion: null }),
      session({ profileRef: "profile-b" }),
      session({ provider: "codex" }),
      session({ surface: "tui" }),
      session({ sessionId: "other" }),
    ];
    const seen = new Set<string>([reference]);
    for (const variant of variants) {
      const digest = sessionImpactDigest(report([variant]));
      expect(seen.has(digest), canonicalJson(variant)).toBe(false);
      seen.add(digest);
    }
    expect(
      sessionImpactDigest({ ...report([base]), destinationRoot: "/other" }),
    ).not.toBe(reference);
    expect(
      sessionImpactDigest({ ...report([base]), sourceRoot: "/other" }),
    ).not.toBe(reference);
    expect(
      sessionImpactDigest(report([base, session({ sessionId: "extra" })])),
    ).not.toBe(reference);
  });

  it("requires acceptance for fresh-context and unknown routes only", () => {
    expect(
      sessionImpactRequiresAcceptance(
        report([
          session({ route: { primary: "fresh-context", onFailure: "hold" } }),
        ]),
      ),
    ).toBe(true);
    expect(
      sessionImpactRequiresAcceptance(
        report([
          session({
            route: { primary: "native-resume", onFailure: "fresh-context" },
          }),
        ]),
      ),
    ).toBe(true);
    expect(
      sessionImpactRequiresAcceptance(
        report([session({ route: { primary: "unknown", onFailure: "hold" } })]),
      ),
    ).toBe(true);
    expect(
      sessionImpactRequiresAcceptance(
        report([
          session({ route: { primary: "native-resume", onFailure: "hold" } }),
        ]),
      ),
    ).toBe(false);
    expect(
      sessionImpactRequiresAcceptance(
        report([
          session({ route: { primary: "native-relocate", onFailure: "hold" } }),
        ]),
      ),
    ).toBe(false);
    expect(sessionImpactRequiresAcceptance(report([]))).toBe(false);
  });

  it("lists blockers", () => {
    const ok = session({ sessionId: "ok" });
    const bad = session({ sessionId: "bad", blocker: true });
    expect(
      sessionImpactBlockers(report([ok, bad])).map((s) => s.sessionId),
    ).toEqual(["bad"]);
    expect(sessionImpactBlockers(report([ok]))).toEqual([]);
  });
});

describe("incompatibleHandshakes", () => {
  it("accepts the current protocol and flags older and newer ones", () => {
    const current = currentComponentHandshake("host", "1.0.0");
    expect(current.dataMigrationProtocol).toBe(DATA_MIGRATION_PROTOCOL_VERSION);
    const older = {
      component: "desktop",
      build: "0.9.0",
      dataMigrationProtocol: DATA_MIGRATION_PROTOCOL_VERSION - 1,
    } as const;
    const newer = {
      component: "cli",
      build: "9.0.0",
      dataMigrationProtocol: DATA_MIGRATION_PROTOCOL_VERSION + 1,
    } as const;
    expect(incompatibleHandshakes([current])).toEqual([]);
    expect(incompatibleHandshakes([current, older, newer])).toEqual([
      { component: "desktop", build: "0.9.0", reason: "protocol-too-old" },
      { component: "cli", build: "9.0.0", reason: "protocol-too-new" },
    ]);
    expect(incompatibleHandshakes([])).toEqual([]);
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  it("is independent of insertion order and drops undefined members", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("keeps array order and encodes scalars", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("x")).toBe('"x"');
  });

  it("produces stable sha256 digests", () => {
    expect(sha256Digest({ a: 1, b: 2 })).toBe(sha256Digest({ b: 2, a: 1 }));
    expect(sha256Digest({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(sha256Digest({ a: 1 })).not.toBe(sha256Digest({ a: 2 }));
  });
});
