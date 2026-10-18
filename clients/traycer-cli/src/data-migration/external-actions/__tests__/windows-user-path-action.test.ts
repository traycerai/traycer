import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalAction } from "@traycer/protocol/config/data-migration-contracts";
import { serviceLabelFor } from "../../../service/label";
import { isExternalActionConflictError } from "../ledger";
import { reconcileExternalAction } from "../reconcile";
import {
  applyWindowsUserPath,
  planWindowsUserPathRelocation,
  setWindowsUserPathDepsForTests,
  type UserPathValue,
} from "../windows-user-path-action";

const roots = vi.hoisted(() => ({
  source: "C:\\Users\\Zoë Q\\.traycer",
  destination: "D:\\Träycer Data",
}));

vi.mock("@traycer/protocol/config/data-root", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@traycer/protocol/config/data-root")>();
  return { ...actual, traycerDataRoot: () => roots.source };
});

const SOURCE = roots.source;
const DESTINATION = roots.destination;
const SOURCE_BIN = `${SOURCE}\\cli\\bin`;
const DESTINATION_BIN = `${DESTINATION}\\cli\\bin`;
const label = serviceLabelFor("production");

let registry: UserPathValue;
let casCalls = 0;

beforeEach(() => {
  casCalls = 0;
  registry = { kind: "absent" };
  setWindowsUserPathDepsForTests({
    read: () => Promise.resolve(registry),
    compareAndSet: (expected, next) => {
      casCalls += 1;
      if (
        registry.kind !== "value" ||
        registry.valueKind !== expected.valueKind ||
        registry.value !== expected.value
      ) {
        return Promise.resolve(false);
      }
      registry = next;
      return Promise.resolve(true);
    },
    env: { USERPROFILE: "C:\\Users\\Zoë Q", SystemRoot: "C:\\Windows" },
  });
});

afterEach(() => {
  setWindowsUserPathDepsForTests(null);
});

function plan() {
  return planWindowsUserPathRelocation({
    labels: [label],
    roots: { sourceRoot: SOURCE, destinationRoot: DESTINATION },
  });
}

function set(value: string, valueKind: "String" | "ExpandString"): void {
  registry = { kind: "value", valueKind, value };
}

describe("planWindowsUserPathRelocation", () => {
  it("replaces the exact %USERPROFILE% CLI bin segment in place, keeping everything else", async () => {
    set(
      `C:\\Tools;;%USERPROFILE%\\.traycer\\cli\\bin;%SystemRoot%\\System32;`,
      "ExpandString",
    );
    const result = await plan();
    expect(result.blockers).toEqual([]);
    expect(result.actions).toHaveLength(1);
    const action = result.actions[0] as ExternalAction;
    expect(action.kind).toBe("path-entry");
    expect(action.object).toBe("HKCU\\Environment\\Path");
    expect(action.forward).toMatchObject({
      stage: "prepare",
      valueKind: "ExpandString",
      value: `C:\\Tools;;${DESTINATION_BIN};%SystemRoot%\\System32;`,
    });
    expect(action.inverse).toMatchObject({
      valueKind: "ExpandString",
      value: `C:\\Tools;;%USERPROFILE%\\.traycer\\cli\\bin;%SystemRoot%\\System32;`,
    });
  });

  it("matches a literal, differently-cased, forward-slash spelling and keeps REG_SZ", async () => {
    set(`c:/users/zoë q/.TRAYCER/cli/bin;E:\\x`, "String");
    const result = await plan();
    expect(result.actions[0]?.forward).toMatchObject({
      valueKind: "String",
      value: `${DESTINATION_BIN};E:\\x`,
    });
  });

  it("keeps the quotes around a quoted segment", async () => {
    set(`"${SOURCE_BIN}";C:\\Other`, "ExpandString");
    const result = await plan();
    expect(result.actions[0]?.forward).toMatchObject({
      value: `"${DESTINATION_BIN}";C:\\Other`,
    });
  });

  it("refuses another entry under the source root and plans no action", async () => {
    set(`${SOURCE_BIN};%USERPROFILE%\\.traycer\\tools`, "ExpandString");
    const result = await plan();
    expect(result.actions).toEqual([]);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]?.code).toBe("unowned-path-reference");
    expect(result.blockers[0]?.object).toContain("tools");
  });

  it("refuses an unowned reference even when there is nothing of ours to replace", async () => {
    set(`C:\\Windows;${SOURCE}\\tools`, "ExpandString");
    const result = await plan();
    expect(result.actions).toEqual([]);
    expect(result.blockers[0]?.code).toBe("unowned-path-reference");
  });

  it("plans nothing when no segment matches, or the value is absent", async () => {
    set(
      `C:\\Windows;C:\\Users\\Zoë Q\\.traycer2\\cli\\bin;%UNKNOWN%\\x`,
      "ExpandString",
    );
    expect(await plan()).toEqual({ actions: [], blockers: [] });
    registry = { kind: "absent" };
    expect(await plan()).toEqual({ actions: [], blockers: [] });
  });
});

describe("applying the PATH action", () => {
  const original = `C:\\Tools;;%USERPROFILE%\\.traycer\\cli\\bin;`;

  it("applies and inverts through the reconciler, restoring the exact raw value and kind", async () => {
    set(original, "ExpandString");
    const action = (await plan()).actions[0] as ExternalAction;
    const applied = await reconcileExternalAction(action, "forward", [action]);
    expect(applied.kind).toBe("settled");
    if (applied.kind !== "settled") return;
    expect(applied.action.state).toBe("applied");
    expect(registry).toEqual({
      kind: "value",
      valueKind: "ExpandString",
      value: `C:\\Tools;;${DESTINATION_BIN};`,
    });

    const back = await reconcileExternalAction(applied.action, "inverse", [
      applied.action,
    ]);
    expect(back.kind).toBe("settled");
    expect(registry).toEqual({
      kind: "value",
      valueKind: "ExpandString",
      value: original,
    });
  });

  it("records applied without a write when the registry already shows the after image", async () => {
    set(original, "ExpandString");
    const action = (await plan()).actions[0] as ExternalAction;
    await applyWindowsUserPath(action);
    casCalls = 0;
    const outcome = await reconcileExternalAction(action, "forward", [action]);
    expect(outcome.kind).toBe("settled");
    if (outcome.kind === "settled")
      expect(outcome.decision).toBe("record-applied");
    expect(casCalls).toBe(0);
  });

  it("conflicts, writing nothing, when the PATH changed after planning", async () => {
    set(original, "ExpandString");
    const action = (await plan()).actions[0] as ExternalAction;
    set(`${original}C:\\Added`, "ExpandString");
    const outcome = await reconcileExternalAction(action, "forward", [action]);
    expect(outcome.kind).toBe("conflict");
    expect(casCalls).toBe(0);
    expect(registry).toMatchObject({ value: `${original}C:\\Added` });
  });

  it("the compare-and-set itself refuses a value that changed between the read and the write", async () => {
    set(original, "ExpandString");
    const action = (await plan()).actions[0] as ExternalAction;
    set(`${original}C:\\Added`, "ExpandString");
    const failure = await applyWindowsUserPath(action).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(isExternalActionConflictError(failure)).toBe(true);
    expect(registry).toMatchObject({ value: `${original}C:\\Added` });
  });

  it("treats a changed registry value kind as a change", async () => {
    set(original, "ExpandString");
    const action = (await plan()).actions[0] as ExternalAction;
    set(original, "String");
    const outcome = await reconcileExternalAction(action, "forward", [action]);
    expect(outcome.kind).toBe("conflict");
  });
});
