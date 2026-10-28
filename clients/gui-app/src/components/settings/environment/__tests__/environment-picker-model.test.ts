import { describe, expect, it } from "vitest";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import {
  environmentPickerModel,
  isStaleLocalPick,
  localPickerRow,
  personalSubtitle,
  type EnvironmentPickerModel,
} from "@/components/settings/environment/environment-picker-model";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import type { NegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";

const V11 = { major: 1, minor: 1 } as const;
const V10 = { major: 1, minor: 0 } as const;

const OLD_LAPTOP = { hostId: "old", name: "Old laptop" };

const awaiting = environmentStatusFixture({
  principal: null,
  planes: { records: "local", broker: "local", room: "local" },
  setup: { stage: "moving_settings", state: "awaiting_consent" },
});
const consentRecorded = environmentStatusFixture({
  principal: null,
  planes: { records: "moved", broker: "local", room: "local" },
  pendingUploads: [
    {
      uploadId: "u1",
      kind: "secret",
      key: "k",
      os: "macos",
      queuedAt: 1,
      receipt: "pending",
      code: null,
    },
  ],
  setup: { stage: "moving_settings", state: "running" },
  consent: { acceptedAt: 1, planHash: "hash" },
});

describe("localPickerRow", () => {
  it("gives an awaiting_consent host the not-moved row with Move to Personal", () => {
    expect(localPickerRow(OLD_LAPTOP, awaiting, V11)).toEqual({
      hostId: "old",
      name: "Old laptop",
      subtitle: "its own settings, not in Personal yet",
      verb: "move_to_personal",
      needsUpdate: false,
      defaultsToLocal: true,
    });
  });

  it("gives a host whose consent is recorded and which is still moving the partly-moved row", () => {
    const row = localPickerRow(OLD_LAPTOP, consentRecorded, V11);
    expect(row).toMatchObject({
      subtitle: "partly in Personal",
      verb: "finish_moving",
      needsUpdate: false,
      defaultsToLocal: false,
    });
  });

  it("gives a host that is moving with no consent recorded no row", () => {
    const status = environmentStatusFixture({
      setup: { stage: "moving_settings", state: "running" },
    });
    expect(localPickerRow(OLD_LAPTOP, status, V11)).toBeNull();
  });

  it.each<[string, NegotiatedMethodVersion]>([
    ["negotiated at 1.0", V10],
    ["absent from the host's methods", false],
  ])(
    "greys a host with environment.status %s that has not reached applying",
    (_label, version) => {
      const status = environmentStatusFixture({
        principal: null,
        setup: { stage: "moving_settings", state: "running" },
      });
      expect(localPickerRow(OLD_LAPTOP, status, version)).toEqual({
        hostId: "old",
        name: "Old laptop",
        subtitle: "Old laptop needs an update to show its settings here.",
        verb: null,
        needsUpdate: true,
        defaultsToLocal: false,
      });
    },
  );

  it("greys an old host that has not answered, or has no setup at all", () => {
    expect(localPickerRow(OLD_LAPTOP, null, V10)?.needsUpdate).toBe(true);
    expect(
      localPickerRow(OLD_LAPTOP, environmentStatusFixture({ setup: null }), V10)
        ?.needsUpdate,
    ).toBe(true);
  });

  it("gives an applied 1.0 host no row", () => {
    const applied = environmentStatusFixture({
      setup: { stage: "applying", state: "running" },
    });
    expect(localPickerRow(OLD_LAPTOP, applied, V10)).toBeNull();
    const done = environmentStatusFixture({
      setup: { stage: "done", state: "done" },
    });
    expect(localPickerRow(OLD_LAPTOP, done, V10)).toBeNull();
  });

  it("gives a host that has not negotiated yet, or not answered, no row", () => {
    expect(localPickerRow(OLD_LAPTOP, awaiting, null)?.verb).toBe(
      "move_to_personal",
    );
    expect(localPickerRow(OLD_LAPTOP, null, V11)).toBeNull();
    expect(localPickerRow(OLD_LAPTOP, null, null)).toBeNull();
  });
});

describe("personalSubtitle", () => {
  it("names up to two hosts and counts the rest", () => {
    expect(personalSubtitle([])).toBe(
      "your settings · not on any computer or sandbox",
    );
    expect(personalSubtitle(["MacBook Pro"])).toBe(
      "your settings · on MacBook Pro",
    );
    expect(personalSubtitle(["MacBook Pro", "dev-box"])).toBe(
      "your settings · on MacBook Pro, dev-box",
    );
    expect(personalSubtitle(["a", "b", "c", "d", "e"])).toBe(
      "your settings · on a, b and 3 more",
    );
  });
});

function statusMap(
  entries: ReadonlyArray<[string, EnvironmentStatusResponseV11 | null]>,
): ReadonlyMap<string, EnvironmentStatusResponseV11 | null> {
  return new Map(entries);
}

describe("environmentPickerModel", () => {
  const personalHost = environmentStatusFixture({
    principal: { kind: "personal" },
  });

  it("gives a computer that has a Local row its own row", () => {
    const model = environmentPickerModel({
      hosts: [
        { hostId: "a", name: "MacBook Pro" },
        { hostId: "b", name: "dev-box" },
        { hostId: "c", name: "nas" },
        { hostId: "old", name: "Old laptop" },
      ],
      statuses: statusMap([
        ["a", personalHost],
        ["b", personalHost],
        ["c", personalHost],
        ["old", awaiting],
      ]),
      versions: new Map([
        ["a", V11],
        ["b", V11],
        ["c", V11],
        ["old", V11],
      ]),
      windowHostId: "a",
    });
    expect(model.localRows.map((row) => row.hostId)).toEqual(["old"]);
  });

  it("defaults to the Local row only for this window's own host", () => {
    const input = {
      hosts: [OLD_LAPTOP, { hostId: "other", name: "Other" }],
      statuses: statusMap([
        ["old", awaiting],
        ["other", awaiting],
      ]),
      versions: new Map([
        ["old", V11],
        ["other", V11],
      ]),
    };
    expect(
      environmentPickerModel({ ...input, windowHostId: "old" }).defaultPick,
    ).toEqual({ kind: "local", hostId: "old", hostName: "Old laptop" });
    expect(
      environmentPickerModel({ ...input, windowHostId: "elsewhere" })
        .defaultPick,
    ).toEqual(PERSONAL_PICK);
    expect(
      environmentPickerModel({ ...input, windowHostId: null }).defaultPick,
    ).toEqual(PERSONAL_PICK);
  });

  it("does not default to a partly-moved or greyed window host", () => {
    const partly = environmentPickerModel({
      hosts: [OLD_LAPTOP],
      statuses: statusMap([["old", consentRecorded]]),
      versions: new Map([["old", V11]]),
      windowHostId: "old",
    });
    expect(partly.localRows).toHaveLength(1);
    expect(partly.defaultPick).toEqual(PERSONAL_PICK);
    const greyed = environmentPickerModel({
      hosts: [OLD_LAPTOP],
      statuses: statusMap([["old", null]]),
      versions: new Map([["old", V10]]),
      windowHostId: "old",
    });
    expect(greyed.localRows[0]?.needsUpdate).toBe(true);
    expect(greyed.defaultPick).toEqual(PERSONAL_PICK);
  });
});

describe("isStaleLocalPick", () => {
  const pick = {
    kind: "local",
    hostId: "old",
    hostName: "Old laptop",
  } as const;
  const withRow: EnvironmentPickerModel = environmentPickerModel({
    hosts: [OLD_LAPTOP],
    statuses: statusMap([["old", awaiting]]),
    versions: new Map([["old", V11]]),
    windowHostId: null,
  });
  const withoutRow: EnvironmentPickerModel = environmentPickerModel({
    hosts: [OLD_LAPTOP],
    statuses: statusMap([["old", personalHostMoved()]]),
    versions: new Map([["old", V11]]),
    windowHostId: null,
  });

  function personalHostMoved(): EnvironmentStatusResponseV11 {
    return environmentStatusFixture({
      setup: { stage: "done", state: "done" },
    });
  }

  it("keeps the pick while its computer has not answered", () => {
    expect(isStaleLocalPick(pick, withoutRow, statusMap([["old", null]]))).toBe(
      false,
    );
    expect(isStaleLocalPick(pick, withoutRow, statusMap([]))).toBe(false);
  });

  it("drops the pick once its computer answered and has no Local row", () => {
    expect(
      isStaleLocalPick(
        pick,
        withoutRow,
        statusMap([["old", personalHostMoved()]]),
      ),
    ).toBe(true);
  });

  it("keeps the pick while the computer still has its Local row", () => {
    expect(
      isStaleLocalPick(pick, withRow, statusMap([["old", awaiting]])),
    ).toBe(false);
  });

  it("drops a pick whose row has turned into the needs-an-update row", () => {
    const greyed = environmentPickerModel({
      hosts: [OLD_LAPTOP],
      statuses: statusMap([["old", awaiting]]),
      versions: new Map([["old", V10]]),
      windowHostId: null,
    });
    expect(isStaleLocalPick(pick, greyed, statusMap([["old", awaiting]]))).toBe(
      true,
    );
  });

  it("never drops Personal, a team or no pick", () => {
    const answered = statusMap([["old", personalHostMoved()]]);
    expect(isStaleLocalPick(null, withoutRow, answered)).toBe(false);
    expect(isStaleLocalPick(PERSONAL_PICK, withoutRow, answered)).toBe(false);
    expect(
      isStaleLocalPick(
        { kind: "team", environmentId: "t" },
        withoutRow,
        answered,
      ),
    ).toBe(false);
  });
});
