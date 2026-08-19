import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Input } from "@/components/ui/input";
import { MarkdownEditPreview } from "@/components/markdown-edit-preview";
import type {
  NoteScope,
  ProjectNote,
} from "@/lib/workspace/project-notes-visibility";
import { useProjectNotesStore } from "@/stores/workspace/project-notes-store";
import type { ProjectProfile } from "@/stores/workspace/project-profiles-store";

const AUTOSAVE_MS = 400;

export function NoteEditor(props: {
  readonly hostId: string;
  readonly note: ProjectNote;
  readonly profiles: ReadonlyArray<ProjectProfile>;
  readonly onBack: () => void;
}) {
  const { hostId, note, profiles, onBack } = props;
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [scopeValue, setScopeValue] = useState(scopeToValue(note.scope));
  const [deleteOpen, setDeleteOpen] = useState(false);
  const pendingRef = useRef<{
    title: string;
    body: string;
    scope: NoteScope;
  } | null>(null);

  useEffect(() => {
    setTitle(note.title);
    setBody(note.body);
    setScopeValue(scopeToValue(note.scope));
  }, [note.id]);

  const flush = () => {
    const pending = pendingRef.current;
    if (pending === null) return;
    pendingRef.current = null;
    useProjectNotesStore.getState().updateNote(hostId, note.id, {
      title: pending.title,
      body: pending.body,
      scope: pending.scope,
    });
  };

  useEffect(() => {
    const scope = valueToScope(scopeValue);
    pendingRef.current = { title, body, scope };
    const timer = window.setTimeout(flush, AUTOSAVE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [title, body, scopeValue, hostId, note.id]);

  useEffect(() => {
    return () => {
      flush();
    };
  }, [note.id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="note-editor">
      <div className="flex items-center gap-2 border-b border-border/60 px-5 py-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back to notes"
          onClick={() => {
            flush();
            onBack();
          }}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Input
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          placeholder="Untitled note"
          aria-label="Note title"
          data-testid="note-title"
        />
        <select
          aria-label="Note project"
          data-testid="note-scope"
          value={scopeValue}
          onChange={(event) => {
            setScopeValue(event.target.value);
          }}
          className="h-8 max-w-[12rem] rounded-md border border-input bg-transparent px-2 text-ui"
        >
          <option value="general">General</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="note-delete"
          onClick={() => {
            setDeleteOpen(true);
          }}
        >
          Delete
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <MarkdownEditPreview
          value={body}
          onChange={setBody}
          readOnly={false}
          placeholder="Write a note"
          ariaLabel="Note body"
          testId="note-body"
          showPreview
        />
      </div>
      <ConfirmDestructiveDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this note?"
        description="This cannot be undone."
        cascadeSummary={null}
        actionLabel="Delete"
        isPending={false}
        onConfirm={() => {
          flush();
          pendingRef.current = null;
          useProjectNotesStore.getState().deleteNote(hostId, note.id);
          setDeleteOpen(false);
          onBack();
        }}
      />
    </div>
  );
}

function scopeToValue(scope: NoteScope): string {
  return scope.kind === "general" ? "general" : scope.profileId;
}

function valueToScope(value: string): NoteScope {
  if (value === "general") return { kind: "general" };
  return { kind: "project", profileId: value };
}
