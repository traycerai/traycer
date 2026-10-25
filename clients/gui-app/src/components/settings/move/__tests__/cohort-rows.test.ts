import { describe, expect, it } from "vitest";
import {
  LOCAL_ROW_NOT_MOVED,
  LOCAL_ROW_NOT_SHARING,
  LOCAL_ROW_PARTLY_MOVED,
  LOCAL_ROW_SHARED_UNRECORDED,
  cohortFromPlanes,
  planeMoveSheetLabel,
  stillLocalFromPlanes,
  type EnvironmentPlaneState,
  type EnvironmentPlanes,
} from "@/components/settings/move/cohort-rows";

function planes(
  records: EnvironmentPlaneState,
  broker: EnvironmentPlaneState,
  room: EnvironmentPlaneState,
): EnvironmentPlanes {
  return { records, broker, room };
}

describe("cohortFromPlanes", () => {
  it("has no Local row on a fresh or fully moved computer", () => {
    const moved = cohortFromPlanes(planes("moved", "moved", "moved"), false);
    expect(moved.hasLocalRow).toBe(false);
    expect(moved.subtitle).toBeNull();
    expect(moved.verb).toBeNull();
    expect(moved.defaultToLocalRow).toBe(false);
    expect(moved.showRetrospective).toBe(false);
  });

  it("defaults to the Local row when nothing has moved", () => {
    const cohort = cohortFromPlanes(planes("local", "local", "local"), false);
    expect(cohort.hasLocalRow).toBe(true);
    expect(cohort.subtitle).toBe(LOCAL_ROW_NOT_MOVED);
    expect(cohort.verb).toBe("move_to_personal");
    expect(cohort.defaultToLocalRow).toBe(true);
    expect(cohort.showRetrospective).toBe(false);
  });

  it("says partly moved when an upload stopped", () => {
    const cohort = cohortFromPlanes(planes("local", "local", "local"), true);
    expect(cohort.hasLocalRow).toBe(true);
    expect(cohort.subtitle).toBe(LOCAL_ROW_PARTLY_MOVED);
    expect(cohort.verb).toBe("finish_moving");
    expect(cohort.defaultToLocalRow).toBe(true);
  });

  it("has no Local row when every plane was shared by an earlier version", () => {
    const cohort = cohortFromPlanes(
      planes("shared_unrecorded", "shared_unrecorded", "shared_unrecorded"),
      false,
    );
    expect(cohort.hasLocalRow).toBe(false);
    expect(cohort.subtitle).toBeNull();
    expect(cohort.verb).toBeNull();
    expect(cohort.defaultToLocalRow).toBe(false);
    expect(cohort.showRetrospective).toBe(true);
  });

  it("keeps the Local row beside a mixed shared and unmoved computer, opening on Personal", () => {
    const cohort = cohortFromPlanes(
      planes("shared_unrecorded", "local", "local"),
      false,
    );
    expect(cohort.hasLocalRow).toBe(true);
    expect(cohort.subtitle).toBe(LOCAL_ROW_SHARED_UNRECORDED);
    expect(cohort.verb).toBe("move_to_personal");
    expect(cohort.defaultToLocalRow).toBe(false);
    expect(cohort.showRetrospective).toBe(true);
  });

  it("returns the default to the Local row after an explicit stop", () => {
    const cohort = cohortFromPlanes(
      planes("stopped", "stopped", "stopped"),
      false,
    );
    expect(cohort.hasLocalRow).toBe(true);
    expect(cohort.subtitle).toBe(LOCAL_ROW_NOT_SHARING);
    expect(cohort.verb).toBe("move_to_personal");
    expect(cohort.defaultToLocalRow).toBe(true);
    expect(cohort.showRetrospective).toBe(false);
  });

  it("keeps a Local row beside a partly-moved computer that also has local planes", () => {
    const cohort = cohortFromPlanes(planes("moved", "local", "local"), false);
    expect(cohort.hasLocalRow).toBe(true);
    expect(cohort.subtitle).toBe(LOCAL_ROW_NOT_MOVED);
    expect(cohort.verb).toBe("move_to_personal");
    expect(cohort.defaultToLocalRow).toBe(false);
  });

  it("names each plane for the move sheet's rows", () => {
    const cohort = cohortFromPlanes(
      planes("local", "shared_unrecorded", "moved"),
      false,
    );
    expect(cohort.planeNotes.map((note) => note.label)).toEqual([
      planeMoveSheetLabel("local"),
      planeMoveSheetLabel("shared_unrecorded"),
      planeMoveSheetLabel("moved"),
    ]);
  });
});

describe("stillLocalFromPlanes", () => {
  it("names the planes not in Personal yet", () => {
    expect(
      stillLocalFromPlanes(planes("local", "moved", "shared_unrecorded")),
    ).toEqual([{ id: "records", summary: "settings are not in Personal yet" }]);
  });
});

describe("planeMoveSheetLabel", () => {
  it.each([
    ["local", "on this computer"],
    ["moved", "already in Personal"],
    ["shared_unrecorded", "already shared by an earlier version"],
    ["stopped", "stopped using Personal"],
  ] as const)("%s reads %s", (state, label) => {
    expect(planeMoveSheetLabel(state)).toBe(label);
  });
});
