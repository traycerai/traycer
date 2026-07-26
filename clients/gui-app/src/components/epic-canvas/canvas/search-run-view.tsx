/**
 * STEP 2 of the opener's two-step content search: the query + options + results
 * surface. The pane opener renders this (instead of the generic fuzzy list) for
 * a `open:search:run:*` sub-page, with cmdk's own filtering DISABLED - content
 * search is literal/regex, never a fuzzy filter over the pattern.
 *
 * Both targets run through ONE `workspace.searchText` flow (one options bar, one
 * debounced query, one set of guards), differing only in source + open:
 *  - Code (`reference: { root }`): ripgrep over one authorized workspace root; a
 *    match opens the file preview and reveals the matched line/column.
 *  - Artifact (`reference: { kind: "epic-artifacts" }`): ripgrep over the Epic's
 *    on-disk artifact mirror. A match carries a LOGICAL artifact path; opening
 *    re-resolves it against authoritative live Yjs state (by id + kind) and fails
 *    safe on a stale/deleted hit - it never opens the editable mirror Markdown.
 *
 * Late results are guarded twice: the TanStack key scopes by
 * epic/host/source/query/options, and the response echoes `epicId` plus its
 * source (`root` for code, `source` for artifacts), re-checked here so a payload
 * that crosses a target/source change is dropped.
 */
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { v4 as uuidv4 } from "uuid";
import { toast } from "sonner";
import { CommandGroup } from "@/components/ui/command";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { PaletteItemRow } from "@/components/command-palette/palette-item-row";
import { usePaletteLiveQuery } from "@/lib/commands/palette-query-context";
import { useHostClient } from "@/lib/host";
import type { HostRpcRegistry } from "@/lib/host";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useWorkspaceSearchText } from "@/hooks/workspace/use-workspace-search-text-query";
import {
  highlightSegmentsFromByteRanges,
  type SnippetByteRange,
} from "@/lib/artifacts/highlight-byte-ranges";
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import { parseGlobs } from "@/lib/commands/sources/open/parse-globs";
import { useArtifactPathResolver } from "@/lib/commands/sources/open/artifact-path-resolver";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { workspaceFileRefFromTreePath } from "@/components/epic-canvas/workspace-file/workspace-file-ref";
import { setWorkspaceFileRevealTarget } from "@/stores/epics/canvas/workspace-file-reveal-store";
import { getBasename } from "@/lib/path/cross-platform-path";
import { isOpenableEpicNodeKind } from "@/stores/epics/canvas/types";
import { cn } from "@/lib/utils";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  WorkspaceSearchSource,
  WorkspaceSearchTextMatch,
  WorkspaceSearchTextOptions,
} from "@traycer/protocol/host/workspace/unary-schemas";
import type { CommandContext } from "@/lib/commands/types";
import type { SearchRunTarget } from "@/lib/commands/sources/open/search-target";

export interface SearchRunViewProps {
  readonly target: SearchRunTarget;
  readonly ctx: CommandContext;
}

export function SearchRunView({ target, ctx }: SearchRunViewProps) {
  return <SearchRun target={target} ctx={ctx} />;
}

/**
 * Coalesce rapid typing before it feeds a search hook: each keystroke restarts a
 * short timer and only the settled value reaches the query key / RPC, so a fast
 * typist spawns ONE ripgrep run per pause instead of one per keystroke. Clearing
 * (an empty/whitespace query) short-circuits the timer and takes effect
 * immediately, so back/clear stays instant. Only the query is debounced -
 * options, target, Epic, and host stay in the key/guards and change at once.
 */
const SEARCH_QUERY_DEBOUNCE_MS = 150;

function useDebouncedSearchQuery(query: string): string {
  const debounced = useDebouncedValue(query, SEARCH_QUERY_DEBOUNCE_MS);
  return query.trim().length === 0 ? "" : debounced;
}

// ─── shared presentation ─────────────────────────────────────────────────────

function StatusRow({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-3 py-6 text-center text-ui-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function Searching() {
  return (
    <StatusRow>
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
      />
      <span>Searching…</span>
    </StatusRow>
  );
}

/** True when the optional method is unsupported by an older host (degrade path). */
function isHostUnsupported(error: HostRpcError | null): boolean {
  return (
    error !== null &&
    (error.code === "E_HOST_UNSUPPORTED" ||
      error.code === "DOWNGRADE_UNSUPPORTED")
  );
}

function HighlightedText({
  text,
  ranges,
}: {
  readonly text: string;
  readonly ranges: ReadonlyArray<SnippetByteRange>;
}) {
  // Segments partition the line left-to-right; each carries its own char-index
  // `start` (a distinct offset per segment), so `start` is a stable, unique key
  // without re-deriving it - alternating highlighted/plain segments never collide.
  const keyed = useMemo(() => {
    const segments = highlightSegmentsFromByteRanges(text, ranges);
    return segments.map((segment) => ({
      ...segment,
      key: `${segment.start}:${segment.highlighted ? 1 : 0}`,
    }));
  }, [text, ranges]);
  return (
    <>
      {keyed.map((segment) => (
        <span
          key={segment.key}
          className={cn(
            segment.highlighted &&
              "rounded-[2px] bg-primary/20 text-foreground",
          )}
        >
          {segment.text}
        </span>
      ))}
    </>
  );
}

function TruncatedHint() {
  return (
    <div className="px-3 py-1.5 text-ui-xs text-muted-foreground">
      Showing the first matches — refine the query to narrow results.
    </div>
  );
}

// ─── unified text search (workspace.searchText: code + artifact) ─────────────

function SearchRun({
  target,
  ctx,
}: {
  readonly target: SearchRunTarget;
  readonly ctx: CommandContext;
}) {
  const client = useHostClient();
  const defaultHostId = useReactiveActiveHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  const resolveArtifact = useArtifactPathResolver(ctx.activeEpicId);
  const query = usePaletteLiveQuery();
  const trimmed = query.trim();
  const debouncedQuery = useDebouncedSearchQuery(query);
  // Source-of-truth option state. Globs are edited as raw text and normalized
  // into arrays for the request; this state is reset by remount (the pane opener
  // keys `SearchRunView` on the target sub-page id, so switching target or
  // backing out and re-entering starts fresh).
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [includeText, setIncludeText] = useState("");
  const [excludeText, setExcludeText] = useState("");
  const options = useMemo<WorkspaceSearchTextOptions>(
    () => ({
      regex,
      caseSensitive,
      wholeWord,
      includeGlobs: parseGlobs(includeText),
      excludeGlobs: parseGlobs(excludeText),
    }),
    [regex, caseSensitive, wholeWord, includeText, excludeText],
  );

  // The typed source: an attached code root, or the opaque Epic-artifact mirror.
  // Memoized so its identity is stable across keystrokes (only a target change,
  // which remounts, mints a new one).
  const reference = useMemo<WorkspaceSearchSource>(
    () =>
      target.kind === "artifact"
        ? { kind: "epic-artifacts" }
        : { root: target.root },
    [target],
  );

  const epicId = ctx.activeEpicId ?? "";
  const result = useWorkspaceSearchText({
    client,
    epicId,
    reference,
    query: debouncedQuery,
    options,
    enabled: ctx.activeEpicId !== null,
  });

  // Late-result guard: only render a payload whose epic AND source echo still
  // match this target, so a response cannot cross a query/option/source/epic/host
  // change (the TanStack key already scopes those; this is the belt-and-braces).
  const data = matchingData(result.data, epicId, target);

  const openCodeMatch = (
    relPath: string,
    line: number,
    column: number,
  ): void => {
    if (ctx.activeTabId === null || target.kind !== "code") return;
    const ref = workspaceFileRefFromTreePath(
      target.hostId,
      target.root,
      relPath,
      getBasename(relPath),
    );
    if (ref === null) return;
    // Record the reveal BEFORE opening so the (possibly new) preview tile reads
    // it on mount and scrolls to the match.
    setWorkspaceFileRevealTarget(ctx.activeTabId, ref.id, line, column);
    openTileIntoTargetGroup({
      tabId: ctx.activeTabId,
      groupId: ctx.targetGroupId,
      ref,
      navigateNestedFocus: ctx.router.navigateNestedFocus,
    });
  };

  const openArtifactMatch = (logicalPath: string): void => {
    if (ctx.activeTabId === null) return;
    // Re-resolve the LOGICAL disk path against authoritative live Yjs state. A
    // stale/deleted hit (no live artifact at that path, or a non-openable kind)
    // fails safe: never open the mirror Markdown as a workspace file.
    const resolved = resolveArtifact(logicalPath);
    if (resolved === null || !isOpenableEpicNodeKind(resolved.kind)) {
      toast("Couldn’t open artifact — it may have moved or been deleted.");
      return;
    }
    openTileIntoTargetGroup({
      tabId: ctx.activeTabId,
      groupId: ctx.targetGroupId,
      ref: {
        id: resolved.id,
        instanceId: uuidv4(),
        type: resolved.kind,
        name:
          resolved.title.length > 0
            ? resolved.title
            : `Untitled ${resolved.kind}`,
        hostId: defaultHostId,
      },
      navigateNestedFocus: ctx.router.navigateNestedFocus,
    });
  };

  const sourceLabel =
    target.kind === "artifact" ? "Artifacts" : getBasename(target.root);

  const renderBody = () => {
    if (trimmed.length === 0) {
      return <StatusRow>Type to search {sourceLabel}.</StatusRow>;
    }
    if (result.isError) {
      return (
        <StatusRow>
          {isHostUnsupported(result.error)
            ? "Text search isn’t available on this host."
            : "Search failed."}
        </StatusRow>
      );
    }
    if (data === undefined) return <Searching />;
    if (data.outcome === "root_unavailable") {
      return (
        <StatusRow>
          {target.kind === "artifact"
            ? "Artifacts aren’t available yet."
            : "This workspace is no longer available."}
        </StatusRow>
      );
    }
    if (data.outcome === "invalid_regex") {
      return <StatusRow>Invalid regular expression.</StatusRow>;
    }
    if (data.results.length === 0) return <StatusRow>No matches.</StatusRow>;
    return (
      <>
        <CommandGroup heading={sourceLabel}>
          {data.results.map((match) => (
            <SearchResultRow
              key={`${match.relPath}:${match.lineNumber}:${match.column}`}
              target={target}
              match={match}
              artifactTitle={
                target.kind === "artifact"
                  ? (resolveArtifact(match.relPath)?.title ?? null)
                  : null
              }
              onOpen={() =>
                target.kind === "artifact"
                  ? openArtifactMatch(match.relPath)
                  : openCodeMatch(match.relPath, match.lineNumber, match.column)
              }
            />
          ))}
        </CommandGroup>
        {data.truncated ? <TruncatedHint /> : null}
      </>
    );
  };

  return (
    <>
      <SearchOptionsBar
        regex={regex}
        caseSensitive={caseSensitive}
        wholeWord={wholeWord}
        includeText={includeText}
        excludeText={excludeText}
        artifactSource={target.kind === "artifact"}
        onRegex={setRegex}
        onCaseSensitive={setCaseSensitive}
        onWholeWord={setWholeWord}
        onIncludeText={setIncludeText}
        onExcludeText={setExcludeText}
      />
      {renderBody()}
    </>
  );
}

/**
 * The response is a union: a code (`root`) branch and an artifact (`source`)
 * branch. Keep only a payload whose epic AND source echo match THIS target, so a
 * late response from a previous target/source is dropped rather than rendered.
 */
function matchingData(
  data: ResponseOfMethod<HostRpcRegistry, "workspace.searchText"> | undefined,
  epicId: string,
  target: SearchRunTarget,
): ResponseOfMethod<HostRpcRegistry, "workspace.searchText"> | undefined {
  if (data === undefined || data.epicId !== epicId) return undefined;
  // `"source" in data` selects the artifact response branch; `"root" in data`
  // the attached-root branch. The wrong branch for this target is a stale echo.
  if (target.kind === "artifact") {
    return "source" in data ? data : undefined;
  }
  return "root" in data && data.root === target.root ? data : undefined;
}

interface SearchResultRowProps {
  readonly target: SearchRunTarget;
  readonly match: WorkspaceSearchTextMatch;
  /** Live artifact title for an artifact match, or `null` (code / unresolved). */
  readonly artifactTitle: string | null;
  readonly onOpen: () => void;
}

function SearchResultRow({
  target,
  match,
  artifactTitle,
  onOpen,
}: SearchResultRowProps) {
  const slash = match.relPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : match.relPath.slice(0, slash + 1);
  const base = slash === -1 ? match.relPath : match.relPath.slice(slash + 1);
  return (
    <PaletteItemRow
      value={`${target.kind}:${match.relPath}:${match.lineNumber}:${match.column}`}
      keywords={[]}
      onSelect={onOpen}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {target.kind === "artifact" ? (
          // Logical artifact path (its folder chain); the resolved title, when
          // the artifact is still live, leads for readability.
          <span className="truncate text-ui-xs">
            <span className="text-foreground">
              {artifactTitle ?? match.relPath}
            </span>
            {artifactTitle !== null ? (
              <span className="ml-2 text-muted-foreground">
                {match.relPath}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="truncate text-ui-xs">
            <span className="text-muted-foreground">{dir}</span>
            <span className="text-foreground">{base}</span>
            <span className="text-muted-foreground">:{match.lineNumber}</span>
          </span>
        )}
        <span className="truncate font-mono text-ui-xs text-muted-foreground">
          <HighlightedText
            text={match.preview.text}
            ranges={match.preview.ranges}
          />
        </span>
      </div>
    </PaletteItemRow>
  );
}

// ─── options bar (shared by code + artifact) ─────────────────────────────────

interface SearchOptionsBarProps {
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly includeText: string;
  readonly excludeText: string;
  readonly artifactSource: boolean;
  readonly onRegex: (next: boolean) => void;
  readonly onCaseSensitive: (next: boolean) => void;
  readonly onWholeWord: (next: boolean) => void;
  readonly onIncludeText: (next: string) => void;
  readonly onExcludeText: (next: string) => void;
}

function SearchOptionsBar(props: SearchOptionsBarProps) {
  return (
    <div
      role="group"
      aria-label="Search options"
      className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5"
    >
      <OptionToggle
        label="Match case"
        active={props.caseSensitive}
        onToggle={() => props.onCaseSensitive(!props.caseSensitive)}
      >
        Aa
      </OptionToggle>
      <OptionToggle
        label="Match whole word"
        active={props.wholeWord}
        onToggle={() => props.onWholeWord(!props.wholeWord)}
      >
        W
      </OptionToggle>
      <OptionToggle
        label="Use regular expression"
        active={props.regex}
        onToggle={() => props.onRegex(!props.regex)}
      >
        .*
      </OptionToggle>
      <GlobInput
        label="Files to include"
        placeholder={
          props.artifactSource
            ? "include, e.g. .md, tickets/**"
            : "include, e.g. .ts, src/**"
        }
        value={props.includeText}
        onChange={props.onIncludeText}
      />
      <GlobInput
        label="Files to exclude"
        placeholder={
          props.artifactSource
            ? "exclude, e.g. drafts/**"
            : "exclude, e.g. *.test.*, dist/**"
        }
        value={props.excludeText}
        onChange={props.onExcludeText}
      />
    </div>
  );
}

// Stop a key from reaching cmdk's root handler so it acts on the focused control
// (typing, caret movement, activation) instead of moving/opening the result
// list - EXCEPT Escape, which is allowed to bubble so the pane opener's
// intentional back/return behavior still fires.
function isolateFromCmdk(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Escape") event.stopPropagation();
}

interface OptionToggleProps {
  readonly label: string;
  readonly active: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}

function OptionToggle({
  label,
  active,
  onToggle,
  children,
}: OptionToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={onToggle}
      onKeyDown={isolateFromCmdk}
      className={cn(
        "flex h-6 min-w-6 items-center justify-center rounded-sm px-1.5 font-mono text-ui-xs transition-colors",
        active
          ? "bg-primary/15 text-foreground ring-1 ring-primary/40"
          : "text-muted-foreground hover:bg-muted/55 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

interface GlobInputProps {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
}

function GlobInput({ label, placeholder, value, onChange }: GlobInputProps) {
  return (
    <input
      type="text"
      aria-label={label}
      title={`${label} (comma-separated globs)`}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={isolateFromCmdk}
      className="h-6 min-w-[7rem] flex-1 rounded-sm bg-muted/40 px-1.5 text-ui-xs outline-hidden placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-primary/40"
    />
  );
}
