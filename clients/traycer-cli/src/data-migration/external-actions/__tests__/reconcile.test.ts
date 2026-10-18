import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  actionsInInverseOrder,
  type ExternalAction,
} from "@traycer/protocol/config/data-migration-contracts";
import { planFileImageAction } from "../file-image-action";
import { readFileImage } from "../ledger";
import {
  checkExternalActionChains,
  externalActionStage,
  reconcileExternalAction,
  verifySettledExternalActions,
  type ExternalActionOutcome,
} from "../reconcile";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "traycer-reconcile-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BEFORE = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x0d, 0x0a]);
const AFTER = Buffer.from("after image ü\n", "utf8");

function plan(
  path: string,
  before: Buffer | null,
  after: Buffer | null,
): ExternalAction {
  return planFileImageAction({
    kind: "service-registration",
    stage: "prepare",
    path,
    before,
    after,
  });
}

/** Reconcile one action against a ledger holding just that action. */
function reconcileAlone(
  action: ExternalAction,
  direction: "forward" | "inverse",
): Promise<ExternalActionOutcome> {
  return reconcileExternalAction(action, direction, [action]);
}

function settledAction(outcome: ExternalActionOutcome): ExternalAction {
  if (outcome.kind !== "settled") {
    throw new Error(`expected settled, got conflict: ${outcome.reason}`);
  }
  return outcome.action;
}

describe("reconcileExternalAction (file-image adapter, forward)", () => {
  it("applies a planned action whose object still shows the before image", async () => {
    const path = join(dir, "launcher.vbs");
    await writeFile(path, BEFORE);
    const outcome = await reconcileAlone(plan(path, BEFORE, AFTER), "forward");
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.decision).toBe("apply");
    expect(outcome.action.state).toBe("applied");
    expect((await readFile(path)).equals(AFTER)).toBe(true);
  });

  it("applies an absent -> present action", async () => {
    const path = join(dir, "new.vbs");
    const outcome = await reconcileAlone(plan(path, null, AFTER), "forward");
    expect(settledAction(outcome).state).toBe("applied");
    expect((await readFile(path)).equals(AFTER)).toBe(true);
  });

  it("records applied without writing when the after image is already there (crash before the receipt)", async () => {
    const path = join(dir, "launcher.vbs");
    await writeFile(path, AFTER);
    const outcome = await reconcileAlone(plan(path, BEFORE, AFTER), "forward");
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.decision).toBe("record-applied");
    expect(outcome.action.state).toBe("applied");
    expect((await readFile(path)).equals(AFTER)).toBe(true);
  });

  it("is a no-op for an already-applied action", async () => {
    const path = join(dir, "launcher.vbs");
    await writeFile(path, AFTER);
    const applied: ExternalAction = {
      ...plan(path, BEFORE, AFTER),
      state: "applied",
    };
    const outcome = await reconcileAlone(applied, "forward");
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.decision).toBe("none");
    expect(outcome.action.state).toBe("applied");
  });

  it("returns a conflict and leaves the file untouched when it matches neither image", async () => {
    const path = join(dir, "launcher.vbs");
    const foreign = Buffer.from("someone else wrote this");
    await writeFile(path, foreign);
    const outcome = await reconcileAlone(plan(path, BEFORE, AFTER), "forward");
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind === "conflict") expect(outcome.object).toBe(path);
    expect((await readFile(path)).equals(foreign)).toBe(true);
  });
});

describe("reconcileExternalAction (inverse)", () => {
  it("inverts an applied action back to the exact before bytes", async () => {
    const path = join(dir, "launcher.vbs");
    await writeFile(path, BEFORE);
    const applied = settledAction(
      await reconcileAlone(plan(path, BEFORE, AFTER), "forward"),
    );
    const outcome = await reconcileAlone(applied, "inverse");
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.decision).toBe("invert");
    expect(outcome.action.state).toBe("inverted");
    expect((await readFile(path)).equals(BEFORE)).toBe(true);
  });

  it("removes a file whose before image was absent", async () => {
    const path = join(dir, "new.vbs");
    const applied = settledAction(
      await reconcileAlone(plan(path, null, AFTER), "forward"),
    );
    const outcome = await reconcileAlone(applied, "inverse");
    expect(settledAction(outcome).state).toBe("inverted");
    expect(await readFileImage(path)).toBeNull();
  });

  it("abandons a planned action whose object still shows the before image", async () => {
    const path = join(dir, "launcher.vbs");
    await writeFile(path, BEFORE);
    const outcome = await reconcileAlone(plan(path, BEFORE, AFTER), "inverse");
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.decision).toBe("record-abandoned");
    expect(outcome.action.state).toBe("abandoned");
    expect((await readFile(path)).equals(BEFORE)).toBe(true);
  });

  it("inverts a planned action found at the after image (crash after the effect)", async () => {
    const path = join(dir, "launcher.vbs");
    await writeFile(path, AFTER);
    const outcome = await reconcileAlone(plan(path, BEFORE, AFTER), "inverse");
    expect(settledAction(outcome).state).toBe("inverted");
    expect((await readFile(path)).equals(BEFORE)).toBe(true);
  });

  it("records inverted without writing when an applied action already shows the before image", async () => {
    const path = join(dir, "launcher.vbs");
    await writeFile(path, BEFORE);
    const applied: ExternalAction = {
      ...plan(path, BEFORE, AFTER),
      state: "applied",
    };
    const outcome = await reconcileAlone(applied, "inverse");
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.decision).toBe("record-inverted");
    expect(outcome.action.state).toBe("inverted");
  });

  it("conflicts, leaving the file alone, when a third party changed an applied object", async () => {
    const path = join(dir, "launcher.vbs");
    await writeFile(path, BEFORE);
    const applied = settledAction(
      await reconcileAlone(plan(path, BEFORE, AFTER), "forward"),
    );
    const foreign = Buffer.from("third party");
    await writeFile(path, foreign);
    const outcome = await reconcileAlone(applied, "inverse");
    expect(outcome.kind).toBe("conflict");
    expect((await readFile(path)).equals(foreign)).toBe(true);
  });

  it("never re-applies a rolled-back action forward", async () => {
    const path = join(dir, "launcher.vbs");
    await writeFile(path, BEFORE);
    const inverted: ExternalAction = {
      ...plan(path, BEFORE, AFTER),
      state: "inverted",
    };
    const outcome = await reconcileAlone(inverted, "forward");
    expect(outcome.kind).toBe("conflict");
    expect((await readFile(path)).equals(BEFORE)).toBe(true);
  });
});

describe("ordering and stage", () => {
  it("reads the coordinator stage from the forward envelope", () => {
    expect(externalActionStage(plan(join(dir, "x"), null, AFTER))).toBe(
      "prepare",
    );
  });

  it("refuses an action that names no known adapter", async () => {
    const bogus: ExternalAction = {
      ...plan(join(dir, "x"), null, AFTER),
      forward: { adapter: "nope", version: 1, stage: "prepare" },
    };
    await expect(reconcileAlone(bogus, "forward")).rejects.toThrow(
      /no known adapter/u,
    );
  });
});

describe("single-action verification", () => {
  it("reports nothing for settled actions that still show their image", async () => {
    const applied = join(dir, "applied");
    const rolledBack = join(dir, "rolled-back");
    await writeFile(applied, BEFORE);
    await writeFile(rolledBack, BEFORE);
    const a = settledAction(
      await reconcileAlone(plan(applied, BEFORE, AFTER), "forward"),
    );
    const b = settledAction(
      await reconcileAlone(plan(rolledBack, BEFORE, AFTER), "inverse"),
    );
    expect(b.state).toBe("abandoned");
    expect(await verifySettledExternalActions([a, b])).toEqual([]);
  });

  it("reports a drifted applied action", async () => {
    const path = join(dir, "launcher.vbs");
    await writeFile(path, BEFORE);
    const applied = settledAction(
      await reconcileAlone(plan(path, BEFORE, AFTER), "forward"),
    );
    await writeFile(path, "drifted");
    const mismatches = await verifySettledExternalActions([applied]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ id: applied.id, object: path });
  });

  it("treats a lone planned action as pending, not a mismatch", async () => {
    const path = join(dir, "launcher.vbs");
    await writeFile(path, BEFORE);
    expect(
      await verifySettledExternalActions([plan(path, BEFORE, AFTER)]),
    ).toEqual([]);
  });
});

describe("same-object chains (A -> B -> C -> D on one file)", () => {
  const A = Buffer.from("image A");
  const B = Buffer.from("image B");
  const C = Buffer.from("image C");
  const D = Buffer.from("image D");

  // Distinct stages give the three actions distinct ledger ids.
  function chain(
    path: string,
  ): [ExternalAction, ExternalAction, ExternalAction] {
    const step = (
      stage: "quiesce" | "prepare" | "activate",
      before: Buffer,
      after: Buffer,
    ): ExternalAction =>
      planFileImageAction({
        kind: "service-registration",
        stage,
        path,
        before,
        after,
      });
    return [
      step("quiesce", A, B),
      step("prepare", B, C),
      step("activate", C, D),
    ];
  }

  function withStates(
    actions: readonly ExternalAction[],
    states: readonly ExternalAction["state"][],
  ): ExternalAction[] {
    return actions.map((action, index) => ({
      ...action,
      state: states[index] ?? action.state,
    }));
  }

  async function bytes(path: string): Promise<string> {
    return (await readFile(path)).toString("utf8");
  }

  it("goes forward in order, carrying the ledger along", async () => {
    const path = join(dir, "obj");
    await writeFile(path, A);
    let ledger: ExternalAction[] = chain(path);
    for (const [index, expected] of [B, C, D].entries()) {
      const outcome = await reconcileExternalAction(
        ledger[index] as ExternalAction,
        "forward",
        ledger,
      );
      const next = settledAction(outcome);
      expect(next.state).toBe("applied");
      ledger = ledger.map((entry) => (entry.id === next.id ? next : entry));
      expect(await bytes(path)).toBe(expected.toString("utf8"));
    }
    expect(await verifySettledExternalActions(ledger)).toEqual([]);
  });

  it("refuses to go forward before the earlier same-object actions are applied", async () => {
    const path = join(dir, "obj");
    await writeFile(path, A);
    const ledger = chain(path);
    await expect(
      reconcileExternalAction(ledger[1] as ExternalAction, "forward", ledger),
    ).rejects.toThrow(/before the earlier actions/u);
    expect(await bytes(path)).toBe("image A");
  });

  it("re-forwarding the first applied action while later ones are applied changes nothing", async () => {
    const path = join(dir, "obj");
    await writeFile(path, C);
    const ledger = withStates(chain(path), ["applied", "applied", "planned"]);
    const outcome = await reconcileExternalAction(
      ledger[0] as ExternalAction,
      "forward",
      ledger,
    );
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.decision).toBe("none");
    expect(outcome.action.state).toBe("applied");
    expect(await bytes(path)).toBe("image C");
  });

  it("recovers the crash window: the second effect is on disk, its receipt still planned", async () => {
    const path = join(dir, "obj");
    await writeFile(path, C);
    const ledger = withStates(chain(path), ["applied", "planned", "planned"]);
    const first = await reconcileExternalAction(
      ledger[0] as ExternalAction,
      "forward",
      ledger,
    );
    expect(first.kind).toBe("settled");
    if (first.kind === "settled") expect(first.decision).toBe("none");
    const second = await reconcileExternalAction(
      ledger[1] as ExternalAction,
      "forward",
      ledger,
    );
    expect(second.kind).toBe("settled");
    if (second.kind !== "settled") return;
    expect(second.decision).toBe("record-applied");
    expect(second.action.state).toBe("applied");
    expect(await bytes(path)).toBe("image C");
  });

  it("conflicts when an applied superseded action finds the object matching neither image", async () => {
    const path = join(dir, "obj");
    await writeFile(path, "third party");
    const ledger = withStates(chain(path), ["applied", "applied", "planned"]);
    const outcome = await reconcileExternalAction(
      ledger[0] as ExternalAction,
      "forward",
      ledger,
    );
    expect(outcome.kind).toBe("conflict");
    expect(await bytes(path)).toBe("third party");
  });

  it("conflicts a planned action when a later same-object action already settled", async () => {
    const path = join(dir, "obj");
    await writeFile(path, A);
    const ledger = withStates(chain(path), ["planned", "applied", "planned"]);
    const outcome = await reconcileExternalAction(
      ledger[0] as ExternalAction,
      "forward",
      ledger,
    );
    expect(outcome.kind).toBe("conflict");
    expect(await bytes(path)).toBe("image A");
  });

  it("verifies the terminal image: B and C applied, D planned, object at C", async () => {
    const path = join(dir, "obj");
    await writeFile(path, C);
    const ledger = withStates(chain(path), ["applied", "applied", "planned"]);
    expect(await verifySettledExternalActions(ledger)).toEqual([]);
  });

  it("reports a drifted object against the last applied action", async () => {
    const path = join(dir, "obj");
    await writeFile(path, B);
    const ledger = withStates(chain(path), ["applied", "applied", "planned"]);
    const mismatches = await verifySettledExternalActions(ledger);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ id: ledger[1]?.id, object: path });
  });

  it("flags broken continuity and an applied action after an unapplied one", () => {
    const path = join(dir, "obj");
    const [first, second, third] = chain(path) as [
      ExternalAction,
      ExternalAction,
      ExternalAction,
    ];
    expect(checkExternalActionChains([first, second, third])).toEqual([]);
    const broken = planFileImageAction({
      kind: "service-registration",
      stage: "prepare",
      path,
      before: Buffer.from("not B"),
      after: C,
    });
    const continuity = checkExternalActionChains([first, broken]);
    expect(continuity).toHaveLength(1);
    expect(continuity[0]).toMatchObject({ id: broken.id, object: path });
    const order = checkExternalActionChains([
      first,
      { ...second, state: "applied" },
    ]);
    expect(order).toHaveLength(1);
    expect(order[0]?.id).toBe(second.id);
  });

  it("surfaces broken continuity through verifySettledExternalActions", async () => {
    const path = join(dir, "obj");
    await writeFile(path, A);
    const [first] = chain(path) as [
      ExternalAction,
      ExternalAction,
      ExternalAction,
    ];
    const broken = planFileImageAction({
      kind: "service-registration",
      stage: "prepare",
      path,
      before: Buffer.from("not B"),
      after: C,
    });
    const mismatches = await verifySettledExternalActions([first, broken]);
    expect(mismatches.map((entry) => entry.id)).toContain(broken.id);
  });

  it("refuses an inverse out of order and writes nothing", async () => {
    const path = join(dir, "obj");
    await writeFile(path, D);
    const ledger = withStates(chain(path), ["applied", "applied", "applied"]);
    await expect(
      reconcileExternalAction(ledger[0] as ExternalAction, "inverse", ledger),
    ).rejects.toThrow(/before the later actions/u);
    expect(await bytes(path)).toBe("image D");
  });

  it("rolls the whole chain back in reverse order to the exact first bytes", async () => {
    const path = join(dir, "obj");
    await writeFile(path, D);
    let ledger = withStates(chain(path), ["applied", "applied", "applied"]);
    for (const action of actionsInInverseOrder(ledger)) {
      const current = ledger.find(
        (entry) => entry.id === action.id,
      ) as ExternalAction;
      const outcome = await reconcileExternalAction(current, "inverse", ledger);
      const next = settledAction(outcome);
      expect(next.state).toBe("inverted");
      ledger = ledger.map((entry) => (entry.id === next.id ? next : entry));
    }
    expect((await readFile(path)).equals(A)).toBe(true);
    // Rolled back: the object is expected to show the FIRST action's before image.
    expect(await verifySettledExternalActions(ledger)).toEqual([]);
    await writeFile(path, B);
    expect(await verifySettledExternalActions(ledger)).toHaveLength(1);
  });

  describe("inverse of a partially applied chain", () => {
    function settle(
      ledger: readonly ExternalAction[],
      next: ExternalAction,
    ): ExternalAction[] {
      return ledger.map((entry) => (entry.id === next.id ? next : entry));
    }

    async function reverse(
      start: readonly ExternalAction[],
    ): Promise<{ ledger: ExternalAction[]; decisions: string[] }> {
      let ledger = [...start];
      const decisions: string[] = [];
      for (const action of actionsInInverseOrder(start)) {
        const current = ledger.find(
          (entry) => entry.id === action.id,
        ) as ExternalAction;
        const outcome = await reconcileExternalAction(
          current,
          "inverse",
          ledger,
        );
        if (outcome.kind !== "settled")
          throw new Error(`${action.id}: ${outcome.reason}`);
        decisions.push(outcome.decision);
        ledger = settle(ledger, outcome.action);
      }
      return { ledger, decisions };
    }

    it("abandons the unreached steps and inverts the applied one (only step 1 applied, file at B)", async () => {
      const path = join(dir, "obj");
      await writeFile(path, B);
      const start = withStates(chain(path), ["applied", "planned", "planned"]);
      const { ledger, decisions } = await reverse(start);
      // Step 3 is decided WITHOUT reading the object: the file shows B, which
      // is neither its before (C) nor its after (D), so a read would conflict.
      expect(decisions).toEqual([
        "record-abandoned",
        "record-abandoned",
        "invert",
      ]);
      expect(ledger.map((entry) => entry.state)).toEqual([
        "inverted",
        "abandoned",
        "abandoned",
      ]);
      expect((await readFile(path)).equals(A)).toBe(true);
      expect(await verifySettledExternalActions(ledger)).toEqual([]);
    });

    it("inverts the crash-frontier action (step 2 effect on disk, receipt still planned)", async () => {
      const path = join(dir, "obj");
      await writeFile(path, C);
      const start = withStates(chain(path), ["applied", "planned", "planned"]);
      const { ledger, decisions } = await reverse(start);
      expect(decisions).toEqual(["record-abandoned", "invert", "invert"]);
      expect(ledger.map((entry) => entry.state)).toEqual([
        "inverted",
        "inverted",
        "abandoned",
      ]);
      expect((await readFile(path)).equals(A)).toBe(true);
    });

    it("conflicts on the frontier action, leaving a third party's content untouched", async () => {
      const path = join(dir, "obj");
      await writeFile(path, "third party");
      const start = withStates(chain(path), ["applied", "planned", "planned"]);
      const third = await reconcileExternalAction(
        start[2] as ExternalAction,
        "inverse",
        start,
      );
      expect(third.kind).toBe("settled");
      if (third.kind === "settled")
        expect(third.decision).toBe("record-abandoned");
      const frontier = await reconcileExternalAction(
        start[1] as ExternalAction,
        "inverse",
        settle(start, (third as { action: ExternalAction }).action),
      );
      expect(frontier.kind).toBe("conflict");
      expect(await bytes(path)).toBe("third party");
    });

    it.each([0, 1, 2])(
      "forward re-run after a crash following step %i's effect records only that step applied",
      async (crashed) => {
        const path = join(dir, "obj");
        const images = [A, B, C, D];
        await writeFile(path, images[crashed + 1] as Buffer);
        let ledger = withStates(
          chain(path),
          [0, 1, 2].map((index) => (index < crashed ? "applied" : "planned")),
        );
        const recovered = await reconcileExternalAction(
          ledger[crashed] as ExternalAction,
          "forward",
          ledger,
        );
        expect(recovered.kind).toBe("settled");
        if (recovered.kind !== "settled") return;
        expect(recovered.decision).toBe("record-applied");
        ledger = settle(ledger, recovered.action);
        expect(await bytes(path)).toBe(
          (images[crashed + 1] as Buffer).toString("utf8"),
        );
        for (let index = crashed + 1; index < 3; index += 1) {
          const outcome = await reconcileExternalAction(
            ledger[index] as ExternalAction,
            "forward",
            ledger,
          );
          expect(outcome.kind).toBe("settled");
          if (outcome.kind !== "settled") return;
          expect(outcome.decision).toBe("apply");
          ledger = settle(ledger, outcome.action);
        }
        expect(await bytes(path)).toBe("image D");
        expect(ledger.map((entry) => entry.state)).toEqual([
          "applied",
          "applied",
          "applied",
        ]);
        expect(await verifySettledExternalActions(ledger)).toEqual([]);
      },
    );

    describe("replaying a rollback after a restart", () => {
      const images = [A, B, C, D];

      async function expectFileAt(path: string, image: Buffer): Promise<void> {
        expect((await readFile(path)).equals(image)).toBe(true);
      }

      it.each([1, 2, 3])(
        "replays cleanly after %i abandonment/inversion step(s) of a partial rollback",
        async (done) => {
          const path = join(dir, "obj");
          await writeFile(path, B);
          let ledger = withStates(chain(path), [
            "applied",
            "planned",
            "planned",
          ]);
          // The first run stops after `done` steps (the process restarts).
          for (const action of actionsInInverseOrder(ledger).slice(0, done)) {
            const current = ledger.find(
              (entry) => entry.id === action.id,
            ) as ExternalAction;
            const outcome = await reconcileExternalAction(
              current,
              "inverse",
              ledger,
            );
            if (outcome.kind !== "settled") throw new Error(outcome.reason);
            ledger = settle(ledger, outcome.action);
          }
          const replay = await reverse(ledger);
          expect(replay.ledger.map((entry) => entry.state)).toEqual([
            "inverted",
            "abandoned",
            "abandoned",
          ]);
          await expectFileAt(path, A);
          // Already-undone steps replay as `none`.
          const undoneBefore = ledger.filter(
            (entry) => entry.state !== "applied" && entry.state !== "planned",
          ).length;
          expect(
            replay.decisions.filter((decision) => decision === "none"),
          ).toHaveLength(undoneBefore);
          const again = await reverse(replay.ledger);
          expect(again.decisions).toEqual(["none", "none", "none"]);
          await expectFileAt(path, A);
        },
      );

      it.each([2, 1, 0])(
        "recovers a crash after step %i's inverse effect, before its receipt",
        async (crashed) => {
          const path = join(dir, "obj");
          await writeFile(path, images[crashed] as Buffer);
          // Steps after `crashed` are fully inverted; `crashed` itself is still
          // `applied` (receipt missing) although its inverse is on disk.
          const ledger = withStates(
            chain(path),
            [0, 1, 2].map((index) =>
              index > crashed ? "inverted" : "applied",
            ),
          );
          const replay = await reverse(ledger);
          const expected = [...Array(3).keys()]
            .reverse()
            .map((index) =>
              index > crashed
                ? "none"
                : index === crashed
                  ? "record-inverted"
                  : "invert",
            );
          expect(replay.decisions).toEqual(expected);
          expect(replay.ledger.map((entry) => entry.state)).toEqual([
            "inverted",
            "inverted",
            "inverted",
          ]);
          await expectFileAt(path, A);
        },
      );

      it.each([2, 1, 0])(
        "replays as `none` for the steps whose inverse receipt is durable (steps %i.. inverted)",
        async (firstInverted) => {
          const path = join(dir, "obj");
          await writeFile(path, images[firstInverted] as Buffer);
          const ledger = withStates(
            chain(path),
            [0, 1, 2].map((index) =>
              index >= firstInverted ? "inverted" : "applied",
            ),
          );
          const replay = await reverse(ledger);
          const expected = [2, 1, 0].map((index) =>
            index >= firstInverted ? "none" : "invert",
          );
          expect(replay.decisions).toEqual(expected);
          expect(replay.ledger.map((entry) => entry.state)).toEqual([
            "inverted",
            "inverted",
            "inverted",
          ]);
          await expectFileAt(path, A);
        },
      );

      it("accepts the next planned action's after image for an abandoned step (step 2's effect landed without a receipt)", async () => {
        const path = join(dir, "obj");
        await writeFile(path, C);
        let ledger = withStates(chain(path), ["applied", "planned", "planned"]);
        // First run: step 3 is abandoned unread, then the process restarts.
        const first = await reconcileExternalAction(
          ledger[2] as ExternalAction,
          "inverse",
          ledger,
        );
        expect(first.kind).toBe("settled");
        if (first.kind !== "settled") return;
        expect(first.decision).toBe("record-abandoned");
        ledger = settle(ledger, first.action);

        const replay = await reverse(ledger);
        expect(replay.decisions).toEqual(["none", "invert", "invert"]);
        expect(replay.ledger.map((entry) => entry.state)).toEqual([
          "inverted",
          "inverted",
          "abandoned",
        ]);
        await expectFileAt(path, A);
        const again = await reverse(replay.ledger);
        expect(again.decisions).toEqual(["none", "none", "none"]);
        await expectFileAt(path, A);
      });

      it.each([1, 2])(
        "replays after %i abandonment(s) when the first step's effect landed without a receipt",
        async (abandoned) => {
          const path = join(dir, "obj");
          await writeFile(path, B); // step 1 planned, its effect on disk
          let ledger = withStates(chain(path), [
            "planned",
            "planned",
            "planned",
          ]);
          for (const action of actionsInInverseOrder(ledger).slice(
            0,
            abandoned,
          )) {
            const current = ledger.find(
              (entry) => entry.id === action.id,
            ) as ExternalAction;
            const outcome = await reconcileExternalAction(
              current,
              "inverse",
              ledger,
            );
            if (outcome.kind !== "settled") throw new Error(outcome.reason);
            expect(outcome.decision).toBe("record-abandoned");
            ledger = settle(ledger, outcome.action);
          }
          const replay = await reverse(ledger);
          // The abandoned steps replay as `none` (file at step 1's after image).
          expect(
            replay.decisions.filter((decision) => decision === "none"),
          ).toHaveLength(abandoned);
          expect(replay.ledger.map((entry) => entry.state)).toEqual([
            "inverted",
            "abandoned",
            "abandoned",
          ]);
          await expectFileAt(path, A);
        },
      );

      it("traverses a fully rolled-back chain twice with every action `none` and the bytes unchanged", async () => {
        const path = join(dir, "obj");
        await writeFile(path, A);
        const ledger = withStates(chain(path), [
          "inverted",
          "inverted",
          "inverted",
        ]);
        for (let pass = 0; pass < 2; pass += 1) {
          const replay = await reverse(ledger);
          expect(replay.decisions).toEqual(["none", "none", "none"]);
          await expectFileAt(path, A);
        }
      });

      it("conflicts, leaving third-party bytes untouched, when a replay finds neither the frontier image nor its before", async () => {
        const path = join(dir, "obj");
        await writeFile(path, "third party");
        const ledger = withStates(chain(path), [
          "applied",
          "abandoned",
          "abandoned",
        ]);
        const outcome = await reconcileExternalAction(
          ledger[2] as ExternalAction,
          "inverse",
          ledger,
        );
        expect(outcome.kind).toBe("conflict");
        expect(await bytes(path)).toBe("third party");
        // Fully rolled back, the first before image is the only acceptable one.
        const undone = withStates(chain(path), [
          "inverted",
          "inverted",
          "inverted",
        ]);
        const replay = await reconcileExternalAction(
          undone[2] as ExternalAction,
          "inverse",
          undone,
        );
        expect(replay.kind).toBe("conflict");
        expect(await bytes(path)).toBe("third party");
      });
    });
  });
});
