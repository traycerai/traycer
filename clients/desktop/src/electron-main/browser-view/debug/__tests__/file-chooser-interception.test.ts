import { describe, expect, it, vi } from "vitest";
import { FileChooserInterception } from "../file-chooser-interception";

vi.mock("../../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
  describeLogError: (err: unknown) => String(err),
}));

interface Rig {
  readonly interception: FileChooserInterception;
  /** One entry per command sent, in order, each settled by hand. */
  readonly sent: Array<{
    readonly enabled: boolean;
    readonly settle: PromiseWithResolvers<void>;
  }>;
  readonly state: { live: boolean; desired: boolean };
}

function createRig(desired: boolean): Rig {
  const sent: Rig["sent"] = [];
  const state = { live: true, desired };
  const interception = new FileChooserInterception({
    live: () => state.live,
    desired: () => state.desired,
    send: (enabled) => {
      const settle = Promise.withResolvers<void>();
      sent.push({ enabled, settle });
      return settle.promise;
    },
  });
  return { interception, sent, state };
}

function sentValues(rig: Rig): boolean[] {
  return rig.sent.map((command) => command.enabled);
}

function command(rig: Rig, index: number): Rig["sent"][number] {
  const found = rig.sent[index];
  if (found === undefined) throw new Error(`command ${index} was not sent`);
  return found;
}

async function microtasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("FileChooserInterception", () => {
  it("sends the first command synchronously inside sync()", () => {
    const rig = createRig(true);

    void rig.interception.sync();

    expect(sentValues(rig)).toEqual([true]);
  });

  it("sends nothing while a command is in flight, then applies a reading that moved meanwhile once", async () => {
    const rig = createRig(true);
    const done = rig.interception.sync();
    expect(sentValues(rig)).toEqual([true]);

    rig.state.desired = false;
    void rig.interception.sync();
    void rig.interception.sync();
    await microtasks();
    expect(sentValues(rig)).toEqual([true]);

    command(rig, 0).settle.resolve();
    await microtasks();
    expect(sentValues(rig)).toEqual([true, false]);

    command(rig, 1).settle.resolve();
    await done;
    expect(sentValues(rig)).toEqual([true, false]);

    // Applied is now false: nothing further is owed.
    await rig.interception.sync();
    expect(sentValues(rig)).toEqual([true, false]);
  });

  it("does not record a rejected command, so the next sync sends the same value again", async () => {
    const rig = createRig(true);
    const first = rig.interception.sync();
    command(rig, 0).settle.reject(new Error("refused"));
    await first;
    expect(sentValues(rig)).toEqual([true]);

    const second = rig.interception.sync();
    expect(sentValues(rig)).toEqual([true, true]);
    command(rig, 1).settle.resolve();
    await second;

    await rig.interception.sync();
    expect(sentValues(rig)).toEqual([true, true]);
  });

  it("re-sends false after true succeeded and the following false was rejected", async () => {
    const rig = createRig(true);
    const first = rig.interception.sync();
    rig.state.desired = false;
    void rig.interception.sync();

    command(rig, 0).settle.resolve();
    await microtasks();
    expect(sentValues(rig)).toEqual([true, false]);
    command(rig, 1).settle.reject(new Error("refused"));
    await first;

    // The record still says the target holds true, so false is owed again.
    const retry = rig.interception.sync();
    expect(sentValues(rig)).toEqual([true, false, false]);
    command(rig, 2).settle.resolve();
    await retry;

    await rig.interception.sync();
    expect(sentValues(rig)).toEqual([true, false, false]);
  });

  it("drops a command that died across a reset and applies the reading to the new attachment", async () => {
    const rig = createRig(true);
    const done = rig.interception.sync();
    expect(sentValues(rig)).toEqual([true]);

    rig.interception.reset();
    command(rig, 0).settle.resolve();
    await microtasks();

    // The old command's success was not recorded, so the new attachment,
    // which holds false, is sent the reading too.
    expect(sentValues(rig)).toEqual([true, true]);
    command(rig, 1).settle.resolve();
    await done;

    await rig.interception.sync();
    expect(sentValues(rig)).toEqual([true, true]);
  });

  it("keeps going after a command rejected across a reset", async () => {
    const rig = createRig(true);
    const done = rig.interception.sync();

    rig.interception.reset();
    command(rig, 0).settle.reject(new Error("target closed"));
    await microtasks();

    expect(sentValues(rig)).toEqual([true, true]);
    command(rig, 1).settle.resolve();
    await done;
  });

  it("sends nothing while the target is not live", async () => {
    const rig = createRig(true);
    rig.state.live = false;

    await rig.interception.sync();

    expect(rig.sent).toEqual([]);
  });

  it("sends nothing when the reading equals what the target holds", async () => {
    const rig = createRig(false);

    await rig.interception.sync();
    expect(rig.sent).toEqual([]);

    rig.state.desired = true;
    const enable = rig.interception.sync();
    command(rig, 0).settle.resolve();
    await enable;
    await rig.interception.sync();
    expect(sentValues(rig)).toEqual([true]);
  });
});
