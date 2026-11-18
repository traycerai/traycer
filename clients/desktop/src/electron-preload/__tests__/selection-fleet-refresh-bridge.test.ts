// The preload's `buildSelectionFleetRefresh`: the renderer shell's
// `refreshSelectionFleet`, which must never reject and must read an outcome it
// cannot parse as a read that published nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionAuthorityChannels } from "../../ipc-contracts/ipc-channels";

const fake = vi.hoisted(() => {
  const state: {
    channels: string[];
    answer: () => Promise<unknown>;
  } = {
    channels: [],
    answer: () => Promise.resolve(undefined),
  };
  return state;
});

vi.mock("electron", () => ({
  ipcRenderer: {
    invoke: (channel: string): Promise<unknown> => {
      fake.channels.push(channel);
      return fake.answer();
    },
    on: () => undefined,
    removeListener: () => undefined,
  },
}));

import { buildSelectionFleetRefresh } from "../selection-authority-bridge";

beforeEach(() => {
  fake.channels.length = 0;
  fake.answer = () => Promise.resolve(undefined);
});

describe("buildSelectionFleetRefresh", () => {
  it("invokes the refreshFleet channel and passes published through", async () => {
    fake.answer = () => Promise.resolve({ kind: "published" });

    await expect(buildSelectionFleetRefresh()()).resolves.toEqual({
      kind: "published",
    });
    expect(fake.channels).toEqual([
      SelectionAuthorityChannels.invoke.refreshFleet,
    ]);
  });

  it("passes superseded through", async () => {
    fake.answer = () => Promise.resolve({ kind: "superseded" });

    await expect(buildSelectionFleetRefresh()()).resolves.toEqual({
      kind: "superseded",
    });
  });

  it("passes unavailable through", async () => {
    fake.answer = () => Promise.resolve({ kind: "unavailable" });

    await expect(buildSelectionFleetRefresh()()).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it.each([
    ["an empty answer", undefined],
    ["a non-object answer", "published"],
    ["an unknown kind", { kind: "stale" }],
  ])("reads %s as unavailable", async (_label, answer) => {
    fake.answer = () => Promise.resolve(answer);

    await expect(buildSelectionFleetRefresh()()).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("reads a rejected invoke as unavailable instead of rejecting", async () => {
    fake.answer = () => Promise.reject(new Error("main gone"));

    await expect(buildSelectionFleetRefresh()()).resolves.toEqual({
      kind: "unavailable",
    });
  });
});
