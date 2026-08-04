import { use, useCallback, useId, useState, type ReactNode } from "react";
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
import { useProvidersEnsurePack } from "@/hooks/providers/use-providers-ensure-pack-mutation";
import {
  providerPackBlocksExecution,
  providerPackErrorDetail,
  providerPackPreparingForProvider,
  providerPackPreparingShortLabel,
  providerPackRetryable,
  type ProviderPackPreparing,
} from "@/components/providers/provider-pack-readiness";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { cn } from "@/lib/utils";
import { hidesCliCandidates } from "./provider-cli-candidates-visibility";

// Grid keeps the columns aligned across header + rows; `minmax(0,1fr)` on
// the Path column guarantees it shrinks/truncates instead of pushing the
// table past the panel width.
const TABLE_GRID =
  "grid grid-cols-[2.25rem_minmax(0,1fr)_minmax(5.5rem,auto)_2.25rem] items-center";
const HERMES_INSTALLATION_URL =
  "https://hermes-agent.nousresearch.com/docs/getting-started/installation";

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
  versionVisibility,
  advisory,
  packPreparing,
}: {
  readonly showPathUnblockNotice: boolean;
  readonly versionVisibility: ProviderCliState["versionVisibility"];
  readonly advisory: ProviderCliState["advisory"];
  readonly packPreparing: ProviderPackPreparing | null;
}): ReactNode {
  // An old host leaves the key genuinely absent, which reads the same here as
  // "no other session is on a different version".
  const differingSessionCount = versionVisibility?.differingSessionCount ?? 0;
  return (
    <>
      {/*
        P2. The reason a failed pack failed, on the screen every other surface
        sends the user to. The status cell beside the bundled row has one
        truncating grid column, so it can only ever carry the short label -
        which for a blocking failure is the two words "Setup failed". A user who
        followed the picker tooltip or the host's own RPC error here arrived
        precisely to learn WHY, and found the least informative phrasing in the
        module. This line is where the sentence fits, and it sits with the other
        row-level notices rather than inside the table for the same reason those
        do: the table's job is the binary choice, not the narration.

        Shown for a non-blocking failure too. "Ready · managed install failed"
        is a state a user is entitled to understand - the provider works, and
        something they may want to fix quietly did not.
      */}
      {packPreparing?.kind === "error" ? (
        <p
          className={cn(
            "mb-2 text-ui-xs",
            providerPackBlocksExecution(packPreparing)
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {providerPackErrorDetail(packPreparing.reason)}
        </p>
      ) : null}
      {/*
        W10. The one advisory kind a Phase-1 host populates: this provider is
        paired with the exact build Traycer ships, so a version found on PATH is
        skipped automatically on execute. Without this the provider reported
        available, rendered ungated and selectable, and the turn then threw
        `preparing` - offered-then-failed, from a direction no gate was watching.
        Rendered next to the candidates table on purpose: the fix it names ("use
        that path anyway") is a row the user is already looking at.
        Unknown future kinds render nothing rather than a bare code.
      */}
      {advisory?.kind === "row-incompatibility" && advisory.detail !== null ? (
        <p className="mb-2 text-ui-xs text-muted-foreground">
          {advisory.detail}
        </p>
      ) : null}
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
 * Hermes ships PATH-only (no bundled binary), so an empty candidate list means
 * "not installed on this machine" rather than "nothing detected yet" - point
 * the user at the install guide instead of an empty table. Extracted for the
 * same reason as `CandidateNotices`: it keeps the section below orchestration,
 * and keeps this anchor's RunnerHost branch out of that component's complexity
 * budget.
 */
function HermesInstallNotice(): ReactNode {
  const openExternalLink = useRunnerOpenExternalLink();
  const runnerHost = use(RunnerHostContext);
  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3 text-ui-sm text-muted-foreground">
      <p>
        Hermes must be installed on this machine. It ships without a bundled
        binary.
      </p>
      <a
        href={HERMES_INSTALLATION_URL}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          // No RunnerHost bound (e.g. web): let the browser open the anchor
          // natively; the desktop shell routes it through `openExternalLink`
          // instead (mirrors PrChip in worktrees-settings-panel).
          if (runnerHost === null) return;
          // oxlint-disable-next-line react-doctor/no-prevent-default -- desktop shell opens external links via the Electron `openExternalLink` bridge, not renderer navigation; the null-guard above preserves native anchor nav in web builds.
          event.preventDefault();
          openExternalLink.mutate(HERMES_INSTALLATION_URL);
        }}
        className="mt-1 inline-flex text-ui-xs font-medium text-primary transition-colors hover:text-primary/80 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded"
      >
        Hermes installation guide
      </a>
    </div>
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
  const ensurePack = useProvidersEnsurePack();
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
  // P2/P4. Derived from the WHOLE row, which is the only place the fallback
  // candidates live - the point of `providerPackPreparingForProvider` taking a
  // provider rather than a state. This section used to build its own
  // `ProviderPackPreparing` at the two render sites with `fallbackRunnable:
  // false` written in, on the argument that Settings shows the pack's lifecycle
  // and not whether the provider can run. Those are the same object: every
  // label and every colour in this module reads that field, so hardcoding it
  // did not scope the display - it asserted "nothing runs" about a provider
  // that may be running from PATH right now. On an offline first launch that is
  // a red row and a blocking "Setup failed" for every pin-carrying provider on
  // the machine, at the moment the user is least able to tell it is wrong.
  const packPreparing = providerPackPreparingForProvider(state);
  const showPathUnblockNotice = pathUnblockActive(
    cliConfig.selected,
    managedInstallState,
    cliConfig.candidates,
  );
  const isEmptyHermesState =
    providerId === "hermes" && cliConfig.candidates.length === 0;

  return (
    <>
      <CandidateNotices
        showPathUnblockNotice={showPathUnblockNotice}
        versionVisibility={state.versionVisibility}
        advisory={state.advisory ?? null}
        packPreparing={packPreparing}
      />
      {isEmptyHermesState && !adding ? (
        <HermesInstallNotice />
      ) : (
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
              packPreparing={packPreparing}
              radioName={radioName}
              selected={isSelected(cliConfig.selected, candidate)}
              busy={setSelection.isPending || removeCustom.isPending}
              onSelect={onSelect}
              onRetryPack={() => ensurePack.mutate({ providerId })}
              retryingPack={ensurePack.isPending}
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
                  disabled={
                    addCustom.isPending || draftPath.trim().length === 0
                  }
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
      )}

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
  packPreparing,
  radioName,
  selected,
  busy,
  onSelect,
  onRetryPack,
  retryingPack,
  onRemove,
}: {
  readonly candidate: ProviderCliCandidate;
  // Provider-level (not per-candidate - see that schema's comment), so only
  // meaningful for the bundled row; other candidates ignore it. Still the
  // source for `bundledPathLabel`, which asks a different question than the
  // status cell does: whether this build has a managed opinion at all, not what
  // that opinion currently is.
  readonly managedInstallState: ProviderManagedInstallState | null;
  /** The same state, derived against the row's fallbacks. See the call site. */
  readonly packPreparing: ProviderPackPreparing | null;
  readonly radioName: string;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly onSelect: (selection: ProviderSelection) => void;
  readonly onRetryPack: () => void;
  readonly retryingPack: boolean;
  readonly onRemove: (path: string) => void;
}): ReactNode {
  const isBundled = candidate.kind === "bundled";
  const isCustom = candidate.kind === "custom";
  const pathLabel = isBundled
    ? bundledPathLabel(managedInstallState)
    : candidate.path;
  // A resolved-but-missing binary (custom path the user typed that no longer
  // exists, or a bundled binary not installed). We keep the row and dim it so
  // the user sees the entry is retained but unavailable. An in-progress
  // managed install is not "unavailable" - it's actively working, so it stays
  // undimmed even though `available` is still false.
  //
  // A FAILED pack behind a working fallback gets the same exemption, and
  // without it P4 survives the fix above: this flag also paints the status cell
  // `text-destructive`, so the row would render "Ready · managed install
  // failed" in red - the cell contradicting its own sentence. Dimming is a
  // claim about the provider ("you cannot use this"), and the derived state is
  // the only thing that knows whether that claim is true.
  const packExcusesMissingBinary =
    isBundled &&
    packPreparing !== null &&
    (packPreparing.kind === "downloading" ||
      !providerPackBlocksExecution(packPreparing));
  const unavailable =
    !candidate.available &&
    !candidate.versionPending &&
    !packExcusesMissingBinary;
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
          preparing={isBundled ? packPreparing : null}
          onRetry={onRetryPack}
          retrying={retryingPack}
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
// Path/custom candidates always pass `preparing: null` here, so they fall
// straight through to the existing versionPending/versionLabel behavior,
// unchanged.
//
// Takes the DERIVED `ProviderPackPreparing` rather than the raw wire state.
// Both are one field apart, and that field is `fallbackRunnable` - the one this
// component used to write itself. Passing the derived object is what makes the
// fabrication impossible to reintroduce here: there is no longer a literal to
// edit, only a value that arrived.
function CandidateStatus({
  candidate,
  preparing,
  onRetry,
  retrying,
}: {
  readonly candidate: ProviderCliCandidate;
  readonly preparing: ProviderPackPreparing | null;
  readonly onRetry: () => void;
  readonly retrying: boolean;
}): ReactNode {
  if (candidate.versionPending) {
    return (
      <>
        <MutedAgentSpinner />
        <span className="text-ui-xs">checking…</span>
      </>
    );
  }
  if (preparing?.kind === "downloading") {
    return (
      <>
        <MutedAgentSpinner />
        {/*
          `percent` is NULLABLE and null is a real state, not defensive typing:
          a queued pack has seen no bytes, and a pack whose download a live
          SIBLING host owns is genuinely in progress with no observable byte
          count on this side. Interpolating it raw rendered the literal
          `Installing… %`. Routed through the shared label helper rather than
          re-guarded here, so this surface cannot drift from the picker and the
          composer - all three now answer "unknown progress" the same way.
        */}
        <span className="text-ui-xs">
          {providerPackPreparingShortLabel(preparing)}
        </span>
      </>
    );
  }
  if (preparing?.kind === "error") {
    // The arm that did not exist. A failed managed pack rendered a bare red
    // "Not installed" with no reason and no way forward - while the recovery
    // copy everywhere else (the picker tooltip, the host's own RPC error)
    // points the user AT this screen. Whatever sent them here had to be
    // readable once they arrived.
    return (
      <>
        <span
          className={cn(
            "truncate text-ui-xs",
            // Red is a claim, and it is only true when the provider genuinely
            // cannot run. A pack that failed behind a working PATH or bundled
            // binary reads "Ready · managed install failed", and painting that
            // destructive would contradict the sentence next to it.
            providerPackBlocksExecution(preparing) ? "text-destructive" : "",
          )}
        >
          {providerPackPreparingShortLabel(preparing)}
        </span>
        {/*
          The retry respects the SAME allow-list the picker rail does. A
          `unrepairable` cell is terminal host-side and a `trust-unavailable`
          host has no install machinery at all, so a button here would reach
          `providers.ensurePack` and be a guaranteed no-op - offered-then-failed
          on the one screen a stuck user was told to open.
        */}
        {providerPackRetryable(preparing) ? (
          <button
            type="button"
            disabled={retrying}
            onClick={onRetry}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-ui-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
          >
            Retry
          </button>
        ) : null}
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
