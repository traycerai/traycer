export interface ProjectProfileFolder {
  /** Absolute path on the host that prepared it. */
  readonly path: string;
  /** Host that owns the path; null = legacy/unknown (match any host). */
  readonly hostId: string | null;
}

export interface ProjectProfile {
  readonly id: string; // crypto.randomUUID()
  readonly name: string;
  readonly icon: string; // id from PROFILE_ICONS (Task 4)
  readonly color: string; // id from PROFILE_COLORS (Task 4)
  readonly folders: ReadonlyArray<ProjectProfileFolder>; // length >= 1; [0] is primary
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewProjectProfileInput {
  readonly name: string;
  readonly icon: string;
  readonly color: string;
  readonly folders: ReadonlyArray<ProjectProfileFolder>;
}

export interface ProjectProfilePatch {
  readonly name: string | undefined;
  readonly icon: string | undefined;
  readonly color: string | undefined;
  readonly folders: ReadonlyArray<ProjectProfileFolder> | undefined;
}
