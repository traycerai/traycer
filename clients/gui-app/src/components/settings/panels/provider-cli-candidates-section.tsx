import { useCallback, useId, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import type {
  ProviderCliCandidate,
  ProviderCliState,
  ProviderManagedInstallState,
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
 * D6's PATH-unblock composite: the user's selection is the managed candidate,
 * an install is ACTIVELY in progress (not merely absent - an absent pack with
 * no download running yet is not "installing", so the copy must stay quiet
 * until a download actually starts), and a PATH binary is standing in for it
 * right now. Derived client-side from existing signals (selection +
 * candidates) plus `managedInstallState` rather than carried as its own field
 * - there is nothing here a host-computed boolean would tell us that these
 * don't already. `null` (old host, or this provider hasn't been cut over to
 * the registry yet) never activates it.
 */
function pathUnblockActive(
  selected: ProviderSelection,
  managedInstallState: ProviderManagedInstallState | null,
  candidates: readonly ProviderCliCandidate[],
): boolean {
  if (selected.kind !== "bundled") return false;
  if (managedInstallState?.status !== "downloading") return false;
  return candidates.some(
    (candidate) => candidate.kind === "path" && candidate.available,
  );
}

// The two quiet, self-correcting row indicators above the candidates table -
// never a toast (see the plan's D6/D12 renderer rules). Both are absent by
// default (old host, or nothing to report).
function CandidateNotices({
  showPathUnblockNotice,
  differingSessionCount,
}: {
  readonly showPathUnblockNotice: boolean;
  readonly differingSessionCount: number;
}): ReactNode {
  return (
    <>
      {showPathUnblockNotice ? (
        <p className="mb-2 text-ui-xs text-muted-foreground">
          Running from PATH · installing managed copy
        </p>
      ) : null}
      {differingSessionCount > 0 ? (
        <p className="mb-2 text-ui-xs text-muted-foreground">
          {differingSessionCount === 1
            ? "1 other session is using a different version."
            : `${differingSessionCount} other sessions are using a different version.`}
        </p>
      ) : null}
    </>
  );
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

  // Normalize once: an old host's payload leaves the key genuinely absent
  // (`undefined`), which reads identically to an explicit `null` everywhere
  // below.
  const managedInstallState = state.managedInstallState ?? null;
  const showPathUnblockNotice = pathUnblockActive(
    cliConfig.selected,
    managedInstallState,
    cliConfig.candidates,
  );
  const differingSessionCount =
    state.versionVisibility?.differingSessionCount ?? 0;

  return (
    <>
      <CandidateNotices
        showPathUnblockNotice={showPathUnblockNotice}
        differingSessionCount={differingSessionCount}
      />
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
            managedInstallState={managedInstallState}
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
  managedInstallState,
  radioName,
  selected,
  busy,
  onSelect,
  onRemove,
}: {
  readonly candidate: ProviderCliCandidate;
  // Provider-level (not per-candidate - see that schema's comment), so only
  // meaningful for the bundled row; other candidates ignore it.
  readonly managedInstallState: ProviderManagedInstallState | null;
  readonly radioName: string;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly onSelect: (selection: ProviderSelection) => void;
  readonly onRemove: (path: string) => void;
}): ReactNode {
  const isBundled = candidate.kind === "bundled";
  const isCustom = candidate.kind === "custom";
  const pathLabel = isBundled
    ? bundledPathLabel(managedInstallState)
    : candidate.path;
  const downloading =
    isBundled && managedInstallState?.status === "downloading";
  // A resolved-but-missing binary (custom path the user typed that no longer
  // exists, or a bundled binary not installed). We keep the row and dim it so
  // the user sees the entry is retained but unavailable. An in-progress
  // managed install is not "unavailable" - it's actively working, so it stays
  // undimmed even though `available` is still false.
  const unavailable =
    !candidate.available && !candidate.versionPending && !downloading;
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
        <CandidateStatus
          candidate={candidate}
          managedInstallState={isBundled ? managedInstallState : null}
        />
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

// "Bundled" while this provider still ships the still-inline binary (no
// install-state signal at all, whether an old host or T7 hasn't cut this
// provider over yet); "Managed" once the registry pack is what's actually
// resolved here.
function bundledPathLabel(
  managedInstallState: ProviderManagedInstallState | null,
): string {
  return managedInstallState === null ? "Bundled" : "Managed";
}

// The bundled row's status cell: the in-progress managed-install state takes
// priority over the plain version/availability copy (`versionLabel`), which
// takes priority over the version-probe spinner every candidate can show.
// Path/custom candidates always pass `managedInstallState: null` here, so
// they fall straight through to the existing versionPending/versionLabel
// behavior, unchanged.
function CandidateStatus({
  candidate,
  managedInstallState,
}: {
  readonly candidate: ProviderCliCandidate;
  readonly managedInstallState: ProviderManagedInstallState | null;
}): ReactNode {
  if (candidate.versionPending) {
    return (
      <>
        <MutedAgentSpinner />
        <span className="text-ui-xs">checking…</span>
      </>
    );
  }
  if (managedInstallState?.status === "downloading") {
    return (
      <>
        <MutedAgentSpinner />
        <span className="text-ui-xs">
          Installing… {managedInstallState.percent}%
        </span>
      </>
    );
  }
  return versionLabel(candidate);
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
