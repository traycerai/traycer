import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import Mention from "@tiptap/extension-mention";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { HostRpcRegistry } from "@/lib/host";
import { useMentionCollaboratorsForClient } from "@/hooks/comments/use-mention-collaborators";
import {
  MentionSuggestionList,
  type MentionSuggestionListHandle,
} from "./collaborator-mention-suggestion";
import { filterCollaborators, useStableCollaboratorRef } from "./mention-utils";

const MAX_MENTION_RESULTS = 8;

interface MentionAttrs {
  readonly id: string | null;
  readonly label: string | null;
}

/** Read each field defensively so a malformed mention can't crash the renderText path. */
function readMentionAttrs(attrs: unknown): MentionAttrs {
  if (attrs === null || typeof attrs !== "object") {
    return { id: null, label: null };
  }
  const bag: Record<string, unknown> = { ...attrs };
  const id = typeof bag.id === "string" ? bag.id : null;
  const label = typeof bag.label === "string" ? bag.label : null;
  return { id, label };
}

export interface CommentComposerProps {
  readonly epicId: string;
  /** Passed rather than read here because this component is mounted from both, and an ambient app-wide read would
   * offer the wrong machine's collaborators. */
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly initialContent: JsonContent | null;
  readonly placeholder: string;
  /** Whether to grab focus on mount. Used by the floating draft popover and
   *  by inline reply composers. */
  readonly focusOnMount: boolean;
  readonly submitLabel: string;
  /** The composer leaves network state to the caller - it does not clear itself, so the caller should `reset` via
   * the imperative handle on success. */
  readonly onSubmit: (content: JsonContent) => void;
  /** Optional cancel hook. Receives `isDirty` so callers can decide whether
   *  to confirm before discarding. */
  readonly onCancel: ((isDirty: boolean) => void) | null;
  readonly className: string | undefined;
  readonly ref?: Ref<CommentComposerHandle>;
}

export interface CommentComposerHandle {
  reset(): void;
  /** Imperatively focus the editor (used after Submit so the user can keep
   *  typing in the next reply slot without click-fishing). */
  focus(): void;
}

interface SuggestionRenderState {
  readonly items: ReadonlyArray<{
    readonly userId: string;
    readonly displayName: string;
    readonly email: string;
  }>;
  readonly command: (attrs: { id: string; label: string }) => void;
  readonly clientRect: (() => DOMRect | null) | null;
}

/** `Collaboration` is intentionally absent - the composer is private to the local user until they hit Submit;
 * the thread Y.Map only learns about it through the host RPC. */
export function CommentComposer(props: CommentComposerProps) {
  const {
    epicId,
    hostClient,
    initialContent,
    placeholder,
    focusOnMount,
    submitLabel,
    onSubmit,
    onCancel,
    className,
    ref,
  } = props;

  const collaborators = useMentionCollaboratorsForClient(hostClient, epicId);
  const collaboratorsRef = useStableCollaboratorRef(collaborators);
  const suggestionHandleRef = useRef<MentionSuggestionListHandle | null>(null);
  const [suggestionState, setSuggestionState] =
    useState<SuggestionRenderState | null>(null);
  const [isEmpty, setIsEmpty] = useState(initialContent === null);

  // Stable refs so closures inside `useEditor`'s deps-`[]` capture do not
  // see a stale callback once the parent re-renders with new handlers.
  const onSubmitRef = useRef(onSubmit);
  const onCancelRef = useRef(onCancel);
  // Editor's `handleKeyDown` is captured under `useEditor`'s `[]` deps so it would see a stale
  // `suggestionState`.
  const suggestionActiveRef = useRef(false);

  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    suggestionActiveRef.current = suggestionState !== null;
  }, [suggestionState]);

  const mentionExtension = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- Tiptap invokes suggestion callbacks outside React render; the ref keeps the editor instance stable while reading the latest collaborators.
      Mention.configure({
        HTMLAttributes: { class: "comment-mention" },
        renderText({ node }) {
          const attrs = readMentionAttrs(node.attrs);
          const display =
            attrs.label !== null && attrs.label.length > 0
              ? attrs.label
              : (attrs.id ?? "");
          return `@${display}`;
        },
        deleteTriggerWithBackspace: true,
        suggestion: {
          char: "@",
          allowSpaces: false,
          items: ({ query }) =>
            filterCollaborators(collaboratorsRef.current, query, {
              maxResults: MAX_MENTION_RESULTS,
            }).slice(),
          render: () => ({
            onStart(p) {
              setSuggestionState({
                items: p.items,
                command: p.command,
                clientRect: p.clientRect ?? null,
              });
            },
            onUpdate(p) {
              setSuggestionState({
                items: p.items,
                command: p.command,
                clientRect: p.clientRect ?? null,
              });
            },
            onKeyDown(p) {
              if (p.event.key === "Escape") {
                setSuggestionState(null);
                return false;
              }
              return suggestionHandleRef.current?.onKeyDown(p.event) ?? false;
            },
            onExit() {
              setSuggestionState(null);
            },
          }),
        },
      }),
    [collaboratorsRef],
  );

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          // Default `link` mark + heading + horizontal rule are noisy inside a
          // comment box; the editor still supports bold/italic/code/lists.
          heading: false,
          horizontalRule: false,
          link: false,
          blockquote: false,
          codeBlock: false,
        }),
        Placeholder.configure({
          placeholder,
          showOnlyCurrent: false,
          emptyEditorClass: "is-editor-empty",
        }),
        mentionExtension,
      ],
      content: initialContent ?? "",
      autofocus: focusOnMount ? "end" : false,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: cn(
            "tc-editor-prose prose prose-sm dark:prose-invert md-prose max-w-none",
            "min-h-[3.5rem] w-full rounded-md border border-input bg-background px-3 py-2",
            "text-ui-sm leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          ),
          "data-slot": "comment-composer-editor",
          "aria-label": placeholder,
        },
        handleKeyDown(_view, event) {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submitFromEditor();
            return true;
          }
          if (event.key === "Escape" && !suggestionActiveRef.current) {
            event.preventDefault();
            cancelFromEditor();
            return true;
          }
          return false;
        },
      },
      onUpdate({ editor: e }) {
        setIsEmpty(e.isEmpty);
      },
    },
    // Editor identity is intentionally tile-stable: rebuilding would lose draft text. Mention extension closes
    // over refs so it picks up fresh collaborator data without a teardown.
    [],
  );

  const submitFromEditor = useCallback(() => {
    const e = editor;
    if (e === null || e.isEmpty) return;
    onSubmitRef.current(e.getJSON());
  }, [editor]);

  const cancelFromEditor = useCallback(() => {
    const handler = onCancelRef.current;
    if (handler === null) return;
    const isDirty = editor !== null && !editor.isEmpty;
    handler(isDirty);
  }, [editor]);

  useImperativeHandle(
    ref,
    () => ({
      reset() {
        if (editor === null) return;
        editor.commands.clearContent();
        setIsEmpty(true);
      },
      focus() {
        editor?.commands.focus("end");
      },
    }),
    [editor],
  );

  if (editor === null) return null;

  return (
    <div
      data-slot="comment-composer"
      className={cn("flex w-full flex-col gap-2", className)}
    >
      <EditorContent editor={editor} />
      <div className="flex items-center justify-end gap-2">
        {onCancel === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={cancelFromEditor}
          >
            Cancel
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          disabled={isEmpty}
          onClick={submitFromEditor}
        >
          {submitLabel}
        </Button>
      </div>
      {suggestionState === null ? null : (
        <MentionSuggestionList
          ref={suggestionHandleRef}
          items={suggestionState.items}
          command={suggestionState.command}
          getReferenceClientRect={suggestionState.clientRect}
        />
      )}
    </div>
  );
}
