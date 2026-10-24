/**
 * Local-row subtitle, default pick, verb, and move-sheet plane notes from
 * `environment.status` planes. E4's picker cohort slot reads these through
 * `environment/local-row-cohort.tsx`; this file draws no UI of its own.
 *
 * A host below `environment.status@1.1` has no planes: the caller must not
 * call this (E4 greys that row; we draw no cohort line).
 *
 * Subtitle is the text before the verb. E4 renders `Move to Personal` and
 * `finish moving` from `verb`.
 */

export const ENVIRONMENT_PLANE_IDS = ["records", "broker", "room"] as const;
export type EnvironmentPlaneId = (typeof ENVIRONMENT_PLANE_IDS)[number];

export const ENVIRONMENT_PLANE_STATES = [
  "local",
  "moved",
  "shared_unrecorded",
  "stopped",
] as const;
export type EnvironmentPlaneState = (typeof ENVIRONMENT_PLANE_STATES)[number];

export interface EnvironmentPlanes {
  readonly records: EnvironmentPlaneState;
  readonly broker: EnvironmentPlaneState;
  readonly room: EnvironmentPlaneState;
}

/** Words a person reads for a plane. Never "records", "broker" or "room". */
export const PLANE_DISPLAY_NAME: Readonly<Record<EnvironmentPlaneId, string>> =
  {
    records: "settings",
    broker: "secrets",
    room: "skills and the guide",
  };

export const LOCAL_ROW_NOT_MOVED =
  "not moved · Personal's settings are not on it";
export const LOCAL_ROW_NOT_SHARING =
  "not sharing · Personal's settings are not on it";
export const LOCAL_ROW_SHARED_UNRECORDED =
  "Some files were shared by an earlier version; these settings have not moved.";
export const LOCAL_ROW_PARTLY_MOVED = "partly moved";

export type PlanesCohortVerb = "move_to_personal" | "finish_moving";

export interface PlaneMoveSheetNote {
  readonly plane: EnvironmentPlaneId;
  readonly state: EnvironmentPlaneState;
  readonly label: string;
}

export interface PlanesCohort {
  /** A Local row exists while any plane is still this computer's. */
  readonly hasLocalRow: boolean;
  readonly subtitle: string | null;
  readonly verb: PlanesCohortVerb | null;
  /**
   * The Environment dropdown opens on the Local row only when nothing has
   * moved, or after an explicit stop. A computer already shared or partly
   * moved opens on Personal, Local row beside it.
   */
  readonly defaultToLocalRow: boolean;
  /** The retrospective sheet is offered while any plane is unrecorded. */
  readonly showRetrospective: boolean;
  /** What the move sheet names per plane, through E4's row props. */
  readonly planeNotes: readonly PlaneMoveSheetNote[];
}

function planeValues(
  planes: EnvironmentPlanes,
): readonly EnvironmentPlaneState[] {
  return [planes.records, planes.broker, planes.room];
}

function isThisComputers(state: EnvironmentPlaneState): boolean {
  return state === "local" || state === "stopped";
}

/**
 * How the move sheet names one plane's place. "Partly uploaded" is E4's
 * attempt state, passed in as `partlyMoved` on the Local row, not a plane.
 */
export function planeMoveSheetLabel(state: EnvironmentPlaneState): string {
  switch (state) {
    case "local":
      return "on this computer";
    case "moved":
      return "already in Personal";
    case "shared_unrecorded":
      return "already shared by an earlier version";
    case "stopped":
      return "not sharing";
  }
}

export function cohortFromPlanes(
  planes: EnvironmentPlanes,
  partlyMoved: boolean,
): PlanesCohort {
  const values = planeValues(planes);
  const anyLocal = values.some((state) => state === "local");
  const anyStopped = values.some((state) => state === "stopped");
  const anyShared = values.some((state) => state === "shared_unrecorded");
  const allLocal = values.every((state) => state === "local");
  const allStopped = values.every((state) => state === "stopped");
  const hasLocalRow = anyLocal || anyStopped;
  const planeNotes: PlaneMoveSheetNote[] = ENVIRONMENT_PLANE_IDS.map(
    (plane) => ({
      plane,
      state: planes[plane],
      label: planeMoveSheetLabel(planes[plane]),
    }),
  );
  return {
    hasLocalRow,
    subtitle: localRowSubtitle({
      hasLocalRow,
      allStopped,
      anyShared,
      anyLocal,
      partlyMoved,
    }),
    verb: localRowVerb({
      hasLocalRow,
      partlyMoved,
      anyShared,
      anyLocal,
      allStopped,
    }),
    defaultToLocalRow: allLocal || allStopped,
    showRetrospective: anyShared,
    planeNotes,
  };
}

function localRowVerb(input: {
  readonly hasLocalRow: boolean;
  readonly partlyMoved: boolean;
  readonly anyShared: boolean;
  readonly anyLocal: boolean;
  readonly allStopped: boolean;
}): PlanesCohortVerb | null {
  if (!input.hasLocalRow) return null;
  const finishMoving =
    input.partlyMoved &&
    !(input.anyShared && input.anyLocal) &&
    !input.allStopped;
  if (finishMoving) return "finish_moving";
  return "move_to_personal";
}

function localRowSubtitle(input: {
  readonly hasLocalRow: boolean;
  readonly allStopped: boolean;
  readonly anyShared: boolean;
  readonly anyLocal: boolean;
  readonly partlyMoved: boolean;
}): string | null {
  if (!input.hasLocalRow) return null;
  if (input.allStopped) return LOCAL_ROW_NOT_SHARING;
  if (input.anyShared && input.anyLocal) return LOCAL_ROW_SHARED_UNRECORDED;
  if (input.partlyMoved) return LOCAL_ROW_PARTLY_MOVED;
  return LOCAL_ROW_NOT_MOVED;
}

export function planesHaveLocal(planes: EnvironmentPlanes): boolean {
  return planeValues(planes).some(isThisComputers);
}

/** Planes that have not moved, named the way the retrospective sheet lists them. */
export function stillLocalFromPlanes(
  planes: EnvironmentPlanes,
): readonly { readonly id: EnvironmentPlaneId; readonly summary: string }[] {
  return ENVIRONMENT_PLANE_IDS.filter((plane) => planes[plane] === "local").map(
    (plane) => ({
      id: plane,
      summary: `${PLANE_DISPLAY_NAME[plane]} have not moved`,
    }),
  );
}
