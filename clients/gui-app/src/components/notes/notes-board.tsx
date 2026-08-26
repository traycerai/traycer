import type { ReactNode } from "react";
import { PROJECT_PROFILE_COLOR_DOT } from "@/components/layout/header/project-profile-colors";
import { NoteCard } from "@/components/notes/note-card";
import type { GroupedVisibleNotes } from "@/lib/workspace/project-notes-visibility";
import type { ProjectProfile } from "@/stores/workspace/project-profiles-store";

export function NotesBoard(props: {
  readonly grouped: GroupedVisibleNotes;
  readonly profiles: ReadonlyArray<ProjectProfile>;
  readonly onOpenNote: (noteId: string) => void;
}) {
  const { grouped, profiles, onOpenNote } = props;
  const empty =
    grouped.general.length === 0 &&
    grouped.projectSections.length === 0 &&
    grouped.orphan.length === 0;
  if (empty) {
    return (
      <div className="flex flex-1 items-center justify-center px-5 py-10 text-ui-sm text-muted-foreground">
        No notes yet
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
      {grouped.general.length > 0 ? (
        <NotesSection title="General">
          {grouped.general.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              accentClassName="bg-muted-foreground"
              onOpen={onOpenNote}
            />
          ))}
        </NotesSection>
      ) : null}
      {grouped.projectSections.map((section) => {
        const profile = profiles.find((item) => item.id === section.profileId);
        if (profile === undefined) return null;
        return (
          <NotesSection key={section.profileId} title={profile.name}>
            {section.notes.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                accentClassName={PROJECT_PROFILE_COLOR_DOT[profile.color]}
                onOpen={onOpenNote}
              />
            ))}
          </NotesSection>
        );
      })}
      {grouped.orphan.length > 0 ? (
        <NotesSection title="Deleted project">
          {grouped.orphan.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              accentClassName="bg-foreground/30"
              onOpen={onOpenNote}
            />
          ))}
        </NotesSection>
      ) : null}
    </div>
  );
}

function NotesSection(props: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-ui-sm font-medium text-muted-foreground">
        {props.title}
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{props.children}</div>
    </section>
  );
}
