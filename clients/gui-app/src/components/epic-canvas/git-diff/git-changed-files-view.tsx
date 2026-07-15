import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Search, X } from "lucide-react";
import type { GitChangedFile } from "@traycer/protocol/host";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { FileList } from "./file-list";

// Mirrors the file-tree explorer panel: the controlled input updates
// immediately while the applied query (which drives filtering) is debounced.
const GIT_PANEL_SEARCH_DEBOUNCE_MS = 150;

export interface GitChangedFilesViewProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
  readonly files: ReadonlyArray<GitChangedFile>;
}

export function GitChangedFilesView(
  props: GitChangedFilesViewProps,
): ReactNode {
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const debounceTimerRef = useRef<number | null>(null);

  const clearPendingDebounce = useCallback(() => {
    if (debounceTimerRef.current === null) return;
    window.clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;
  }, []);

  const handleSearchChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setSearchQuery(next);
      clearPendingDebounce();
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        setAppliedQuery(next);
      }, GIT_PANEL_SEARCH_DEBOUNCE_MS);
    },
    [clearPendingDebounce],
  );

  const handleClear = useCallback(() => {
    clearPendingDebounce();
    setSearchQuery("");
    setAppliedQuery("");
  }, [clearPendingDebounce]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      handleClear();
      event.currentTarget.blur();
    },
    [handleClear],
  );

  useEffect(() => clearPendingDebounce, [clearPendingDebounce]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 bg-background/50 px-2 py-1.5">
        <InputGroup className="h-7 border-transparent bg-muted/25 shadow-none focus-within:bg-muted/35">
          <InputGroupAddon align="inline-start">
            <Search className="size-3.5" aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="text"
            value={searchQuery}
            onChange={handleSearchChange}
            onKeyDown={handleKeyDown}
            placeholder="Filter changed files..."
            aria-label="Filter changed files"
            className="text-ui-sm"
          />
          {searchQuery.length > 0 ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                onClick={handleClear}
                aria-label="Clear filter"
              >
                <X className="size-3.5" aria-hidden />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
      <FileList
        epicId={props.epicId}
        viewTabId={props.viewTabId}
        hostId={props.hostId}
        runningDir={props.runningDir}
        repositoryContext={null}
        files={props.files}
        query={appliedQuery}
        onClearQuery={handleClear}
        hideEmptySections={false}
        sectionCollapseController={null}
        virtualized
      />
    </div>
  );
}
