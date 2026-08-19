import { cn } from "@/lib/utils";
import { markdownToPlainText } from "@/lib/markdown/markdown-to-plain-text";
import { useRelativeTimestamp } from "@/lib/relative-time";
import {
  displayNoteTitle,
  type ProjectNote,
} from "@/lib/workspace/project-notes-visibility";

export function NoteCard(props: {
  readonly note: ProjectNote;
  readonly accentClassName: string;
  readonly onOpen: (noteId: string) => void;
}) {
  const title = displayNoteTitle(props.note.title);
  const preview = markdownToPlainText(props.note.body);
  return (
    <button
      type="button"
      aria-label={title}
      onClick={() => {
        props.onOpen(props.note.id);
      }}
      className="flex w-full cursor-pointer flex-col gap-2 rounded-lg border border-border bg-foreground/6 p-3 text-left hover:bg-foreground/8"
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={cn(
            "mt-1 h-8 w-1 shrink-0 rounded-full",
            props.accentClassName,
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui font-medium">{title}</p>
          {preview.length > 0 ? (
            <p className="mt-1 line-clamp-3 text-ui-sm text-muted-foreground">
              {preview}
            </p>
          ) : null}
          <NoteUpdatedLabel updatedAt={props.note.updatedAt} />
        </div>
      </div>
    </button>
  );
}

function NoteUpdatedLabel(props: { readonly updatedAt: number }) {
  const label = useRelativeTimestamp(props.updatedAt);
  return (
    <p className="mt-2 text-ui-xs text-muted-foreground">Updated {label}</p>
  );
}
