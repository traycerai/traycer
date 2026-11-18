import { useRef, type ReactNode, type RefObject } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InspectorBackRow } from "@/components/layout-editor/inspector/inspector-back-row";
import { RevertButton } from "@/components/layout-editor/inspector/inspector-row";
import { SURFACE_AREAS } from "@/components/layout-editor/inspector/layout-areas";
import {
  sessionChangeLines,
  type SessionChangeLine,
  type SessionChangeLines,
} from "@/components/layout-editor/inspector/layout-change-lines";
import { revertSession, revertSessionLine } from "@/lib/layout/layout-diff";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  getLayoutSnapshot,
  useLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * What this editor session has changed, under the inspector header: a count,
 * and Review, which opens the session's change list as a level of its own -
 * each setting as it was when the editor opened against what it is now, with
 * a revert per line and one for everything.
 *
 * View changes in the Presets block answers a different question - how the
 * layout differs from its preset - and lists the same things whether or not
 * this session touched them.
 */
export function SessionChangesRow(): ReactNode {
  const entry = useLayoutEditorStore((state) => state.entrySnapshot);
  // `dirty` is false only when the layout IS the entry snapshot, so a clean
  // session is drawn without subscribing to the layout or diffing anything.
  const dirty = useLayoutEditorStore((state) => state.dirty);
  if (entry === null) return null;
  return dirty ? (
    <DirtySessionSummary entry={entry} />
  ) : (
    <SessionSummary count={0} />
  );
}

/**
 * The count is read off the lines, not off `dirty`: `dirty` compares the
 * stored record, which can differ where nothing a line names does (an override
 * written equal to its preset's value, the rail's divider counter), and this
 * row says what changed that the user could see.
 */
function DirtySessionSummary(props: {
  readonly entry: LayoutSnapshot;
}): ReactNode {
  return <SessionSummary count={lineCount(useSessionLines(props.entry))} />;
}

function SessionSummary(props: { readonly count: number }): ReactNode {
  const { count } = props;
  // Hidden while its level is open: the back row is the way out of it.
  const reviewing = useLayoutEditorStore((state) => state.reviewingSession);
  return (
    <div
      data-testid="layout-session-changes"
      className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border pr-2.5 pl-3.5"
    >
      {count > 0 ? (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
      ) : null}
      <span
        data-testid="layout-session-summary"
        className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground"
      >
        {sessionCountWords(count)}
      </span>
      {count > 0 && !reviewing ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-session-review-trigger
          onClick={() => {
            useLayoutEditorStore.getState().setReviewingSession(true);
          }}
        >
          Review
          <ChevronRight aria-hidden data-icon="inline-end" />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The session's change list, drawn in place of the level it was opened from
 * and left by the same back row as any area.
 *
 * An Undo back to where the session started empties it rather than closing
 * it: the level stays where the user put it, and says there is nothing left.
 */
export function SessionReviewLevel(): ReactNode {
  const entry = useLayoutEditorStore((state) => state.entrySnapshot);
  const area = useLayoutEditorStore((state) => state.area);
  const back =
    SURFACE_AREAS.find((candidate) => candidate.id === area)?.label ??
    "All settings";
  const levelRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={levelRef} data-testid="layout-session-review">
      <InspectorBackRow
        label={back}
        onBack={() => {
          useLayoutEditorStore.getState().setReviewingSession(false);
        }}
      />
      {entry === null ? null : (
        <SessionReviewBody entry={entry} levelRef={levelRef} />
      )}
    </div>
  );
}

/**
 * Every revert here is one gesture, so Undo takes it back and none of them
 * asks first. Discard in the Done menu is the other way: it also ends the
 * session, and clears the history with it.
 */
function SessionReviewBody(props: {
  readonly entry: LayoutSnapshot;
  readonly levelRef: RefObject<HTMLDivElement | null>;
}): ReactNode {
  const { levelRef } = props;
  const lines = useSessionLines(props.entry);
  const keys = [...lines.styles, ...lines.arrangement].map((line) => line.key);
  // A line's ↺ takes its line with it, and a focused button that unmounts
  // drops focus to the page. Focus moves first: to the next line's ↺, the
  // previous one's for the last line, or the back row once nothing is left -
  // the one control of the level that is sure to stay.
  const focusSurvivor = (neighbour: string | undefined): void => {
    const level = levelRef.current;
    const target =
      neighbour === undefined
        ? level?.querySelector<HTMLElement>("[data-layout-inspector-back]")
        : // Matched on the dataset rather than a selector: a line key is
          // free text, and a selector would need escaping for it.
          [
            ...(level?.querySelectorAll<HTMLElement>(
              "[data-session-change-line]",
            ) ?? []),
          ]
            .find((node) => node.dataset.sessionChangeLine === neighbour)
            ?.querySelector<HTMLElement>("button");
    target?.focus();
  };
  const revertLine = (line: SessionChangeLine): void => {
    const index = keys.indexOf(line.key);
    // A preset line puts every value back, so no value line outlives it.
    const neighbour =
      line.revert.kind === "preset"
        ? lines.arrangement.at(0)?.key
        : (keys.at(index + 1) ?? (index > 0 ? keys.at(index - 1) : undefined));
    focusSurvivor(neighbour);
    recordSessionRevert((current, entry) =>
      revertSessionLine(current, entry, line.revert),
    );
  };
  const count = lineCount(lines);
  return (
    <>
      <div className="flex items-start gap-3 px-3.5 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-ui-sm font-medium">This session</h3>
          <p className="mt-0.5 text-ui-xs text-muted-foreground">
            What changed since you opened the editor. Undo takes a revert back.
          </p>
        </div>
        {count === 0 ? null : (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => {
              focusSurvivor(undefined);
              recordSessionRevert(revertSession);
            }}
          >
            <RotateCcw aria-hidden data-icon="inline-start" />
            Revert all
          </Button>
        )}
      </div>
      {count === 0 ? (
        <p className="border-t border-border/40 px-3.5 py-3 text-ui-sm text-muted-foreground">
          No changes this session.
        </p>
      ) : (
        <div data-testid="layout-session-change-list">
          <SessionGroup
            title="Styles"
            lines={lines.styles}
            onRevert={revertLine}
          />
          <SessionGroup
            title="Arrangement"
            lines={lines.arrangement}
            onRevert={revertLine}
          />
        </div>
      )}
    </>
  );
}

function SessionGroup(props: {
  readonly title: string;
  readonly lines: ReadonlyArray<SessionChangeLine>;
  readonly onRevert: (line: SessionChangeLine) => void;
}): ReactNode {
  const { title, lines, onRevert } = props;
  if (lines.length === 0) return null;
  return (
    <section aria-label={title}>
      <h4 className="border-t border-border/40 px-3.5 pt-2.5 pb-1 text-ui-xs font-medium text-muted-foreground">
        {title}
      </h4>
      <ul>
        {lines.map((line) => (
          <li
            key={line.key}
            data-session-change-line={line.key}
            className="flex items-center gap-2 border-t border-border/40 py-1.5 pr-2.5 pl-3.5"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-ui-sm">{line.label}</span>
              <span className="truncate text-ui-xs">
                {line.before === null ? null : (
                  <>
                    <span className="text-muted-foreground">{line.before}</span>
                    <span aria-hidden className="text-muted-foreground">
                      {" → "}
                    </span>
                    <span className="sr-only"> to </span>
                  </>
                )}
                {line.after}
              </span>
            </span>
            <span className="flex size-6 shrink-0 items-center justify-center">
              <RevertButton
                label={
                  line.revert.kind === "preset"
                    ? "Revert preset and styles"
                    : `Revert ${line.label}`
                }
                onRevert={() => {
                  onRevert(line);
                }}
              />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One revert as one gesture, read against the entry snapshot as it is at the
 * moment of the press: another window's write rebases it, and a revert
 * never puts back what someone else changed.
 */
function recordSessionRevert(
  revert: (current: LayoutSnapshot, entry: LayoutSnapshot) => LayoutSnapshot,
): void {
  const editor = useLayoutEditorStore.getState();
  const entry = editor.entrySnapshot;
  if (entry === null) return;
  editor.recordGesture(() => {
    useLayoutStore.getState().replaceAll(revert(getLayoutSnapshot(), entry));
  });
}

function useSessionLines(entry: LayoutSnapshot): SessionChangeLines {
  return sessionChangeLines(entry, useLayoutSnapshot());
}

function lineCount(lines: SessionChangeLines): number {
  return lines.styles.length + lines.arrangement.length;
}

function sessionCountWords(count: number): string {
  if (count === 0) return "No changes this session";
  return `${count} ${count === 1 ? "change" : "changes"} this session`;
}
