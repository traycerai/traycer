import {
  environmentStatusResponseSchema,
  environmentStatusResponseSchemaV11,
} from "@traycer/protocol/host/environment-schemas";
import { describe, expect, it } from "vitest";
import { localRowCohort } from "@/components/settings/environment/local-row-cohort";
import {
  LOCAL_ROW_NOT_MOVED,
  LOCAL_ROW_NOT_SHARING,
  LOCAL_ROW_SHARED_UNRECORDED,
} from "@/components/settings/move/cohort-rows";
import {
  isStatusV11,
  planesFromStatus,
  planesHaveSharedUnrecorded,
  planesOfferStopSharing,
  returnedFromTeamAt,
  stoppedSharingAt,
} from "@/components/settings/move/status-planes";

const BASE = {
  principal: { kind: "personal" },
  reachability: "connected",
  bindingGeneration: 1,
  desiredRevision: 1,
  receivedRevision: 1,
  appliedRevision: 1,
  receiptAgeMs: 0,
  items: [],
  pendingUploads: [],
  setup: null,
  remoteAccess: "off",
};

function v10() {
  return environmentStatusResponseSchema.parse(BASE);
}

function v11(extra: Record<string, unknown>) {
  return environmentStatusResponseSchemaV11.parse({ ...BASE, ...extra });
}

const STOPPED_AT = Date.UTC(2026, 9, 1);

describe("stoppedSharingAt", () => {
  it("is null on an answer that predates 1.1", () => {
    expect(isStatusV11(v10())).toBe(false);
    expect(stoppedSharingAt(v10())).toBeNull();
  });

  it("is null while sharing or when it never stopped", () => {
    expect(stoppedSharingAt(v11({}))).toBeNull();
    expect(stoppedSharingAt(v11({ stoppedAt: null }))).toBeNull();
  });

  it("is the time the host reports once sharing stopped", () => {
    expect(stoppedSharingAt(v11({ stoppedAt: STOPPED_AT }))).toBe(STOPPED_AT);
  });
});

describe("status planes", () => {
  it("has no planes or return time on a 1.0 answer", () => {
    expect(planesFromStatus(v10())).toBeNull();
    expect(returnedFromTeamAt(v10())).toBeNull();
  });

  it("reads planes and the team return time from 1.1", () => {
    const status = v11({
      planes: { records: "local", broker: "moved", room: "stopped" },
      returnedFromTeam: { at: 42 },
    });
    expect(planesFromStatus(status)).toEqual({
      records: "local",
      broker: "moved",
      room: "stopped",
    });
    expect(returnedFromTeamAt(status)).toBe(42);
    expect(returnedFromTeamAt(v11({}))).toBeNull();
  });

  it("treats a 1.1 answer without planes as fully moved", () => {
    expect(planesFromStatus(v11({}))).toEqual({
      records: "moved",
      broker: "moved",
      room: "moved",
    });
  });

  it("offers Stop using Personal only once something has moved or was shared", () => {
    const local = { records: "local", broker: "local", room: "local" } as const;
    expect(planesOfferStopSharing(local)).toBe(false);
    expect(
      planesOfferStopSharing({
        records: "stopped",
        broker: "stopped",
        room: "stopped",
      }),
    ).toBe(false);
    expect(planesOfferStopSharing({ ...local, broker: "moved" })).toBe(true);
    expect(
      planesOfferStopSharing({ ...local, room: "shared_unrecorded" }),
    ).toBe(true);
  });

  it("flags an unrecorded share on any one plane", () => {
    const moved = { records: "moved", broker: "moved", room: "moved" } as const;
    expect(planesHaveSharedUnrecorded(moved)).toBe(false);
    expect(
      planesHaveSharedUnrecorded({ ...moved, records: "shared_unrecorded" }),
    ).toBe(true);
    expect(
      planesHaveSharedUnrecorded({ ...moved, broker: "shared_unrecorded" }),
    ).toBe(true);
    expect(
      planesHaveSharedUnrecorded({ ...moved, room: "shared_unrecorded" }),
    ).toBe(true);
  });
});

describe("localRowCohort on environment.status planes", () => {
  it("has no Local row once every plane has moved", () => {
    expect(localRowCohort(v11({}))).toEqual({ kind: "none" });
  });

  it("opens on the Local row when nothing has moved", () => {
    const status = v11({
      planes: { records: "local", broker: "local", room: "local" },
    });
    expect(localRowCohort(status)).toEqual({
      kind: "local",
      subtitle: LOCAL_ROW_NOT_MOVED,
      verb: "move_to_personal",
      defaultsToLocal: true,
    });
  });

  it("says not sharing after every plane stopped", () => {
    const status = v11({
      planes: { records: "stopped", broker: "stopped", room: "stopped" },
      stoppedAt: STOPPED_AT,
    });
    expect(localRowCohort(status)).toEqual({
      kind: "local",
      subtitle: LOCAL_ROW_NOT_SHARING,
      verb: "move_to_personal",
      defaultsToLocal: true,
    });
  });

  it("names the earlier-version share and opens on Personal", () => {
    const status = v11({
      planes: { records: "local", broker: "shared_unrecorded", room: "local" },
    });
    expect(localRowCohort(status)).toEqual({
      kind: "local",
      subtitle: LOCAL_ROW_SHARED_UNRECORDED,
      verb: "move_to_personal",
      defaultsToLocal: false,
    });
  });

  it("offers finish moving when uploads are pending on a partly moved computer", () => {
    const status = v11({
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
    });
    const cohort = localRowCohort(status);
    expect(cohort).toMatchObject({
      kind: "local",
      subtitle: "partly in Personal",
      verb: "finish_moving",
      defaultsToLocal: false,
    });
  });
});
