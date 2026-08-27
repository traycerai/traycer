import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CornerLeftUp, Folder, Settings2 } from "lucide-react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostKind } from "@traycer-clients/shared/host-client/host-directory";
import type {
  WorkspaceBrowseFolderEntryV11,
  WorkspaceBrowseFoldersResponseV11,
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { hostQueryKeys } from "@/lib/query-keys";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { Switch } from "@/components/ui/switch";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  FullPathSheet,
  HighlightedName,
  TailAnchoredPath,
} from "@/components/folder-picker-path-view";
import { RemoteFolderPickerHeader } from "@/components/remote-folder-picker-header";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { useLongPress } from "@/hooks/ui/use-long-press";
import {
  fuzzyMatchNames,
  type FuzzyMatch,
  type FuzzyRange,
} from "@/lib/fuzzy-folder-match";
import {
  commonBasePath,
  isAbsolutePath,
  lastSeparatorIndex,
  relativeTo,
  rootLengthOf,
  separatorOf,
  tildeCollapse,
} from "@/lib/path-display";
import { useWorkspaceBrowseFolders } from "@/hooks/workspace/use-workspace-browse-folders-query";
import { useWorkspaceGetHomeDir } from "@/hooks/workspace/use-workspace-get-home-dir-query";
import { useWorkspaceListRecentWorkspaces } from "@/hooks/workspace/use-workspace-list-recent-workspaces-query";
import {
  useHostNegotiatedMethodVersion,
  type NegotiatedMethodVersion,
} from "@/hooks/host/use-host-negotiated-method-version";
import {
  useRemoteFolderPickerStore,
  type FolderPickerIntent,
} from "@/stores/workspace/remote-folder-picker-store";

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
        className="top-[18svh] flex h-[min(80dvh,36rem,calc(100dvh-18svh-var(--safe-area-inset-bottom)))] w-full max-w-[min(90vw,40rem,var(--safe-area-width))] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(90vw,40rem,var(--safe-area-width))]"
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
  const showHiddenFolders = useRemoteFolderPickerStore(
    (state) => state.showHiddenFolders,
  );
  const setShowHiddenFolders = useRemoteFolderPickerStore(
    (state) => state.setShowHiddenFolders,
  );
  // The requester's client (tab-bound where the pick started in a tab) - the
  // dialog must browse the same host the picked path is submitted to.
  const client = useRemoteFolderPickerStore((state) => state.client);
  const prepareFoldersVersion = useHostNegotiatedMethodVersion(
    client,
    "workspace.prepareFolders",
  );
  // null = not edited yet; the field then shows the host home once known.
  const [rawInput, setRawInput] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(UNSET_SELECTION);
  /** Long-press target: the one path shown in full, verbatim. */
  const [fullPath, setFullPath] = useState<string | null>(null);
  // The host's home, learned from the root (null-path) response; anchors `~`.
  const [homePath, setHomePath] = useState<string | null>(null);
  /** Bumped to pull focus back to the path field; see the header. */
  const [focusPathToken, setFocusPathToken] = useState(0);
  // Mount focus is for a keyboard, not a thumb: on a phone it raises the
  // on-screen keyboard over the listing the dialog was opened to read.
  const coarsePointer = useCoarsePointer();

  const requestPathFocus = (): void => {
    setFocusPathToken((token) => token + 1);
  };

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
  // bails out of preserving the `matches` memo below.
  const effectiveHome = homePath ?? homeDirQuery.data?.homeDir ?? null;

  const parsed = parseBrowseInput(rawInput, effectiveHome);
  const browseQuery = useWorkspaceBrowseFolders({
    client,
    directoryPath: parsed.directoryPath,
    enabled: parsed.valid,
  });
  const data = parsed.valid ? browseQuery.data : undefined;
  // A FAILED REFETCH keeps the last successful `data` in the cache (this
  // query is `staleTime: 10_000`, so stepping back into a directory serves
  // cache and refetches behind it). The listing renders no rows at all while
  // this is set, so navigation has to agree with what is on screen - counting
  // the stale rows below would let the arrow keys address option ids that are
  // not rendered and let Enter open a directory the user cannot see.
  const listingError = parsed.valid ? browseQuery.error : null;

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
  const matches = useMemo(
    () =>
      matchEntries(
        listingError !== null ? undefined : data?.entries,
        parsed.filter,
        showHiddenFolders,
      ),
    [listingError, data?.entries, parsed.filter, showHiddenFolders],
  );
  const upPath = readUpPath(data, parsed);
  // `..` is navigation, not a result: while the path's final segment is
  // filtering rows, a parent directory is not one of those results.
  const upRowPresent = upPath !== null && parsed.filter === "";
  const { rowCount, clampedIndex } = readRowSelection({
    selectedIndex,
    upRowPresent,
    matchCount: matches.length,
  });

  const setPath = (path: string): void => {
    setRawInput(path);
    setSelectedIndex(UNSET_SELECTION);
  };

  const enterEntry = (entry: WorkspaceBrowseFolderEntryV11): void => {
    setPath(withTrailingSeparator(entry.path));
  };

  const goUp = (): void => {
    if (upPath === null) return;
    setRawInput(withTrailingSeparator(upPath));
    setSelectedIndex(0);
  };

  const { addTarget, createDirectory } = readFolderPickerAddState({
    canCreateDirectory: supportsCreateDirectory(prepareFoldersVersion),
    rawInput,
    parsed,
    data,
    listingError,
    homePath: effectiveHome,
  });

  const addCurrent = (): void => {
    const selection = readFolderPickerSelection(addTarget, createDirectory);
    if (selection !== null) settle(selection);
  };

  const nativePicker = useRemoteFolderPickerNative({
    canRefresh: parsed.valid,
    refetch: browseQuery.refetch,
  });

  const openSelectedRow = (): void => {
    if (upRowPresent && clampedIndex === 0) {
      goUp();
      return;
    }
    const match = matches.at(clampedIndex - (upRowPresent ? 1 : 0));
    if (match !== undefined) enterEntry(match.item);
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
    <div className="flex min-h-0 flex-1 flex-col">
      <RemoteFolderPickerHeader
        activeOptionId={rowCount > 0 ? pickerOptionId(clampedIndex) : undefined}
        addDisabled={addTarget === null}
        addLabel={createDirectory ? "Create & Add" : "Add"}
        onAdd={addCurrent}
        upDisabled={upPath === null}
        onUp={goUp}
        pathValue={shownInput}
        onPathChange={(next) => {
          setRawInput(next);
          setSelectedIndex(UNSET_SELECTION);
        }}
        focusPathToken={focusPathToken}
        autoFocusPath={!coarsePointer}
        onFieldKeyDown={(event) => {
          handlePickerFieldKeys(event, {
            addCurrent,
            openSelectedRow,
            moveSelection,
          });
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <RemoteFolderPickerRecents
          entries={recentEntries}
          homePath={effectiveHome}
          onShowFullPath={setFullPath}
          onPick={(path) => {
            // Picking a recent makes the field non-pristine, which unmounts
            // the whole row - including the button that was just activated.
            // `onMouseDown` keeps focus for a pointer, but a keyboard user
            // (Enter/Space) never triggers that, so focus would land nowhere
            // and the field would stop accepting typing, arrows and cmd+Enter.
            setPath(path);
            requestPathFocus();
          }}
        />
        <p className="px-2 pb-1 text-ui-xs text-muted-foreground">
          Directories
        </p>
        <RemoteFolderPickerListing
          invalid={!parsed.valid}
          isPending={parsed.valid ? browseQuery.isPending : false}
          error={listingError}
          matches={data === undefined ? undefined : matches}
          upPresent={upRowPresent}
          selectedIndex={clampedIndex}
          filtering={parsed.filter !== ""}
          homePath={effectiveHome}
          onUp={goUp}
          onEnter={enterEntry}
          onShowFullPath={setFullPath}
          onRetry={() => {
            // Retry receives focus and disappears when it succeeds - hand
            // the keyboard back to the combobox field either way.
            void browseQuery.refetch().finally(() => {
              requestPathFocus();
            });
          }}
        />
      </div>
      <RemoteFolderPickerFooter
        activeIndex={clampedIndex}
        chooseNatively={nativePicker.chooseNatively}
        nativePickerDisabledReason={nativePicker.nativePickerDisabledReason}
        rowCount={rowCount}
        showHiddenFolders={showHiddenFolders}
        upPath={upPath}
        onShowHiddenFoldersChange={(checked) => {
          setSelectedIndex(UNSET_SELECTION);
          setShowHiddenFolders(checked);
        }}
      />
      <FullPathSheet
        path={fullPath}
        onClose={() => {
          setFullPath(null);
        }}
      />
    </div>
  );
}

function readFolderPickerAddState(args: {
  readonly canCreateDirectory: boolean;
  readonly rawInput: string | null;
  readonly parsed: ParsedBrowseInput;
  readonly data: WorkspaceBrowseFoldersResponseV11 | undefined;
  readonly listingError: Error | null;
  readonly homePath: string | null;
}): { readonly addTarget: string | null; readonly createDirectory: boolean } {
  const wantsCreateDirectory =
    args.rawInput !== null &&
    args.parsed.valid &&
    args.parsed.filter !== "" &&
    args.parsed.filter !== "." &&
    args.parsed.filter !== ".." &&
    args.data !== undefined &&
    args.listingError === null &&
    !args.data.entries.some((entry) => entry.name === args.parsed.filter);
  if (wantsCreateDirectory && !args.canCreateDirectory) {
    return { addTarget: null, createDirectory: false };
  }
  return {
    addTarget: readAddTarget(args.rawInput, args.homePath, args.data),
    createDirectory: wantsCreateDirectory,
  };
}

function supportsCreateDirectory(version: NegotiatedMethodVersion): boolean {
  // `createAndPrepare` is a v1 extension of this exact contract. A future
  // major may redefine the operation envelope, so do not treat it as
  // create-capable until that major has an explicit renderer gate.
  return (
    version !== null &&
    version !== false &&
    version.major === 1 &&
    version.minor >= 3
  );
}

function readFolderPickerSelection(
  addTarget: string | null,
  createDirectory: boolean,
): FolderPickerIntent | null {
  if (addTarget === null) return null;
  return createDirectory
    ? { kind: "createAndPrepare" as const, path: addTarget }
    : { kind: "prepare" as const, folderPaths: [addTarget] };
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

function isCurrentPickerRequest(requestId: number): boolean {
  const picker = useRemoteFolderPickerStore.getState();
  return picker.open && picker.requestId === requestId;
}

function readNativePickerDisabledReason(
  pending: boolean,
  hostKind: HostKind | null,
  canPickNatively: boolean,
): string | null {
  if (pending) return "Opening native picker…";
  if (hostKind === null) return "Select a host first.";
  if (hostKind !== "local" && hostKind !== "mock") {
    return "Native picker is only available for local hosts.";
  }
  if (!canPickNatively) return "Native picker is unavailable in this app.";
  return null;
}

function RemoteFolderPickerFooter(props: {
  readonly activeIndex: number;
  readonly chooseNatively: () => Promise<void>;
  readonly nativePickerDisabledReason: string | null;
  readonly rowCount: number;
  readonly showHiddenFolders: boolean;
  readonly upPath: string | null;
  readonly onShowHiddenFoldersChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-border/60 px-3 py-2 text-ui-xs text-muted-foreground">
      <ShortcutHint>
        <div className="hidden min-w-0 items-center gap-x-3 min-[42rem]:flex">
          {props.rowCount > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> Navigate
            </span>
          ) : null}
          {props.rowCount > 0 && props.activeIndex >= 0 ? (
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
 * States the base a group of rows shares, so no row has to repeat it. Falls
 * back to a plain group label when there is no base worth naming — the rows
 * then carry their own full paths and this line would be a lie.
 */
function PathGroupHeader(props: {
  readonly label: string;
  readonly basePath: string | null;
  readonly fallback: string;
}): ReactNode {
  return (
    <p
      className="flex min-w-0 items-baseline gap-1 px-2 pb-1 text-ui-xs text-muted-foreground"
      data-testid="remote-folder-picker-group-header"
    >
      {props.basePath === null ? (
        props.fallback
      ) : (
        <>
          <span className="shrink-0">{props.label}</span>
          <TailAnchoredPath
            path={props.basePath}
            className="min-w-0 flex-1 font-mono"
          />
        </>
      )}
    </p>
  );
}

/**
 * One folder row: the name, and nothing else.
 *
 * A second dimmed line carrying each row's own path was tried and dropped —
 * inside one folder every such line repeats the same prefix, so a column of
 * them is duplication rather than information, and each row truncating at a
 * different character makes the block read as noise. The heading above states
 * the location once; long-press produces the absolute path on demand.
 */
function PickerRow(props: {
  readonly name: string;
  readonly ranges: ReadonlyArray<FuzzyRange>;
  /** Listbox options carry an id and selection; the recents strip does not. */
  readonly option: { readonly id: string; readonly selected: boolean } | null;
  readonly testId: string;
  readonly icon: ReactNode;
  readonly onOpen: () => void;
  readonly onShowFullPath: () => void;
}): ReactNode {
  const longPress = useLongPress({
    onLongPress: props.onShowFullPath,
    disabled: false,
  });
  return (
    <Button
      type="button"
      variant="ghost"
      tabIndex={-1}
      role={props.option === null ? undefined : "option"}
      id={props.option?.id}
      aria-selected={props.option?.selected}
      className={cn(
        "h-10 w-full justify-start gap-2 px-2 hover:bg-foreground/8",
        props.option?.selected === true &&
          "bg-foreground/8 hover:bg-foreground/8",
      )}
      data-testid={props.testId}
      // Keep focus (and the keyboard model) on the combobox field.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      {...longPress.handlers}
      onClick={() => {
        // The long-press already answered this gesture; picking as well
        // would move the user off the row they were inspecting.
        if (longPress.consumedTap()) return;
        props.onOpen();
      }}
    >
      {props.icon}
      <HighlightedName
        name={props.name}
        ranges={props.ranges}
        className="min-w-0 flex-1 truncate text-left font-normal"
      />
    </Button>
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
  readonly homePath: string | null;
  readonly onPick: (path: string) => void;
  readonly onShowFullPath: (path: string) => void;
}): ReactNode {
  const paths = props.entries.map((entry) => entry.path);
  // Recents are the case the relative treatment exists for: a dozen worktrees
  // under one directory, whose full paths differ only in the last segment.
  const base = commonBasePath(paths);
  if (props.entries.length === 0) return null;
  return (
    <div data-testid="remote-folder-picker-recents" className="pb-3">
      <PathGroupHeader
        label="Recent, under"
        basePath={base === null ? null : tildeCollapse(base, props.homePath)}
        fallback="Recent"
      />
      <ul className="flex flex-col">
        {props.entries.map((entry) => {
          // Relative when it sits under the shared base, otherwise the whole
          // path — a row is never shown a name it does not own.
          const relative = base === null ? null : relativeTo(entry.path, base);
          return (
            <li key={entry.path} role="presentation">
              <PickerRow
                name={relative ?? tildeCollapse(entry.path, props.homePath)}
                ranges={[]}
                option={null}
                testId="remote-folder-picker-recent"
                icon={
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                }
                onOpen={() => {
                  props.onPick(entry.path);
                }}
                onShowFullPath={() => {
                  props.onShowFullPath(entry.path);
                }}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RemoteFolderPickerListing(props: {
  readonly invalid: boolean;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly matches:
    | ReadonlyArray<FuzzyMatch<WorkspaceBrowseFolderEntryV11>>
    | undefined;
  readonly upPresent: boolean;
  readonly selectedIndex: number;
  readonly filtering: boolean;
  readonly homePath: string | null;
  readonly onUp: () => void;
  readonly onEnter: (entry: WorkspaceBrowseFolderEntryV11) => void;
  readonly onShowFullPath: (path: string) => void;
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
            "h-10 w-full justify-start gap-2 px-2 hover:bg-foreground/8",
            props.selectedIndex === 0 &&
              "bg-foreground/8 hover:bg-foreground/8",
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
  (props.error === null ? (props.matches ?? []) : []).forEach(
    (match, index) => {
      rows.push(
        <li key={match.item.path} role="presentation">
          <PickerRow
            name={match.item.name}
            ranges={match.ranges}
            option={{
              id: pickerOptionId(index + offset),
              selected: props.selectedIndex === index + offset,
            }}
            testId="remote-folder-picker-row"
            icon={<Folder className="size-4 shrink-0 text-muted-foreground" />}
            onOpen={() => {
              props.onEnter(match.item);
            }}
            onShowFullPath={() => {
              props.onShowFullPath(match.item.path);
            }}
          />
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
        matches={props.matches}
        filtering={props.filtering}
        onRetry={props.onRetry}
      />
    </>
  );
}

function RemoteFolderPickerListingStatus(props: {
  readonly invalid: boolean;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly matches:
    | ReadonlyArray<FuzzyMatch<WorkspaceBrowseFolderEntryV11>>
    | undefined;
  readonly filtering: boolean;
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
  if (props.isPending || props.matches === undefined) {
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
  if (props.matches.length === 0) {
    return (
      <p className="p-2 text-ui-sm text-muted-foreground">
        {props.filtering ? "Nothing here matches." : "No subfolders."}
      </p>
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

/**
 * "No row has been chosen yet." Distinct from index 0 so the resting
 * selection can land on the first real folder rather than on "..".
 */
const UNSET_SELECTION = -1;

interface RowSelection {
  /** Rows actually painted, `..` included when it is showing. */
  readonly rowCount: number;
  /** Highlighted row, always inside the painted range. */
  readonly clampedIndex: number;
}

/**
 * Resolve which row is highlighted.
 *
 * An untouched selection rests on the first real FOLDER, never on `..`: "go
 * up" is a poor default for Enter, and on a touch device the resting fill is
 * the only thing that highlight communicates - pointing it at the parent row
 * reads as though something had already been chosen.
 */
function readRowSelection(args: {
  readonly selectedIndex: number;
  readonly upRowPresent: boolean;
  readonly matchCount: number;
}): RowSelection {
  const rowCount = (args.upRowPresent ? 1 : 0) + args.matchCount;
  const resting = args.upRowPresent ? 1 : 0;
  const wanted =
    args.selectedIndex === UNSET_SELECTION ? resting : args.selectedIndex;
  return {
    rowCount,
    clampedIndex: Math.min(wanted, Math.max(rowCount - 1, 0)),
  };
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
  recentsData:
    | Pick<WorkspacePrepareFoldersResponseV12, "recentWorkspaces">
    | undefined,
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
  data: WorkspaceBrowseFoldersResponseV11 | undefined,
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
  data: WorkspaceBrowseFoldersResponseV11 | undefined,
  parsed: ParsedBrowseInput,
): string | null {
  if (data !== undefined) return data.parentPath;
  if (parsed.valid && parsed.directoryPath !== null) {
    return parentOf(parsed.directoryPath);
  }
  return null;
}

/**
 * Rank the listing against the active filter. The host sends hidden (dot)
 * directories too; they surface only while the filter itself starts with "."
 * — a rule that has to be applied BEFORE matching, because a subsequence
 * match would otherwise pull dotfiles in on any query sharing their letters.
 */
function matchEntries(
  entries: ReadonlyArray<WorkspaceBrowseFolderEntryV11> | undefined,
  filter: string,
  showHiddenFolders: boolean,
): ReadonlyArray<FuzzyMatch<WorkspaceBrowseFolderEntryV11>> {
  if (entries === undefined) return [];
  const showHidden = showHiddenFolders || filter.startsWith(".");
  const visible = showHidden
    ? entries
    : entries.filter((entry) => !entry.hidden && !entry.name.startsWith("."));
  return fuzzyMatchNames(visible, (entry) => entry.name, filter);
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
  data: WorkspaceBrowseFoldersResponseV11 | undefined,
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
