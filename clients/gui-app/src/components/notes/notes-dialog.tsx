import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import {
  defaultNoteScope,
  groupVisibleNotes,
} from "@/lib/workspace/project-notes-visibility";
import {
  selectActiveProjectProfile,
  selectProjectProfilesBucket,
  useProjectProfilesStore,
} from "@/stores/workspace/project-profiles-store";
import {
  selectProjectNotesBucket,
  useProjectNotesStore,
} from "@/stores/workspace/project-notes-store";
import { NotesBoard } from "@/components/notes/notes-board";
import { NoteEditor } from "@/components/notes/note-editor";

export function NotesDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const hostId = useReactiveActiveHostId();
  const notesBucket = useProjectNotesStore((state) =>
    selectProjectNotesBucket(state, hostId),
  );
  const profilesBucket = useProjectProfilesStore((state) =>
    selectProjectProfilesBucket(state, hostId),
  );
  const active = useProjectProfilesStore((state) =>
    selectActiveProjectProfile(state, hostId),
  );
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const activeProfileId = active === null ? null : active.id;
  const grouped = useMemo(
    () =>
      groupVisibleNotes({
        notes: notesBucket.notes,
        activeProfileId,
        query,
        profileIds: profilesBucket.profiles.map((profile) => profile.id),
      }),
    [notesBucket, activeProfileId, query, profilesBucket],
  );
  const editing =
    editingId === null
      ? null
      : (notesBucket.notes.find((note) => note.id === editingId) ?? null);

  const createNote = () => {
    if (hostId === null) return;
    const id = useProjectNotesStore.getState().createNote(hostId, {
      title: "",
      body: "",
      scope: defaultNoteScope(activeProfileId),
    });
    if (id === null) {
      toast.error("You have 200 notes on this host. Delete one to add another.");
      return;
    }
    setEditingId(id);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setEditingId(null);
        props.onOpenChange(open);
      }}
    >
      <DialogContent
        className="flex max-h-[88dvh] w-full max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        data-testid="notes-dialog"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-4 pr-12">
          <div className="min-w-0">
            <DialogTitle className="text-base font-semibold">Notes</DialogTitle>
            <DialogDescription className="text-ui-sm text-muted-foreground">
              General notes stay visible everywhere. Project notes stay in that
              project.
            </DialogDescription>
          </div>
          <Button
            type="button"
            size="sm"
            data-testid="notes-new"
            onClick={createNote}
            disabled={hostId === null}
          >
            <Plus className="size-3.5" />
            New note
          </Button>
        </div>
        {editing !== null && hostId !== null ? (
          <NoteEditor
            key={editing.id}
            hostId={hostId}
            note={editing}
            profiles={profilesBucket.profiles}
            onBack={() => {
              setEditingId(null);
            }}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border/60 px-5 py-3">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                placeholder="Search notes"
                aria-label="Search notes"
                data-testid="notes-search"
              />
            </div>
            <NotesBoard
              grouped={grouped}
              profiles={profilesBucket.profiles}
              onOpenNote={setEditingId}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
