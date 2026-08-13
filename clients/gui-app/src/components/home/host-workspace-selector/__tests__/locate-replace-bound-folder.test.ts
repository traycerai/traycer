import { describe, expect, it, vi } from "vitest";
import { locateReplaceBoundFolder } from "../locate-replace-bound-folder";

const ABSENT = "/old/absent";
const NEW_A = "/new/a";
const NEW_B = "/new/b";

describe("locateReplaceBoundFolder", () => {
  it("cancelled pick changes nothing", async () => {
    const add = vi.fn(() => Promise.resolve(true));
    const remove = vi.fn(() => Promise.resolve(true));
    const outcome = await locateReplaceBoundFolder({
      absentPath: ABSENT,
      pick: null,
      add,
      remove,
    });
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("empty folders pick preserves the old binding", async () => {
    const add = vi.fn(() => Promise.resolve(true));
    const remove = vi.fn(() => Promise.resolve(true));
    const outcome = await locateReplaceBoundFolder({
      absentPath: ABSENT,
      pick: { folders: [] },
      add,
      remove,
    });
    expect(outcome).toEqual({ kind: "noop-empty" });
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("all-adds-fail preserves the old binding", async () => {
    const add = vi.fn(() => Promise.resolve(false));
    const remove = vi.fn(() => Promise.resolve(true));
    const outcome = await locateReplaceBoundFolder({
      absentPath: ABSENT,
      pick: {
        folders: [{ workspacePath: NEW_A }, { workspacePath: NEW_B }],
      },
      add,
      remove,
    });
    expect(outcome).toEqual({ kind: "noop-all-failed" });
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes the old path only after at least one distinct add succeeds", async () => {
    const order: string[] = [];
    const add = vi.fn((path: string) => {
      order.push(`add:${path}`);
      return Promise.resolve(path === NEW_A);
    });
    const remove = vi.fn((path: string) => {
      order.push(`remove:${path}`);
      return Promise.resolve(true);
    });
    const outcome = await locateReplaceBoundFolder({
      absentPath: ABSENT,
      pick: {
        folders: [{ workspacePath: NEW_A }, { workspacePath: NEW_B }],
      },
      add,
      remove,
    });
    expect(outcome).toEqual({
      kind: "replaced",
      removedPath: ABSENT,
      addedPaths: [NEW_A],
    });
    // Partial multi-pick: one success is enough; remove follows adds.
    expect(order).toEqual([`add:${NEW_A}`, `add:${NEW_B}`, `remove:${ABSENT}`]);
  });

  it("same-path re-pick does not remove the binding entry", async () => {
    const add = vi.fn(() => Promise.resolve(true));
    const remove = vi.fn(() => Promise.resolve(true));
    const outcome = await locateReplaceBoundFolder({
      absentPath: ABSENT,
      pick: { folders: [{ workspacePath: ABSENT }] },
      add,
      remove,
    });
    expect(outcome).toEqual({ kind: "same-path-only" });
    // Distinct list is empty — never call add for same-path-only, never remove.
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("reports a retained entry when the old path could not be removed", async () => {
    // The adds landed, so the binding really did change and must be committed.
    // But answering `replaced` here would tell the caller the absent entry is
    // gone when it is still bound - it keeps blocking owner readiness while the
    // UI reports a finished Locate, and nothing is left to retry against.
    const add = vi.fn(() => Promise.resolve(true));
    const remove = vi.fn(() => Promise.resolve(false));
    const outcome = await locateReplaceBoundFolder({
      absentPath: ABSENT,
      pick: { folders: [{ workspacePath: NEW_A }] },
      add,
      remove,
    });
    expect(outcome).toEqual({
      kind: "replaced-stale-entry",
      retainedPath: ABSENT,
      addedPaths: [NEW_A],
    });
    expect(remove).toHaveBeenCalledWith(ABSENT);
  });

  it("still reports a clean replacement when the remove succeeds", async () => {
    // Counter-pin: the failure arm must not swallow the ordinary path.
    const outcome = await locateReplaceBoundFolder({
      absentPath: ABSENT,
      pick: { folders: [{ workspacePath: NEW_A }] },
      add: () => Promise.resolve(true),
      remove: () => Promise.resolve(true),
    });
    expect(outcome).toEqual({
      kind: "replaced",
      removedPath: ABSENT,
      addedPaths: [NEW_A],
    });
  });
});
