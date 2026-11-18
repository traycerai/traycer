import { beforeEach, describe, expect, it } from "vitest";
import {
  resolveAccountContext,
  useAccountContextStore,
} from "../account-context-store";

describe("account-context store", () => {
  beforeEach(() => {
    useAccountContextStore.setState({ accountContext: { type: "PERSONAL" } });
  });

  it("defaults to Personal", () => {
    expect(useAccountContextStore.getState().accountContext).toEqual({
      type: "PERSONAL",
    });
  });

  it("stores a team selection", () => {
    useAccountContextStore
      .getState()
      .setAccountContext({ type: "TEAM", teamId: "t1" });
    expect(useAccountContextStore.getState().accountContext).toEqual({
      type: "TEAM",
      teamId: "t1",
    });
  });

  it("keeps a team that still exists", () => {
    expect(
      resolveAccountContext(
        { type: "TEAM", teamId: "t1" },
        new Set(["t1", "t2"]),
      ),
    ).toEqual({ type: "TEAM", teamId: "t1" });
  });

  it("falls back to Personal when the persisted team is gone", () => {
    expect(
      resolveAccountContext({ type: "TEAM", teamId: "t1" }, new Set(["t2"])),
    ).toEqual({ type: "PERSONAL" });
  });

  it("leaves Personal untouched", () => {
    expect(resolveAccountContext({ type: "PERSONAL" }, new Set())).toEqual({
      type: "PERSONAL",
    });
  });
});
