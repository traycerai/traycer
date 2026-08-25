import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CornerLeftUp, Folder, Settings2, X } from "lucide-react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostKind } from "@traycer-clients/shared/host-client/host-directory";
import type {
  WorkspaceBrowseFolderEntryV11,
  WorkspaceBrowseFoldersResponseV11,
  WorkspaceRecentEntry,
} from "@traycer/protocol/host/workspace/unary-schemas";
import { Button } from "@/components/ui/button";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { FilePathTooltip } from "@/components/file-path-tooltip";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import { modLabel } from "@/lib/keybindings/platform";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useWorkspaceBrowseFolders } from "@/hooks/workspace/use-workspace-browse-folders-query";
import { useWorkspaceGetHomeDir } from "@/hooks/workspace/use-workspace-get-home-dir-query";
import { useWorkspaceListRecentWorkspaces } from "@/hooks/workspace/use-workspace-list-recent-workspaces-query";
import {
  type NegotiatedMethodVersion,
  useHostNegotiatedMethodVersion,
} from "@/hooks/host/use-host-negotiated-method-version";
import { hostQueryKeys } from "@/lib/query-keys";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";
import {
  filterEntries,
  parseBrowseInput,
  type ParsedBrowseInput,
  readAddTarget,
  readShownInput,
  readUpPath,
  separatorOf,
  shouldCreateDirectory,
  startsWithTilde,
  withTrailingSeparator,
} from "@/components/remote-folder-picker-path";

/**
 * Folder picker for every host. Browses the selected HOST's filesystem via
 * `workspace.browseFolders`, so local, remote, desktop, browser and mobile
 * surfaces all share the same path-aware flow.
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
        className="flex w-full max-w-none max-h-[45svh] flex-col gap-0 overflow-hidden p-0 shadow-2xl sm:max-w-none md:top-[18svh] md:max-w-2xl md:translate-y-0 max-md:h-safe-dvh max-md:w-safe-dvw max-md:max-h-none max-md:rounded-none max-md:pb-safe-bottom"
        data-testid="remote-folder-picker-dialog"
        // Phone-facing portal outside HomePage's touch scope: re-apply the
        // coarse-pointer hit-slop rules (home-touch-targets.css) so every
        // control hits >=44px.
        data-home-touch-scope=""
        overlayClassName="bg-black/70 supports-backdrop-filter:backdrop-blur-sm"
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
  const showHiddenFolders = useRemoteFolderPickerStore(
    (state) => state.showHiddenFolders,
  );
  const setShowHiddenFolders = useRemoteFolderPickerStore(
    (state) => state.setShowHiddenFolders,
  );
  const browse = useRemoteFolderPickerBrowse();
  const selection = useRemoteFolderPickerSelection({
    setRawInput: browse.setRawInput,
    parsed: browse.parsed,
    data: browse.data,
    listingError: browse.listingError,
    showHiddenFolders,
  });
  const { addTarget, createDirectory } = readFolderPickerAddState({
    canCreateDirectory: browse.canCreateDirectory,
    rawInput: browse.rawInput,
    parsed: browse.parsed,
    data: browse.data,
    listingError: browse.listingError,
    homePath: browse.homePath,
  });
  const addCurrent = (): void => {
    if (addTarget === null) return;
    settle(
      createDirectory
        ? { kind: "createAndPrepare", path: addTarget }
        : { kind: "prepare", folderPaths: [addTarget] },
    );
  };
  const nativePicker = useRemoteFolderPickerNative({
    canRefresh: browse.parsed.valid,
    refetch: browse.query.refetch,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RemoteFolderPickerHeader
        activeIndex={selection.activeIndex}
        addCurrent={addCurrent}
        addTarget={addTarget}
        canGoBack={selection.upPath !== null}
        createDirectory={createDirectory}
        goBack={selection.goUp}
        inputRef={browse.inputRef}
        moveSelection={selection.moveSelection}
        onChange={(value) => {
          browse.setRawInput(value);
          selection.setSelectedIndex(null);
        }}
        onClose={() => settle(null)}
        onOpenSelectedRow={selection.openSelectedRow}
        shownInput={browse.shownInput}
      />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        <RemoteFolderPickerRecents
          entries={browse.recentEntries}
          onPick={(path) => {
            // Picking a recent makes the field non-pristine, which unmounts
            // the whole row - including the button that was just activated.
            // `onMouseDown` keeps focus for a pointer, but a keyboard user
            // (Enter/Space) never triggers that, so focus would land nowhere
            // and the field would stop accepting typing, arrows and cmd+Enter.
            selection.setPath(path);
            browse.inputRef.current?.focus();
          }}
        />
        <p className="px-2 pb-1 text-ui-xs text-muted-foreground">
          Directories
        </p>
        <RemoteFolderPickerListing
          key={browse.browseDirectoryPath}
          invalid={!browse.parsed.valid}
          isPending={browse.parsed.valid ? browse.query.isPending : false}
          error={browse.listingError}
          entries={
            browse.data === undefined ? undefined : selection.filteredEntries
          }
          upPresent={selection.upPath !== null}
          activeIndex={selection.activeIndex}
          hideEmptyMessage={createDirectory}
          onActivate={selection.setSelectedIndex}
          onUp={selection.goUp}
          onEnter={selection.enterEntry}
          onRetry={() => {
            // Retry receives focus and disappears when it succeeds - hand
            // the keyboard back to the combobox field either way.
            void browse.query.refetch().finally(() => {
              browse.inputRef.current?.focus();
            });
          }}
        />
      </div>
      <RemoteFolderPickerFooter
        activeIndex={selection.activeIndex}
        chooseNatively={nativePicker.chooseNatively}
        nativePickerDisabledReason={nativePicker.nativePickerDisabledReason}
        rowCount={selection.rowCount}
        showHiddenFolders={showHiddenFolders}
        upPath={selection.upPath}
        onShowHiddenFoldersChange={(checked) => {
          selection.setSelectedIndex(null);
          setShowHiddenFolders(checked);
        }}
      />
    </div>
  );
}

function useRemoteFolderPickerBrowse() {
  const client = useRemoteFolderPickerStore((state) => state.client);
  const [rawInput, setRawInput] = useState<string | null>(null);
  const [homePath, setHomePath] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const prepareFoldersVersion = useHostNegotiatedMethodVersion(
    client,
    "workspace.prepareFolders",
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const recentsQuery = useWorkspaceListRecentWorkspaces({
    client,
    enabled: true,
  });
  const parsed = parseBrowseInput(rawInput, homePath);
  const browseDirectoryPath = readBrowseDirectoryPath(parsed, homePath);
  const query = useWorkspaceBrowseFolders({
    client,
    directoryPath: browseDirectoryPath,
    enabled: parsed.valid,
  });
  const data = parsed.valid ? query.data : undefined;
  const listingError = parsed.valid ? query.error : null;
  const homeDirQuery = useWorkspaceGetHomeDir({
    client,
    enabled: readHomeQueryEnabled(rawInput, homePath, parsed, listingError),
  });
  const discoveredHome = readDiscoveredHome(
    parsed,
    data,
    homeDirQuery.data?.homeDir ?? null,
  );
  if (homePath === null && discoveredHome !== null) {
    setHomePath(discoveredHome);
  }

  return {
    browseDirectoryPath,
    canCreateDirectory: supportsDirectoryCreation(prepareFoldersVersion),
    data,
    homePath,
    inputRef,
    listingError,
    parsed,
    query,
    rawInput,
    recentEntries:
      rawInput === null ? (recentsQuery.data?.recentWorkspaces ?? []) : [],
    setRawInput,
    shownInput: readShownInput(rawInput, data, homePath),
  };
}

function useRemoteFolderPickerSelection(args: {
  readonly setRawInput: (value: string | null) => void;
  readonly parsed: ParsedBrowseInput;
  readonly data: WorkspaceBrowseFoldersResponseV11 | undefined;
  readonly listingError: Error | null;
  readonly showHiddenFolders: boolean;
}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const filteredEntries = useMemo(
    () =>
      filterEntries(
        readVisibleEntries(args.data, args.listingError),
        args.parsed.filter,
        args.showHiddenFolders,
      ),
    [args.data, args.listingError, args.parsed.filter, args.showHiddenFolders],
  );
  const upPath = readUpPath(args.data, args.parsed);
  const rowCount = (upPath === null ? 0 : 1) + filteredEntries.length;
  const activeIndex = readActiveIndex(selectedIndex, rowCount);

  const setPath = (path: string): void => {
    args.setRawInput(path);
    setSelectedIndex(null);
  };
  const enterEntry = (entry: WorkspaceBrowseFolderEntryV11): void => {
    setPath(withTrailingSeparator(entry.path));
  };
  const goUp = (): void => {
    if (upPath !== null) setPath(withTrailingSeparator(upPath));
  };
  const openSelectedRow = (): void => {
    if (activeIndex === null) return;
    if (upPath !== null && activeIndex === 0) {
      goUp();
      return;
    }
    const entry = filteredEntries.at(activeIndex - (upPath !== null ? 1 : 0));
    if (entry !== undefined) enterEntry(entry);
  };
  const moveSelection = (delta: number): void => {
    if (rowCount === 0) return;
    const next = readNextSelectionIndex(activeIndex, delta, rowCount);
    setSelectedIndex(next);
    const option = document.getElementById(pickerOptionId(next));
    if (option !== null && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  };

  return {
    activeIndex,
    enterEntry,
    filteredEntries,
    goUp,
    moveSelection,
    openSelectedRow,
    rowCount,
    setPath,
    setSelectedIndex,
    upPath,
  };
}

function readFolderPickerAddState(args: {
  readonly canCreateDirectory: boolean;
  readonly rawInput: string | null;
  readonly parsed: ParsedBrowseInput;
  readonly data: WorkspaceBrowseFoldersResponseV11 | undefined;
  readonly listingError: Error | null;
  readonly homePath: string | null;
}): { readonly addTarget: string | null; readonly createDirectory: boolean } {
  const wantsCreateDirectory = shouldCreateDirectory(
    args.rawInput,
    args.parsed,
    args.data,
    args.listingError,
  );
  if (wantsCreateDirectory && !args.canCreateDirectory) {
    return { addTarget: null, createDirectory: false };
  }
  return {
    addTarget: readAddTarget(args.rawInput, args.homePath, args.data),
    createDirectory: wantsCreateDirectory,
  };
}

function useRemoteFolderPickerNative(args: {
  readonly canRefresh: boolean;
  readonly refetch: () => Promise<unknown>;
}) {
  const requestId = useRemoteFolderPickerStore((state) => state.requestId);
  const settle = useRemoteFolderPickerStore((state) => state.settle);
  const client = useRemoteFolderPickerStore((state) => state.client);
  const runnerHost = useRunnerHostOrNull();
  const queryClient = useQueryClient();
  const [nativePickerPending, setNativePickerPending] = useState(false);
  const nativePickerPendingRef = useRef(false);
  const activeHost = client?.getActiveHost() ?? null;
  const nativePickerDisabledReason = readNativePickerDisabledReason(
    nativePickerPending,
    activeHost?.kind ?? null,
    runnerHost?.workspaceFolders.canPickNatively === true,
  );

  const chooseNatively = async (): Promise<void> => {
    if (
      nativePickerDisabledReason !== null ||
      runnerHost === null ||
      nativePickerPendingRef.current
    ) {
      return;
    }
    nativePickerPendingRef.current = true;
    setNativePickerPending(true);
    const hostId = client?.getActiveHostId() ?? null;
    try {
      const paths = await runnerHost.workspaceFolders.pickFolders();
      if (!isCurrentPickerRequest(requestId)) return;
      if (paths.length === 0) {
        if (args.canRefresh) void args.refetch();
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(hostId, "workspace.browseFolders"),
        refetchType: "none",
      });
      settle({ kind: "prepare", folderPaths: paths });
    } catch {
      if (isCurrentPickerRequest(requestId)) {
        reportableErrorToast("Couldn't open the folder picker.", undefined, {
          title: "Could not add workspace folders",
          message: "The folder picker failed to open.",
          code: null,
          source: "Workspace folders",
        });
      }
    } finally {
      if (isCurrentPickerRequest(requestId)) {
        nativePickerPendingRef.current = false;
        setNativePickerPending(false);
      }
    }
  };

  return { chooseNatively, nativePickerDisabledReason };
}

function readBrowseDirectoryPath(
  parsed: ParsedBrowseInput,
  homePath: string | null,
): string | null {
  return parsed.directoryPath === homePath ? null : parsed.directoryPath;
}

function readHomeQueryEnabled(
  rawInput: string | null,
  homePath: string | null,
  parsed: ParsedBrowseInput,
  listingError: Error | null,
): boolean {
  if (homePath !== null) return false;
  return (
    (rawInput !== null && startsWithTilde(rawInput.trimStart())) ||
    (parsed.directoryPath === null && listingError !== null)
  );
}

function readDiscoveredHome(
  parsed: ParsedBrowseInput,
  data: WorkspaceBrowseFoldersResponseV11 | undefined,
  fallbackHome: string | null,
): string | null {
  if (parsed.directoryPath === null && data !== undefined) {
    return data.directoryPath;
  }
  return fallbackHome;
}

function supportsDirectoryCreation(version: NegotiatedMethodVersion): boolean {
  return (
    version !== null &&
    version !== false &&
    version.major === 1 &&
    version.minor >= 3
  );
}

function readVisibleEntries(
  data: WorkspaceBrowseFoldersResponseV11 | undefined,
  listingError: Error | null,
): ReadonlyArray<WorkspaceBrowseFolderEntryV11> | undefined {
  return listingError === null ? data?.entries : undefined;
}

function readActiveIndex(
  selectedIndex: number | null,
  rowCount: number,
): number | null {
  if (selectedIndex === null || rowCount === 0) return null;
  return Math.min(selectedIndex, rowCount - 1);
}

function isCurrentPickerRequest(requestId: number): boolean {
  const picker = useRemoteFolderPickerStore.getState();
  return picker.open && picker.requestId === requestId;
}

function RemoteFolderPickerHeader({
  activeIndex,
  addCurrent,
  addTarget,
  canGoBack,
  createDirectory,
  goBack,
  inputRef,
  moveSelection,
  onChange,
  onClose,
  onOpenSelectedRow,
  shownInput,
}: {
  readonly activeIndex: number | null;
  readonly addCurrent: () => void;
  readonly addTarget: string | null;
  readonly canGoBack: boolean;
  readonly createDirectory: boolean;
  readonly goBack: () => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly moveSelection: (delta: number) => void;
  readonly onChange: (value: string) => void;
  readonly onClose: () => void;
  readonly onOpenSelectedRow: () => void;
  readonly shownInput: string;
}): ReactNode {
  return (
    <div className="flex shrink-0 items-center gap-2 px-3 py-3">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Up one folder"
        data-testid="remote-folder-picker-up"
        disabled={!canGoBack}
        onClick={goBack}
      >
        <ArrowLeft className="size-4" />
      </Button>
      <input
        // Bare input, command-palette style: the dialog frame is the field.
        className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-ui-sm"
        ref={inputRef}
        role="combobox"
        aria-label="Folder path"
        aria-controls="remote-folder-picker-listbox"
        // The listbox popup is always presented while the dialog is open
        // (it may be empty); only the active option comes and goes.
        aria-expanded
        aria-activedescendant={
          activeIndex === null ? undefined : pickerOptionId(activeIndex)
        }
        data-testid="remote-folder-picker-path"
        value={shownInput}
        placeholder="/path/on/the/host"
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          handlePickerFieldKeys(event, {
            addCurrent,
            canGoBack,
            goBack,
            hasActiveRow: activeIndex !== null,
            openSelectedRow: onOpenSelectedRow,
            moveSelection,
          });
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="remote-folder-picker-add"
        disabled={addTarget === null}
        onClick={addCurrent}
      >
        {createDirectory ? "Create & Add" : "Add"}
        <ShortcutHint>
          {activeIndex === null ? (
            <Kbd aria-hidden>↵</Kbd>
          ) : (
            <KbdGroup aria-hidden>
              <Kbd>{modLabel()}</Kbd>
              <Kbd>↵</Kbd>
            </KbdGroup>
          )}
        </ShortcutHint>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="md:hidden"
        aria-label="Close folder picker"
        onClick={onClose}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

function RemoteFolderPickerFooter(props: {
  readonly activeIndex: number | null;
  readonly chooseNatively: () => Promise<void>;
  readonly nativePickerDisabledReason: string | null;
  readonly rowCount: number;
  readonly showHiddenFolders: boolean;
  readonly upPath: string | null;
  readonly onShowHiddenFoldersChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-border/60 px-3 py-2 text-ui-xs text-muted-foreground">
      {/* Hide the whole legend, not just its caps, when shortcut hints are
          unavailable. The footer actions remain independently reachable at
          the right edge. */}
      <ShortcutHint>
        <div className="hidden min-w-0 flex-wrap items-center gap-x-3 gap-y-1 min-[36rem]:flex">
          {props.rowCount > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> Navigate
            </span>
          ) : null}
          {props.activeIndex !== null ? (
            <span className="inline-flex items-center gap-1">
              <Kbd>⏎</Kbd> Open
            </span>
          ) : null}
          {props.upPath !== null ? (
            <span className="inline-flex items-center gap-1">
              <Kbd>⌫</Kbd> Back
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <Kbd>Esc</Kbd> Close
          </span>
        </div>
      </ShortcutHint>
      <div className="ml-auto flex shrink-0 items-center justify-end gap-1">
        <TooltipWrapper
          label={props.nativePickerDisabledReason}
          side="top"
          sideOffset={4}
          align="end"
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-disabled={
              props.nativePickerDisabledReason === null ? undefined : true
            }
            data-testid="remote-folder-picker-native"
            onClick={() => {
              void props.chooseNatively();
            }}
          >
            Open native picker
          </Button>
        </TooltipWrapper>
        <Popover>
          <PopoverTrigger asChild>
            <TooltipWrapper
              label="Folder picker settings"
              side="top"
              sideOffset={4}
              align="end"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Folder picker settings"
              >
                <Settings2 aria-hidden />
              </Button>
            </TooltipWrapper>
          </PopoverTrigger>
          <PopoverContent
            side="right"
            sideOffset={8}
            align="end"
            className="w-[min(86vw,16rem)]"
          >
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="folder-picker-show-hidden"
                className="text-ui-sm font-medium"
              >
                Show hidden folders
              </label>
              <Switch
                id="folder-picker-show-hidden"
                checked={props.showHiddenFolders}
                onCheckedChange={props.onShowHiddenFoldersChange}
              />
            </div>
          </PopoverContent>
        </Popover>
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
    <div className="pb-2" data-testid="remote-folder-picker-recents">
      <p className="px-2 pb-1 text-ui-xs text-muted-foreground">Recent</p>
      <div className="flex flex-col">
        {props.entries.map((entry) => (
          <FilePathTooltip key={entry.path} content={entry.path} side="bottom">
            <Button
              type="button"
              variant="ghost"
              className="h-10 w-full min-w-0 justify-start gap-2 px-2 font-normal"
              data-testid="remote-folder-picker-recent"
              // Keep focus (and the keyboard model) on the combobox field.
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                props.onPick(entry.path);
              }}
            >
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <StartTruncatedText className="block min-w-0 flex-1">
                {entry.path}
              </StartTruncatedText>
            </Button>
          </FilePathTooltip>
        ))}
      </div>
    </div>
  );
}

function RemoteFolderPickerListing(props: {
  readonly invalid: boolean;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly entries: ReadonlyArray<WorkspaceBrowseFolderEntryV11> | undefined;
  readonly upPresent: boolean;
  readonly activeIndex: number | null;
  readonly hideEmptyMessage: boolean;
  readonly onActivate: (index: number | null) => void;
  readonly onUp: () => void;
  readonly onEnter: (entry: WorkspaceBrowseFolderEntryV11) => void;
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
          aria-selected={props.activeIndex === 0}
          className={cn(
            "h-10 w-full justify-start gap-2 px-2",
            props.activeIndex === 0 && "bg-accent",
          )}
          data-testid="remote-folder-picker-up-row"
          // Keep focus (and the keyboard model) on the combobox field.
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onMouseEnter={() => {
            props.onActivate(0);
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
            aria-selected={props.activeIndex === index + offset}
            className={cn(
              "h-10 w-full justify-start gap-2 px-2",
              props.activeIndex === index + offset && "bg-accent",
            )}
            data-testid="remote-folder-picker-row"
            // Keep focus (and the keyboard model) on the combobox field.
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onMouseEnter={() => {
              props.onActivate(index + offset);
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
        onMouseLeave={() => {
          props.onActivate(null);
        }}
      >
        {rows}
      </ul>
      <RemoteFolderPickerListingStatus
        invalid={props.invalid}
        isPending={props.isPending}
        error={props.error}
        entries={props.entries}
        hideEmptyMessage={props.hideEmptyMessage}
        onRetry={props.onRetry}
      />
    </>
  );
}

function RemoteFolderPickerListingStatus(props: {
  readonly invalid: boolean;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly entries: ReadonlyArray<WorkspaceBrowseFolderEntryV11> | undefined;
  readonly hideEmptyMessage: boolean;
  readonly onRetry: () => void;
}): ReactNode {
  const pending =
    !props.invalid &&
    props.error === null &&
    (props.isPending || props.entries === undefined);

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
  if (pending) {
    return (
      <div
        className="flex animate-in flex-col gap-1 fade-in-0 fill-mode-backwards delay-150 duration-150 motion-reduce:duration-0"
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
  if (props.entries?.length === 0 && !props.hideEmptyMessage) {
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

function readNativePickerDisabledReason(
  pending: boolean,
  hostKind: HostKind | null,
  canPickNatively: boolean,
): string | null {
  if (pending) return "The system folder picker is already open.";
  if (hostKind === null) return "Choose a host first.";
  if (hostKind === "remote") {
    return "Switch to this computer's host to use the system folder picker.";
  }
  return canPickNatively
    ? null
    : "The system folder picker is unavailable in this app.";
}

function readNextSelectionIndex(
  activeIndex: number | null,
  delta: number,
  rowCount: number,
): number {
  if (activeIndex === null) return delta > 0 ? 0 : rowCount - 1;
  return Math.min(Math.max(activeIndex + delta, 0), rowCount - 1);
}

/**
 * Keyboard model on the path field (the dialog auto-focuses it): arrows move
 * the row selection, Enter opens the active row or commits the current path,
 * and cmd/ctrl+Enter always commits. At the end of an exact directory path,
 * Backspace walks up one level.
 */
function handlePickerFieldKeys(
  event: KeyboardEvent<HTMLInputElement>,
  actions: {
    readonly addCurrent: () => void;
    readonly canGoBack: boolean;
    readonly goBack: () => void;
    readonly hasActiveRow: boolean;
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
    if (actions.hasActiveRow) actions.openSelectedRow();
    else actions.addCurrent();
    return;
  }
  if (
    event.key === "Backspace" &&
    actions.canGoBack &&
    event.currentTarget.selectionStart === event.currentTarget.value.length &&
    event.currentTarget.selectionEnd === event.currentTarget.value.length &&
    event.currentTarget.value.endsWith(separatorOf(event.currentTarget.value))
  ) {
    event.preventDefault();
    actions.goBack();
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
