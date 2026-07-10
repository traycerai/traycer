import { useCallback, useId, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import type {
  ProviderCliCandidate,
  ProviderCliState,
  ProviderSelection,
} from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilePathTooltip } from "@/components/file-path-tooltip";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { useProvidersSetSelection } from "@/hooks/providers/use-providers-set-selection-mutation";
import { useProvidersAddCustomPath } from "@/hooks/providers/use-providers-add-custom-path-mutation";
import { useProvidersRemoveCustomPath } from "@/hooks/providers/use-providers-remove-custom-path-mutation";
import { useProvidersDetectVersion } from "@/hooks/providers/use-providers-detect-version-query";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { cn } from "@/lib/utils";

// Grid keeps the columns aligned across header + rows; `minmax(0,1fr)` on
// the Path column guarantees it shrinks/truncates instead of pushing the
// table past the panel width.
const TABLE_GRID =
  "grid grid-cols-[2.25rem_minmax(0,1fr)_minmax(5.5rem,auto)_2.25rem] items-center";

interface ProviderCandidateConfig {
  readonly selected: ProviderSelection;
  readonly candidates: readonly ProviderCliCandidate[];
}

function candidateConfigForProvider(
  state: ProviderCliState,
  providers: readonly ProviderCliState[],
): ProviderCandidateConfig {
  const usesOpenCodeCandidates =
    state.providerId === "traycer" || state.providerId === "openrouter";
  if (!usesOpenCodeCandidates || state.candidates.length > 0) {
    return { selected: state.selected, candidates: state.candidates };
  }

  const opencode = providers.find(
    (provider) => provider.providerId === "opencode",
  );
  return {
    selected: state.selected,
    candidates: opencode?.candidates ?? state.candidates,
  };
}

function hidesCliCandidates(
  providerId: ProviderCliState["providerId"],
): boolean {
  return providerId === "cursor" || providerId === "amp";
}

/**
 * S14: the CLI-path-management subsection of `ProviderDetail` (binary
 * selection table + "Add custom path" flow), extracted so the panel stays
 * orchestration. Renders nothing for providers with no CLI-candidate concept
 * (Cursor, Amp - API-key-only). Every hook here still runs unconditionally
 * regardless of that gate, matching the original inline placement.
 */
export function ProviderCliCandidatesSection({
  state,
  providers,
}: {
  readonly state: ProviderCliState;
  readonly providers: readonly ProviderCliState[];
}): ReactNode {
  const providerId = state.providerId;
  const showCliCandidates = !hidesCliCandidates(providerId);
  const cliConfig = candidateConfigForProvider(state, providers);
  const radioName = useId();
  const [adding, setAdding] = useState(false);
  const [draftPath, setDraftPath] = useState("");
  const focusDraftInput = useCallback((node: HTMLInputElement | null): void => {
    node?.focus();
  }, []);

  const setSelection = useProvidersSetSelection();
  const addCustom = useProvidersAddCustomPath();
  const removeCustom = useProvidersRemoveCustomPath();
  // Debounce so we don't spawn a `<bin> --version` probe on every keystroke.
  const debouncedPath = useDebouncedValue(draftPath.trim(), 250);
  const probe = useProvidersDetectVersion({
    candidatePath: debouncedPath,
    enabled: adding && debouncedPath.length > 0,
  });

  const onSelect = (selection: ProviderSelection): void => {
    if (setSelection.isPending) return;
    setSelection.mutate({ providerId, selection });
  };

  const onSaveCustom = (): void => {
    const trimmed = draftPath.trim();
    if (trimmed.length === 0 || addCustom.isPending) return;
    addCustom.mutate(
      { providerId, path: trimmed },
      {
        onSuccess: () => {
          setAdding(false);
          setDraftPath("");
        },
      },
    );
  };

  if (!showCliCandidates) return null;

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border/60">
        <div
          className={cn(
            TABLE_GRID,
            "border-b border-border/40 bg-muted/30 text-ui-xs font-medium text-muted-foreground",
          )}
        >
          <span className="py-2" />
          <span className="min-w-0 p-2">Path</span>
          <span className="p-2">Version</span>
          <span className="py-2" />
        </div>
        {cliConfig.candidates.map((candidate) => (
          <CandidateRow
            key={candidateKey(candidate)}
            candidate={candidate}
            radioName={radioName}
            selected={isSelected(cliConfig.selected, candidate)}
            busy={setSelection.isPending || removeCustom.isPending}
            onSelect={onSelect}
            onRemove={(path) => removeCustom.mutate({ providerId, path })}
          />
        ))}
        {adding ? (
          <div className="flex flex-col gap-2 border-t border-border/40 bg-muted/10 p-3">
            <div className="flex items-center gap-2">
              <Input
                ref={focusDraftInput}
                className="w-full font-mono text-ui-sm"
                placeholder="/absolute/path/to/binary"
                value={draftPath}
                onChange={(e) => setDraftPath(e.target.value)}
                disabled={addCustom.isPending}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveCustom();
                  if (e.key === "Escape") {
                    setAdding(false);
                    setDraftPath("");
                  }
                }}
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={onSaveCustom}
                disabled={addCustom.isPending || draftPath.trim().length === 0}
              >
                {addCustom.isPending ? <MutedAgentSpinner /> : null}
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAdding(false);
                  setDraftPath("");
                }}
                disabled={addCustom.isPending}
              >
                Cancel
              </Button>
            </div>
            <ProbeLine
              probing={probe.isFetching}
              executable={probe.data?.executable ?? null}
              version={probe.data?.version ?? null}
            />
          </div>
        ) : null}
      </div>

      {adding ? null : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-ui-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <Plus className="size-4" /> Add custom path
        </button>
      )}
    </>
  );
}

function CandidateRow({
  candidate,
  radioName,
  selected,
  busy,
  onSelect,
  onRemove,
}: {
  readonly candidate: ProviderCliCandidate;
  readonly radioName: string;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly onSelect: (selection: ProviderSelection) => void;
  readonly onRemove: (path: string) => void;
}): ReactNode {
  const isBundled = candidate.kind === "bundled";
  const isCustom = candidate.kind === "custom";
  const pathLabel = isBundled ? "Bundled" : candidate.path;
  // A resolved-but-missing binary (custom path the user typed that no longer
  // exists, or a bundled binary not installed). We keep the row and dim it so
  // the user sees the entry is retained but unavailable.
  const unavailable = !candidate.available && !candidate.versionPending;
  return (
    <div
      className={cn(
        TABLE_GRID,
        "border-b border-border/40 last:border-b-0 hover:bg-muted/20",
        unavailable ? "opacity-60" : "",
      )}
    >
      <span className="flex items-center justify-center py-2.5">
        <input
          type="radio"
          aria-label={
            isBundled ? "Select bundled binary" : `Select ${candidate.path}`
          }
          name={radioName}
          checked={selected}
          disabled={busy}
          onChange={() => onSelect(selectionFor(candidate))}
          className="size-3.5 cursor-pointer accent-primary"
        />
      </span>
      {isBundled ? (
        <span className="min-w-0 truncate p-2.5 text-ui-sm text-foreground">
          {pathLabel}
        </span>
      ) : (
        <FilePathTooltip content={candidate.path} side="bottom">
          <StartTruncatedText className="min-w-0 p-2.5 font-mono text-ui-sm text-foreground">
            {candidate.path}
          </StartTruncatedText>
        </FilePathTooltip>
      )}
      <span
        className={cn(
          "flex items-center gap-1.5 truncate p-2.5 text-ui-sm",
          unavailable ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {candidate.versionPending ? (
          <>
            <MutedAgentSpinner />
            <span className="text-ui-xs">checking…</span>
          </>
        ) : (
          versionLabel(candidate)
        )}
      </span>
      <span className="flex items-center justify-center py-2.5">
        {isCustom ? (
          <button
            type="button"
            aria-label="Remove custom path"
            disabled={busy}
            onClick={() => onRemove(candidate.path)}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : null}
      </span>
    </div>
  );
}

function versionLabel(candidate: ProviderCliCandidate): string {
  if (candidate.version !== null) return `v${candidate.version}`;
  if (candidate.kind === "bundled" && !candidate.available) {
    return "Not installed";
  }
  if (!candidate.available) return "Not found";
  return "-";
}

function candidateKey(candidate: ProviderCliCandidate): string {
  return candidate.kind === "custom"
    ? `custom:${candidate.path}`
    : candidate.kind;
}

function selectionFor(candidate: ProviderCliCandidate): ProviderSelection {
  if (candidate.kind === "custom") {
    return { kind: "custom", path: candidate.path };
  }
  return { kind: candidate.kind };
}

function isSelected(
  selected: ProviderSelection,
  candidate: ProviderCliCandidate,
): boolean {
  if (selected.kind !== candidate.kind) return false;
  if (selected.kind === "custom" && candidate.kind === "custom") {
    return selected.path === candidate.path;
  }
  return true;
}

function ProbeLine({
  probing,
  executable,
  version,
}: {
  readonly probing: boolean;
  readonly executable: boolean | null;
  readonly version: string | null;
}): ReactNode {
  if (probing) {
    return (
      <div className="flex items-center gap-2 text-ui-xs text-muted-foreground">
        <MutedAgentSpinner /> Checking
      </div>
    );
  }
  if (executable === null) return null;
  if (!executable) {
    return <div className="text-ui-xs text-destructive">Not executable.</div>;
  }
  return (
    <div className="text-ui-xs text-muted-foreground">
      {version === null
        ? "Detected (no version reported)"
        : `Detected v${version}`}
    </div>
  );
}
