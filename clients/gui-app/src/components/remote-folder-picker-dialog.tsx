import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ArrowLeft, CornerLeftUp, Folder } from "lucide-react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  WorkspaceBrowseFolderEntry,
  WorkspaceBrowseFoldersResponse,
  WorkspacePrepareFoldersResponseV12,
  WorkspaceRecentEntry,
} from "@traycer/protocol/host/workspace/unary-schemas";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { PrimaryActionShortcutHint } from "@/components/ui/primary-action-shortcut-hint";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useWorkspaceBrowseFolders } from "@/hooks/workspace/use-workspace-browse-folders-query";
import { useWorkspaceGetHomeDir } from "@/hooks/workspace/use-workspace-get-home-dir-query";
import { useWorkspaceListRecentWorkspaces } from "@/hooks/workspace/use-workspace-list-recent-workspaces-query";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";

/**
 * Folder picker for hosts the client cannot open a native OS dialog for
 * (remote hosts - phone/browser clients, or a desktop pointed at another
 * machine). Browses the HOST's filesystem via `workspace.browseFolders`.
 *
 * The path field is the single source of truth: everything up to the last
 * `/` is the directory being browsed, the segment after it live-filters the
 * listing. Choosing a row appends `name/` (descending); deleting characters
 * past a `/` naturally walks back up. Consent-gated folders look and pick
 * like any other row - selecting needs no read. Listing one either raises
 * the consent prompt on the host (surfaced here as the host's bounded
 * timeout message with Retry) or reports the denial as a short no-access
 * line.
 *
 * Globally mounted (AppShell); opened through the promise-based
 * `useRemoteFolderPickerStore.requestPick()` so imperative flows await it
 * exactly like the native dialog.
 */
export function RemoteFolderPickerDialog(): ReactNode {
  const open = useRemoteFolderPickerStore((state) => state.open);
  const requestId = useRemoteFolderPickerStore((state) => state.requestId);
  const settle = useRemoteFolderPickerStore((state) => state.settle);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(null);
      }}
    >
      <DialogContent
        className="flex max-h-[min(80dvh,36rem)] w-[min(92vw,34rem)] max-w-[min(92vw,34rem)] flex-col gap-0 p-0"
        data-testid="remote-folder-picker-dialog"
        // Phone-facing portal outside HomePage's touch scope: re-apply the
        // coarse-pointer hit-slop rules (home-touch-targets.css) so every
        // control hits >=44px.
        data-home-touch-scope=""
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Add folder</DialogTitle>
        <DialogDescription className="sr-only">
          Browse the host machine and pick a folder to add.
        </DialogDescription>
        {/* Mounted only while open, keyed per request: a second requestPick
            while already open must not inherit the first request's path or
            in-flight query. */}
        {open ? <RemoteFolderPickerBody key={requestId} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RemoteFolderPickerBody(): ReactNode {
  const settle = useRemoteFolderPickerStore((state) => state.settle);
  // The requester's client (tab-bound where the pick started in a tab) - the
  // dialog must browse the same host the picked path is submitted to.
  const client = useRemoteFolderPickerStore((state) => state.client);
  // null = not edited yet; the field then shows the host home once known.
  const [rawInput, setRawInput] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // The host's home, learned from the root (null-path) response; anchors `~`.
  const [homePath, setHomePath] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the field on mount: Radix focuses it when the dialog opens, but a
  // second requestPick remounts this keyed body inside an already-open
  // dialog, which Radix does not refocus.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Both are conveniences that must never gate browsing: each fails closed
  // against a v1.0 host and is read here as "absent", never as an error.
  const homeDirQuery = useWorkspaceGetHomeDir({ client, enabled: true });
  const recentsQuery = useWorkspaceListRecentWorkspaces({
    client,
    enabled: true,
  });

  // Where `~` points. The root browse response is preferred - it is the
  // directory actually being shown - and `getHomeDir` is the fallback that
  // keeps `~` working when home is UNLISTABLE, so the root browse never
  // answers and can never teach it. Add needs no listing, so picking out of an
  // unlistable home still works. Null when neither answered (a v1.0 host fails
  // `getHomeDir` closed); `~` then simply does not expand.
  //
  // Deliberately inline rather than extracted into a helper: routing it
  // through a function makes `parsed` opaque to the React Compiler, which then
  // bails out of preserving the `filteredEntries` memo below.
  const effectiveHome = homePath ?? homeDirQuery.data?.homeDir ?? null;

  const parsed = parseBrowseInput(rawInput, effectiveHome);
  const query = useWorkspaceBrowseFolders({
    client,
    directoryPath: parsed.directoryPath,
    enabled: parsed.valid,
  });
  const data = parsed.valid ? query.data : undefined;
  // A FAILED REFETCH keeps the last successful `data` in the cache (this
  // query is `staleTime: 10_000`, so stepping back into a directory serves
  // cache and refetches behind it). The listing renders no rows at all while
  // this is set, so navigation has to agree with what is on screen - counting
  // the stale rows below would let the arrow keys address option ids that are
  // not rendered and let Enter open a directory the user cannot see.
  const listingError = parsed.valid ? query.error : null;

  // Derived-state adjustment during render (React's sanctioned pattern):
  // remember the home directory as soon as the root response is in.
  if (
    parsed.directoryPath === null &&
    data !== undefined &&
    homePath === null
  ) {
    setHomePath(data.directoryPath);
  }

  const recentEntries = readRecentShortcuts(rawInput, recentsQuery.data);

  const shownInput = readShownInput(rawInput, data, effectiveHome);
  const filteredEntries = useMemo(
    () =>
      filterEntries(
        listingError !== null ? undefined : data?.entries,
        parsed.filter,
      ),
    [listingError, data?.entries, parsed.filter],
  );
  const upPath = readUpPath(data, parsed);
  // Row 0 is the ".." row whenever there is somewhere to go up to.
  const rowCount = (upPath !== null ? 1 : 0) + filteredEntries.length;
  const clampedIndex = Math.min(selectedIndex, Math.max(rowCount - 1, 0));

  const setPath = (path: string): void => {
    setRawInput(path);
    setSelectedIndex(0);
  };

  const enterEntry = (entry: WorkspaceBrowseFolderEntry): void => {
    setPath(withTrailingSeparator(entry.path));
  };

  const goUp = (): void => {
    if (upPath !== null) setPath(withTrailingSeparator(upPath));
  };

  const addTarget = readAddTarget(rawInput, effectiveHome, data);

  const addCurrent = (): void => {
    if (addTarget === null) return;
    settle(addTarget);
  };

  const openSelectedRow = (): void => {
    if (upPath !== null && clampedIndex === 0) {
      goUp();
      return;
    }
    const entry = filteredEntries.at(clampedIndex - (upPath !== null ? 1 : 0));
    if (entry !== undefined) enterEntry(entry);
  };

  const moveSelection = (delta: number): void => {
    const next = Math.min(
      Math.max(clampedIndex + delta, 0),
      Math.max(rowCount - 1, 0),
    );
    setSelectedIndex(next);
    const option = document.getElementById(pickerOptionId(next));
    if (option !== null && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Up one folder"
          data-testid="remote-folder-picker-up"
          disabled={upPath === null}
          onClick={goUp}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <input
          // Bare input, command-palette style: the dialog frame is the field.
          className="min-w-0 flex-1 bg-transparent font-mono text-ui-sm outline-none placeholder:text-muted-foreground"
          ref={inputRef}
          role="combobox"
          aria-label="Folder path"
          aria-controls="remote-folder-picker-listbox"
          // The listbox popup is always presented while the dialog is open
          // (it may be empty); only the active option comes and goes.
          aria-expanded
          aria-activedescendant={
            rowCount > 0 ? pickerOptionId(clampedIndex) : undefined
          }
          data-testid="remote-folder-picker-path"
          value={shownInput}
          placeholder="/path/on/the/host"
          spellCheck={false}
          onChange={(event) => {
            setRawInput(event.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={(event) => {
            handlePickerFieldKeys(event, {
              addCurrent,
              openSelectedRow,
              moveSelection,
            });
          }}
        />
        <Button
          type="button"
          size="sm"
          data-testid="remote-folder-picker-add"
          disabled={addTarget === null}
          onClick={addCurrent}
        >
          Add
          <PrimaryActionShortcutHint />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <RemoteFolderPickerRecents
          entries={recentEntries}
          onPick={(path) => {
            // Picking a recent makes the field non-pristine, which unmounts
            // the whole row - including the button that was just activated.
            // `onMouseDown` keeps focus for a pointer, but a keyboard user
            // (Enter/Space) never triggers that, so focus would land nowhere
            // and the field would stop accepting typing, arrows and cmd+Enter.
            setPath(path);
            inputRef.current?.focus();
          }}
        />
        <p className="px-2 pb-1 text-ui-xs text-muted-foreground">
          Directories
        </p>
        <RemoteFolderPickerListing
          invalid={!parsed.valid}
          isPending={parsed.valid ? query.isPending : false}
          error={listingError}
          entries={data === undefined ? undefined : filteredEntries}
          upPresent={upPath !== null}
          selectedIndex={clampedIndex}
          onUp={goUp}
          onEnter={enterEntry}
          onRetry={() => {
            // Retry receives focus and disappears when it succeeds - hand
            // the keyboard back to the combobox field either way.
            void query.refetch().finally(() => {
              inputRef.current?.focus();
            });
          }}
        />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2 text-ui-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> Navigate
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>⏎</Kbd> Open
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>⌫</Kbd> Back
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Esc</Kbd> Close
        </span>
      </div>
    </div>
  );
}

/**
 * Recently-opened workspaces on the host, as one-tap shortcuts.
 *
 * Deliberately OUTSIDE the listbox: the combobox's keyboard model (arrows
 * move through directories, Enter descends) stays exactly as it was, and
 * these stay plain tab-reachable buttons. Picking one fills the field with
 * that path rather than adding it outright - the field is the picker's single
 * source of truth, so this arms Add with the recent while still showing it in
 * context (its parent, filtered to it) and leaving it editable.
 */
function RemoteFolderPickerRecents(props: {
  readonly entries: ReadonlyArray<WorkspaceRecentEntry>;
  readonly onPick: (path: string) => void;
}): ReactNode {
  if (props.entries.length === 0) return null;
  return (
    <div data-testid="remote-folder-picker-recents">
      <p className="px-2 pb-1 text-ui-xs text-muted-foreground">Recent</p>
      <div className="flex flex-wrap gap-1 px-2 pb-3">
        {props.entries.map((entry) => (
          <Button
            key={entry.path}
            type="button"
            variant="outline"
            size="sm"
            className="h-8 max-w-full min-w-0 font-mono font-normal"
            data-testid="remote-folder-picker-recent"
            // Keep focus (and the keyboard model) on the combobox field.
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              props.onPick(entry.path);
            }}
          >
            <span className="min-w-0 truncate">{entry.path}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}

function RemoteFolderPickerListing(props: {
  readonly invalid: boolean;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly entries: ReadonlyArray<WorkspaceBrowseFolderEntry> | undefined;
  readonly upPresent: boolean;
  readonly selectedIndex: number;
  readonly onUp: () => void;
  readonly onEnter: (entry: WorkspaceBrowseFolderEntry) => void;
  readonly onRetry: () => void;
}): ReactNode {
  // The `..` option renders in every state (error/loading included): the
  // combobox always references this listbox, and backing out of an
  // unlistable folder must stay one tap away.
  const rows: ReactNode[] = [];
  // role/id/aria-selected live on the BUTTON: assistive tech flattens option
  // descendants, so the option element must itself be the actionable node.
  // The <li> wrappers are therefore `role="presentation"` - a listbox must own
  // its options directly, and an <li> sitting between the two is an invalid
  // owned-element hop.
  if (props.upPresent) {
    rows.push(
      <li key=".." role="presentation">
        <Button
          type="button"
          variant="ghost"
          tabIndex={-1}
          role="option"
          id={pickerOptionId(0)}
          aria-selected={props.selectedIndex === 0}
          className={cn(
            "h-10 w-full justify-start gap-2 px-2",
            props.selectedIndex === 0 && "bg-accent",
          )}
          data-testid="remote-folder-picker-up-row"
          // Keep focus (and the keyboard model) on the combobox field.
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={props.onUp}
        >
          <CornerLeftUp className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left font-normal">
            ..
          </span>
        </Button>
      </li>,
    );
  }
  const offset = props.upPresent ? 1 : 0;
  (props.error === null ? (props.entries ?? []) : []).forEach(
    (entry, index) => {
      rows.push(
        <li key={entry.path} role="presentation">
          <Button
            type="button"
            variant="ghost"
            tabIndex={-1}
            role="option"
            id={pickerOptionId(index + offset)}
            aria-selected={props.selectedIndex === index + offset}
            className={cn(
              "h-10 w-full justify-start gap-2 px-2",
              props.selectedIndex === index + offset && "bg-accent",
            )}
            data-testid="remote-folder-picker-row"
            // Keep focus (and the keyboard model) on the combobox field.
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              props.onEnter(entry);
            }}
          >
            <Folder className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left font-normal">
              {entry.name}
            </span>
          </Button>
        </li>,
      );
    },
  );
  return (
    <>
      {/* Always mounted, possibly empty: the combobox's aria-controls
          reference must never dangle. */}
      <ul
        className="flex flex-col"
        role="listbox"
        id="remote-folder-picker-listbox"
        aria-label="Directories"
        data-testid="remote-folder-picker-rows"
      >
        {rows}
      </ul>
      <RemoteFolderPickerListingStatus
        invalid={props.invalid}
        isPending={props.isPending}
        error={props.error}
        entries={props.entries}
        onRetry={props.onRetry}
      />
    </>
  );
}

function RemoteFolderPickerListingStatus(props: {
  readonly invalid: boolean;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly entries: ReadonlyArray<WorkspaceBrowseFolderEntry> | undefined;
  readonly onRetry: () => void;
}): ReactNode {
  if (props.invalid) {
    // Not loading - nothing was requested for a non-absolute path.
    return (
      <p
        className="p-2 text-ui-sm text-muted-foreground"
        data-testid="remote-folder-picker-invalid"
      >
        Type an absolute path (or ~/...).
      </p>
    );
  }
  if (props.error !== null) {
    // The host's filesystem answers each get a short line; a too-old host
    // gets upgrade guidance; anything else (transport failure, disconnect)
    // is not a filesystem answer and stays retryable.
    if (isPermissionDenied(props.error)) {
      return (
        <p
          className="p-2 text-ui-sm text-muted-foreground"
          data-testid="remote-folder-picker-error"
          role="alert"
        >
          No access to this folder.
        </p>
      );
    }
    if (isListingTimeout(props.error)) {
      // The host's message is platform-tailored: on a Mac host it advises
      // checking for a consent prompt; elsewhere it is a plain timeout.
      return (
        <div
          className="flex flex-col items-start gap-2 p-2 text-ui-sm"
          data-testid="remote-folder-picker-error"
          role="alert"
        >
          <p className="text-muted-foreground">{props.error.message}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={props.onRetry}
          >
            Retry
          </Button>
        </div>
      );
    }
    if (isNotFound(props.error)) {
      return (
        <p
          className="p-2 text-ui-sm text-muted-foreground"
          data-testid="remote-folder-picker-error"
          role="alert"
        >
          No such folder.
        </p>
      );
    }
    if (isHostUnsupported(props.error)) {
      return (
        <p
          className="p-2 text-ui-sm text-muted-foreground"
          data-testid="remote-folder-picker-error"
          role="alert"
        >
          This host app is too old for remote browsing - update Traycer on the
          host machine.
        </p>
      );
    }
    return (
      <div
        className="flex flex-col items-start gap-2 p-2 text-ui-sm"
        data-testid="remote-folder-picker-error"
        role="alert"
      >
        <p className="text-muted-foreground">Couldn't load this folder.</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={props.onRetry}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (props.isPending || props.entries === undefined) {
    return (
      <div
        className="flex flex-col gap-1"
        data-testid="remote-folder-picker-loading"
        aria-busy="true"
        aria-label="Loading folders"
      >
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full rounded-md" />
        ))}
      </div>
    );
  }
  if (props.entries.length === 0) {
    return (
      <p className="p-2 text-ui-sm text-muted-foreground">No subfolders.</p>
    );
  }
  return null;
}

function isPermissionDenied(error: Error): boolean {
  return error.message.includes("denied on the host machine");
}

function isListingTimeout(error: Error): boolean {
  return error.message.includes("Timed out listing");
}

function isNotFound(error: Error): boolean {
  return error.message.includes("No such folder");
}

function isHostUnsupported(error: Error): boolean {
  return error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED";
}

function pickerOptionId(index: number): string {
  return `remote-folder-picker-option-${String(index)}`;
}

/**
 * Keyboard model on the path field (the dialog auto-focuses it): arrows move
 * the row selection, Enter opens the selected row, cmd/ctrl+Enter adds the
 * current path. Backspace needs no handler - deleting characters past a `/`
 * IS up-navigation, because the field is the source of truth.
 */
function handlePickerFieldKeys(
  event: KeyboardEvent<HTMLInputElement>,
  actions: {
    readonly addCurrent: () => void;
    readonly openSelectedRow: () => void;
    readonly moveSelection: (delta: number) => void;
  },
): void {
  // An IME owns the keyboard mid-composition: Enter commits the composed
  // segment and arrows move the candidate selection, so none of these may be
  // hijacked. Prefer nativeEvent.isComposing: React's KeyboardEvent typing in
  // this package does not expose isComposing on the synthetic event.
  if (event.nativeEvent.isComposing) return;
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    actions.addCurrent();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    actions.openSelectedRow();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    actions.moveSelection(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    actions.moveSelection(-1);
  }
}

interface ParsedBrowseInput {
  /** False when the field holds something that is not a browsable path yet. */
  readonly valid: boolean;
  /** RPC path of the directory segment; null = the host's home. */
  readonly directoryPath: string | null;
  /** Live filter: the segment after the last `/`. */
  readonly filter: string;
}

const INVALID_INPUT: ParsedBrowseInput = {
  valid: false,
  directoryPath: null,
  filter: "",
};

/**
 * Paths here are HOST-native, not client-native: `workspace.browseFolders`
 * runs on the host and answers in whatever that OS writes, so a Windows host
 * sends `C:\Users\alice` and a POSIX host sends `/Users/alice`. The picker
 * therefore accepts BOTH separators everywhere and echoes back the one a path
 * is already written with.
 *
 * It never has to CONVERT: Windows accepts `/` as a separator too, so a path
 * the user types with forward slashes still resolves on the host, and mixing
 * them (`~/proj` expanded against `C:\Users\alice`) is fine.
 */
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:[\\/]/;

/**
 * `\\server\share` - the shortest thing on a UNC path that is still a root.
 * Windows accepts forward slashes here too (`//server/share`), so both lead-in
 * separators count; a genuine POSIX path virtually never starts with a doubled
 * slash, and POSIX itself leaves that prefix implementation-defined.
 */
const WINDOWS_UNC_ROOT = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/;

function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    WINDOWS_DRIVE_ROOT.test(path) ||
    WINDOWS_UNC_ROOT.test(path)
  );
}

/**
 * Length of the leading run that navigation may never chop into: `/`, `C:\`,
 * or `\\server\share`. Without it, going up from `C:\Users` would land on
 * `C:` (a drive-relative path, not a folder) instead of stopping at `C:\`.
 */
function rootLengthOf(path: string): number {
  const unc = WINDOWS_UNC_ROOT.exec(path);
  if (unc !== null) return unc[0].length;
  if (WINDOWS_DRIVE_ROOT.test(path)) return 3;
  return 1;
}

/**
 * `\` counts as a separator only once the path is known to be Windows-native.
 * On a POSIX host a backslash is an ordinary filename character, so a folder
 * genuinely named `foo\bar` must not be split at it - `/srv/foo\bar` browses
 * `/srv` filtered by `foo\bar`, never `/srv/foo` filtered by `bar`.
 */
function lastSeparatorIndex(path: string): number {
  if (path.startsWith("/") && !WINDOWS_UNC_ROOT.test(path)) {
    return path.lastIndexOf("/");
  }
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

/**
 * The separator a path already uses. A POSIX absolute path always wins, so a
 * directory legitimately NAMED with a backslash cannot flip the whole path to
 * Windows separators.
 */
function separatorOf(path: string): string {
  if (path.startsWith("/")) return "/";
  return path.includes("\\") ? "\\" : "/";
}

/** Descending appends a separator; a root already ends in one. */
function withTrailingSeparator(path: string): string {
  // Only the path's OWN separator counts as already-terminated: a POSIX
  // folder named `foo\` still needs its `/`.
  const separator = separatorOf(path);
  return path.endsWith(separator) ? path : path + separator;
}

function isTildeOnly(raw: string): boolean {
  return raw === "~" || raw === "~/" || raw === "~\\";
}

function startsWithTilde(path: string): boolean {
  return path.startsWith("~/") || path.startsWith("~\\");
}

/**
 * Split the field into the directory to browse (up to the last separator) and
 * the live filter after it, expanding a leading `~` against the host home. An
 * unedited field (null) browses the home directory unfiltered.
 */
function parseBrowseInput(
  rawInput: string | null,
  homePath: string | null,
): ParsedBrowseInput {
  if (rawInput === null) {
    return { valid: true, directoryPath: null, filter: "" };
  }
  // Trailing whitespace is SIGNIFICANT: a POSIX directory may legitimately end
  // in one, so only the leading side is forgiven (nothing absolute starts with
  // whitespace). Emptiness and tilde-only are judged on a fully-trimmed copy -
  // whitespace alone is still "no path yet", not a filter.
  const raw = rawInput.trimStart();
  const collapsed = raw.trimEnd();
  if (collapsed === "" || isTildeOnly(collapsed)) {
    return { valid: true, directoryPath: null, filter: "" };
  }
  let path = raw;
  if (startsWithTilde(path)) {
    // Home not learned yet: keep the root browse running (it is the only
    // request that can teach us home), unfiltered; the next render reparses
    // once the response lands.
    if (homePath === null) {
      return { valid: true, directoryPath: null, filter: "" };
    }
    path = homePath + path.slice(1);
  }
  if (!isAbsolutePath(path)) return INVALID_INPUT;
  const lastSlash = lastSeparatorIndex(path);
  const rootLength = rootLengthOf(path);
  if (lastSlash < rootLength) {
    // Still inside the root itself, so the root IS the directory and whatever
    // follows it is the filter. This cannot be derived from the last
    // separator: `/` and `C:\` end in theirs so the two happen to agree, but
    // a UNC share root does not - `\\server\share` would take its filter from
    // the separator before `share` and filter the share by its own name,
    // hiding every row.
    return {
      valid: true,
      directoryPath: path.slice(0, rootLength),
      filter: path.slice(rootLength),
    };
  }
  return {
    valid: true,
    directoryPath: path.slice(0, lastSlash),
    filter: path.slice(lastSlash + 1),
  };
}

/**
 * Recent-workspace shortcuts to offer: only on the PRISTINE field - the "just
 * opened the picker" moment they are for - because once the user types, the
 * listing is the subject and the shortcuts would only crowd it. Empty when the
 * host did not answer the operation (v1.0 fails it closed), which renders
 * nothing rather than an error.
 */
function readRecentShortcuts(
  rawInput: string | null,
  recentsData: WorkspacePrepareFoldersResponseV12 | undefined,
): ReadonlyArray<WorkspaceRecentEntry> {
  if (rawInput !== null) return [];
  return recentsData?.recentWorkspaces ?? [];
}

function parentOf(path: string): string {
  const rootLength = rootLengthOf(path);
  const index = lastSeparatorIndex(path);
  // At (or inside) the root the parent is the root itself - the fixpoint the
  // caller reads as "nowhere further up".
  return index < rootLength ? path.slice(0, rootLength) : path.slice(0, index);
}

/** Field text when unedited: the current location with a trailing separator. */
function readShownInput(
  rawInput: string | null,
  data: WorkspaceBrowseFoldersResponse | undefined,
  homePath: string | null,
): string {
  if (rawInput !== null) return rawInput;
  if (data !== undefined) return withTrailingSeparator(data.directoryPath);
  // The root listing FAILED but `getHomeDir` answered - the supported
  // unlistable-home case. Add is armed with that home, so it has to be
  // visible: showing a blank field under an enabled Add would submit a path
  // the user was never shown. `readAddTarget` falls back the same way.
  return homePath === null ? "" : withTrailingSeparator(homePath);
}

/**
 * Up-navigation target. While a directory is unlistable (loading, or no
 * access) the response carries no parent - fall back to the lexical parent
 * so the user can still back out with the button or the `..` row.
 */
function readUpPath(
  data: WorkspaceBrowseFoldersResponse | undefined,
  parsed: ParsedBrowseInput,
): string | null {
  if (data !== undefined) return data.parentPath;
  if (parsed.valid && parsed.directoryPath !== null) {
    return parentOf(parsed.directoryPath);
  }
  return null;
}

/**
 * Prefix-filter the listing by the segment being typed. The host sends
 * hidden (dot) directories too; they surface only while the filter itself
 * starts with "." (T3-style).
 */
function filterEntries(
  entries: ReadonlyArray<WorkspaceBrowseFolderEntry> | undefined,
  filter: string,
): ReadonlyArray<WorkspaceBrowseFolderEntry> {
  if (entries === undefined) return [];
  const showHidden = filter.startsWith(".");
  const folded = filter.toLowerCase();
  return entries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(folded) &&
      (showHidden || !entry.name.startsWith(".")),
  );
}

/**
 * What Add picks: exactly what the field shows (with `~` expanded and any
 * trailing `/` dropped), whether or not that folder was ever listed -
 * selecting a folder needs no read. An unedited field picks the home the
 * field displays; a field the user explicitly cleared picks nothing.
 */
function readAddTarget(
  rawInput: string | null,
  homePath: string | null,
  data: WorkspaceBrowseFoldersResponse | undefined,
): string | null {
  if (rawInput === null) return data?.directoryPath ?? homePath;
  // Same discipline as `parseBrowseInput`: trailing whitespace stays part of
  // the path - `/srv/project ` and `/srv/project` are distinct siblings, and
  // Add must submit exactly what the field shows.
  const raw = rawInput.trimStart();
  const collapsed = raw.trimEnd();
  if (collapsed === "") return null;
  if (isTildeOnly(collapsed)) return homePath ?? data?.directoryPath ?? null;
  let path = raw;
  if (startsWithTilde(path)) {
    if (homePath === null) return null;
    path = homePath + path.slice(1);
  }
  if (!isAbsolutePath(path)) return null;
  const rootLength = rootLengthOf(path);
  // Same discipline as `withTrailingSeparator`: strip only this path's own
  // separator, so a POSIX folder named `foo\` keeps its backslash.
  const separator = separatorOf(path);
  while (path.length > rootLength && path.endsWith(separator)) {
    path = path.slice(0, -1);
  }
  return path;
}
