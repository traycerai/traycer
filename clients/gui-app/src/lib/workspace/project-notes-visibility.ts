export type NoteScope =
  | { readonly kind: "general" }
  | { readonly kind: "project"; readonly profileId: string };

export interface ProjectNote {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly scope: NoteScope;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NoteProjectSection {
  readonly profileId: string;
  readonly notes: ReadonlyArray<ProjectNote>;
}

export interface GroupedVisibleNotes {
  readonly general: ReadonlyArray<ProjectNote>;
  readonly projectSections: ReadonlyArray<NoteProjectSection>;
  readonly orphan: ReadonlyArray<ProjectNote>;
}

export function noteMatchesProject(
  note: ProjectNote,
  activeProfileId: string | null,
): boolean {
  if (activeProfileId === null) return true;
  return (
    note.scope.kind === "general" || note.scope.profileId === activeProfileId
  );
}

export function noteMatchesQuery(note: ProjectNote, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return (
    note.title.toLowerCase().includes(q) || note.body.toLowerCase().includes(q)
  );
}

export function visibleNotes(input: {
  readonly notes: ReadonlyArray<ProjectNote>;
  readonly activeProfileId: string | null;
  readonly query: string;
}): ReadonlyArray<ProjectNote> {
  return input.notes.filter(
    (note) =>
      noteMatchesProject(note, input.activeProfileId) &&
      noteMatchesQuery(note, input.query),
  );
}

export function groupVisibleNotes(input: {
  readonly notes: ReadonlyArray<ProjectNote>;
  readonly activeProfileId: string | null;
  readonly query: string;
  readonly profileIds: ReadonlyArray<string>;
}): GroupedVisibleNotes {
  const visible = visibleNotes(input);
  const general = visible.filter((note) => note.scope.kind === "general");
  const known = new Set(input.profileIds);
  const byProjectId = new Map<string, ProjectNote[]>();
  const orphan: ProjectNote[] = [];
  for (const note of visible) {
    if (note.scope.kind !== "project") continue;
    if (!known.has(note.scope.profileId)) {
      orphan.push(note);
      continue;
    }
    const list = byProjectId.get(note.scope.profileId) ?? [];
    list.push(note);
    byProjectId.set(note.scope.profileId, list);
  }
  const projectSections = input.profileIds.flatMap((profileId) => {
    const notes = byProjectId.get(profileId);
    if (notes === undefined || notes.length === 0) return [];
    return [{ profileId, notes }];
  });
  return { general, projectSections, orphan };
}

export function displayNoteTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : "Untitled note";
}

export function defaultNoteScope(
  activeProfileId: string | null,
): NoteScope {
  if (activeProfileId === null) return { kind: "general" };
  return { kind: "project", profileId: activeProfileId };
}
