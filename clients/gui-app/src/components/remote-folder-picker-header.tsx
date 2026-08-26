import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PrimaryActionShortcutHint } from "@/components/ui/primary-action-shortcut-hint";
import { TailAnchoredPath } from "@/components/folder-picker-path-view";

export interface RemoteFolderPickerHeaderProps {
  /** Current search text; "" is the browse state. */
  readonly filter: string;
  readonly onFilterChange: (next: string) => void;
  /** Id of the highlighted row, or undefined when the listing is empty. */
  readonly activeOptionId: string | undefined;
  readonly addDisabled: boolean;
  readonly addLabel: string;
  readonly onAdd: () => void;
  /** True while the location heading is swapped for the raw path field. */
  readonly editingPath: boolean;
  readonly onBeginEditPath: () => void;
  readonly onEndEditPath: () => void;
  /** Raw field contents - the absolute path, exactly as it will be read. */
  readonly pathValue: string;
  readonly onPathChange: (next: string) => void;
  /** Presentation of the same location: tilde-collapsed, no trailing slash. */
  readonly displayPath: string;
  /**
   * Bump to hand the keyboard back to the search field after an action
   * elsewhere took focus. A token rather than a ref: the element belongs to
   * this component, so nothing outside it needs to hold a handle on the DOM.
   */
  readonly focusSearchToken: number;
  /** Focus the search input on mount (fine pointers only - see the dialog). */
  readonly autoFocusSearch: boolean;
  readonly onFieldKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * Search field, Add, and the one line in this dialog that renders a location.
 *
 * Two decisions are load-bearing here and are easy to undo by accident:
 *
 * **Search and location are separate controls.** A single field that held the
 * path AND filtered on the segment after its last `/` meant that on a phone
 * the segment naming the folder was the part that fell off the end, and that
 * searching meant editing a path. Splitting them is what lets the location be
 * presented instead of typed.
 *
 * **There is no back arrow.** Up-navigation is the `..` row and only that
 * row: an arrow in a dialog's top-left corner reads as "close", not as
 * "parent folder", and two affordances for one move means the ambiguous one
 * gets tapped. The accepted cost is that going up while a search is active
 * means clearing the search first, since `..` is not a search result.
 */
export function RemoteFolderPickerHeader(
  props: RemoteFolderPickerHeaderProps,
): ReactNode {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { focusSearchToken, autoFocusSearch } = props;
  useEffect(() => {
    // 0 is "never asked"; every later value is one explicit request.
    if (focusSearchToken === 0) return;
    searchRef.current?.focus();
  }, [focusSearchToken]);
  useEffect(() => {
    if (!autoFocusSearch) return;
    searchRef.current?.focus();
  }, [autoFocusSearch]);
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-3 py-3">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-foreground/8 px-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent py-2 text-ui-sm outline-none placeholder:text-muted-foreground"
            ref={searchRef}
            role="combobox"
            aria-label="Search folders"
            aria-controls="remote-folder-picker-listbox"
            // The listbox popup is always presented while the dialog is open
            // (it may be empty); only the active option comes and goes.
            aria-expanded
            aria-activedescendant={props.activeOptionId}
            data-testid="remote-folder-picker-filter"
            value={props.filter}
            placeholder="Search this folder"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => {
              props.onFilterChange(event.target.value);
            }}
            onKeyDown={props.onFieldKeyDown}
          />
          {props.filter === "" ? null : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Clear search"
              data-testid="remote-folder-picker-filter-clear"
              onClick={() => {
                props.onFilterChange("");
              }}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          data-testid="remote-folder-picker-add"
          disabled={props.addDisabled}
          onClick={props.onAdd}
        >
          {props.addLabel}
          <PrimaryActionShortcutHint />
        </Button>
      </div>
      {/* Pinned rather than scrolled with the rows: it is the only statement
          of where these rows come from, so it may not leave the screen. */}
      {props.editingPath ? (
        <input
          // The raw absolute path, one tap behind the heading. Reachable,
          // never the resting presentation.
          className="w-full min-w-0 bg-transparent font-mono text-ui-xs outline-none placeholder:text-muted-foreground"
          // Mounts only when the heading is tapped, so taking focus IS the
          // response to that tap. A callback ref rather than `autoFocus`:
          // the attribute is a page-load behaviour with real accessibility
          // costs, while this fires only on a mount the user just asked for.
          ref={focusOnMount}
          aria-label="Folder path"
          data-testid="remote-folder-picker-path"
          value={props.pathValue}
          placeholder="/path/on/the/host"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onBlur={props.onEndEditPath}
          onChange={(event) => {
            props.onPathChange(event.target.value);
          }}
          onKeyDown={props.onFieldKeyDown}
        />
      ) : (
        <button
          type="button"
          className="flex w-full min-w-0 items-baseline gap-1 text-left text-ui-xs text-muted-foreground"
          data-testid="remote-folder-picker-location"
          aria-label="Edit folder path"
          onClick={props.onBeginEditPath}
        >
          <span className="shrink-0">in</span>
          <TailAnchoredPath
            path={props.displayPath}
            className="min-w-0 flex-1 font-mono"
          />
        </button>
      )}
    </div>
  );
}

/** Take focus as soon as the element exists. */
function focusOnMount(element: HTMLInputElement | null): void {
  element?.focus();
}
