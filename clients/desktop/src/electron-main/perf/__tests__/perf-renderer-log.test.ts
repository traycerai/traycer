import { describe, expect, it } from "vitest";
import { parsePerfRendererLog } from "../perf-renderer-log";

describe("parsePerfRendererLog", () => {
  it("parses a well-formed [traycer-perf] line into a typed event", () => {
    const line =
      '[traycer-perf] {"name":"worktree.list_query","tsMs":1712345678901,"fields":{"worktreeCount":12,"fromCache":false,"surface":"/settings/worktrees"}}';

    expect(parsePerfRendererLog(line)).toEqual({
      name: "worktree.list_query",
      tsMs: 1712345678901,
      fields: {
        worktreeCount: 12,
        fromCache: false,
        surface: "/settings/worktrees",
      },
    });
  });

  it("returns null for a non-perf line (e.g. the [traycer-gui] human log)", () => {
    expect(
      parsePerfRendererLog('[traycer-gui] {"level":"warn","message":"hi"}'),
    ).toBeNull();
    expect(parsePerfRendererLog("plain console output")).toBeNull();
  });

  it("returns null when the JSON is malformed or shape is wrong", () => {
    expect(parsePerfRendererLog("[traycer-perf] not-json")).toBeNull();
    // Missing name.
    expect(parsePerfRendererLog('[traycer-perf] {"tsMs":1}')).toBeNull();
    // Non-finite / non-number tsMs.
    expect(
      parsePerfRendererLog('[traycer-perf] {"name":"x","tsMs":"nope"}'),
    ).toBeNull();
  });

  it("drops non-scalar fields, keeping only number/string/boolean/null", () => {
    const line =
      '[traycer-perf] {"name":"x","tsMs":1,"fields":{"ok":1,"str":"a","flag":true,"nul":null,"obj":{"a":1},"arr":[1,2]}}';

    const parsed = parsePerfRendererLog(line);
    expect(parsed?.fields).toEqual({
      ok: 1,
      str: "a",
      flag: true,
      nul: null,
    });
  });

  it("defaults fields to {} when absent or not an object", () => {
    expect(
      parsePerfRendererLog('[traycer-perf] {"name":"x","tsMs":1}'),
    ).toEqual({ name: "x", tsMs: 1, fields: {} });
    expect(
      parsePerfRendererLog('[traycer-perf] {"name":"x","tsMs":1,"fields":5}'),
    ).toEqual({ name: "x", tsMs: 1, fields: {} });
  });
});
