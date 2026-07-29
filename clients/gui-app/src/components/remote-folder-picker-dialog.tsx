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
} from "@traycer/protocol/host/workspace/unary-schemas";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useWorkspaceBrowseFolders } from "@/hooks/workspace/use-workspace-browse-folders-query";
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

  const parsed = parseBrowseInput(rawInput, homePath);
  const query = useWorkspaceBrowseFolders({
    client,
    directoryPath: parsed.directoryPath,
    enabled: parsed.valid,
  });
  const data = parsed.valid ? query.data : undefined;

  // Derived-state adjustment during render (React's sanctioned pattern):
  // remember the home directory as soon as the root response is in.
  if (
    parsed.directoryPath === null &&
    data !== undefined &&
    homePath === null
  ) {
    setHomePath(data.directoryPath);
  }

  const shownInput = readShownInput(rawInput, data);
  const filteredEntries = useMemo(
    () => filterEntries(data?.entries, parsed.filter),
    [data?.entries, parsed.filter],
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
    setPath(`${entry.path}/`);
  };

  const goUp = (): void => {
    if (upPath !== null) setPath(upPath === "/" ? "/" : `${upPath}/`);
  };

  const addTarget = readAddTarget(rawInput, homePath, data);

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
          <Kbd className="ml-1">⌘⏎</Kbd>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <p className="px-2 pb-1 text-ui-xs text-muted-foreground">
          Directories
        </p>
        <RemoteFolderPickerListing
          invalid={!parsed.valid}
          isPending={parsed.valid ? query.isPending : false}
          error={parsed.valid ? query.error : null}
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
  if (props.upPresent) {
    rows.push(
      <li key="..">
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
        <li key={entry.path}>
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
 * Split the field into the directory to browse (up to the last `/`) and the
 * live filter after it, expanding a leading `~` against the host home. An
 * unedited field (null) browses the home directory unfiltered.
 */
function parseBrowseInput(
  rawInput: string | null,
  homePath: string | null,
): ParsedBrowseInput {
  if (rawInput === null) {
    return { valid: true, directoryPath: null, filter: "" };
  }
  const raw = rawInput.trim();
  if (raw === "" || raw === "~" || raw === "~/") {
    return { valid: true, directoryPath: null, filter: "" };
  }
  let path = raw;
  if (path.startsWith("~/")) {
    // Home not learned yet: keep the root browse running (it is the only
    // request that can teach us home), unfiltered; the next render reparses
    // once the response lands.
    if (homePath === null) {
      return { valid: true, directoryPath: null, filter: "" };
    }
    path = homePath + path.slice(1);
  }
  if (!path.startsWith("/")) return INVALID_INPUT;
  const lastSlash = path.lastIndexOf("/");
  const directory = lastSlash === 0 ? "/" : path.slice(0, lastSlash);
  return {
    valid: true,
    directoryPath: directory,
    filter: path.slice(lastSlash + 1),
  };
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

/** Field text when unedited: the current location with a trailing slash. */
function readShownInput(
  rawInput: string | null,
  data: WorkspaceBrowseFoldersResponse | undefined,
): string {
  if (rawInput !== null) return rawInput;
  return data !== undefined ? `${data.directoryPath}/` : "";
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
  const raw = rawInput.trim();
  if (raw === "") return null;
  if (raw === "~" || raw === "~/")
    return homePath ?? data?.directoryPath ?? null;
  let path = raw;
  if (path.startsWith("~/")) {
    if (homePath === null) return null;
    path = homePath + path.slice(1);
  }
  if (!path.startsWith("/")) return null;
  while (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path;
}
