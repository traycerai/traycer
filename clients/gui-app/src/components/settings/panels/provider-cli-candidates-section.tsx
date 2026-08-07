import { use, useCallback, useId, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliCandidate,
  type ProviderCliState,
  type ProviderManagedInstallState,
  type ProviderSelection,
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

type ProviderId = ProviderCliState["providerId"];

// Grid keeps the columns aligned across header + rows; `minmax(0,1fr)` on
// the Path column guarantees it shrinks/truncates instead of pushing the
// table past the panel width.
const TABLE_GRID =
  "grid grid-cols-[2.25rem_minmax(0,1fr)_minmax(5.5rem,auto)_2.25rem] items-center";

/**
 * Which OTHER provider's CLI candidates this one falls back to when its own
 * list is empty, because the two resolve to the same binary on disk (host:
 * `baseBinaryName`/`providerSubdir` map traycer and openrouter onto opencode).
 * `null` for a provider that owns its binary.
 *
 * Exhaustive rather than the `traycer || openrouter` id test it replaces:
 * the pair was correct, but a provider added without an entry here silently
 * inherited "owns its own binary", which for the next opencode-family member
 * is an empty CLI table with a working binary sitting one row away. The
 * compiler now asks.
 *
 * A borrowed row is only ever a shortcut to the same absolute path - selecting
 * one writes a `custom` selection into THIS provider's own overrides, so
 * nothing here is shared state.
 */
const SHARED_CLI_CANDIDATE_SOURCE: Record<ProviderId, ProviderId | null> = {
  "claude-code": null,
  codex: null,
  opencode: null,
  cursor: null,
  traycer: "opencode",
  openrouter: "opencode",
  grok: null,
  qwen: null,
  kiro: null,
  droid: null,
  kimi: null,
  copilot: null,
  kilocode: null,
  amp: null,
  devin: null,
  pi: null,
  hermes: null,
  omp: null,
};

/**
 * Where to send a user whose provider ships no Traycer-managed binary and has
 * none on this machine. `null` means "no install page we can point at" - the
 * empty state still explains itself, it just has no link.
 *
 * Exhaustive rather than the `providerId === "hermes"` test it replaces. That
 * test was the second of the two registration points `adding-a-harness.md`
 * warns about (the first being the host's `PROVIDERS_WITHOUT_BUNDLED_BINARY`):
 * they happened to agree while hermes was the only member, and the moment amp
 * and cursor joined the host set they stopped agreeing. The empty state is now
 * driven by the CANDIDATE LIST itself - the host omits the bundled row for
 * exactly the providers in that set - and this map only supplies the link.
 */
const PROVIDER_INSTALL_GUIDE_URL: Record<ProviderId, string | null> = {
  "claude-code": null,
  codex: null,
  opencode: null,
  // No entry: no cursor-agent install page is referenced anywhere in this repo
  // and one has not been verified, so this stays null rather than shipping a
  // guessed URL that 404s from a screen a stuck user was sent to.
  cursor: null,
  traycer: null,
  openrouter: null,
  grok: null,
  qwen: null,
  kiro: null,
  droid: null,
  kimi: null,
  copilot: null,
  kilocode: null,
  // The one URL `@ampcode/cli`'s own README publishes.
  amp: "https://ampcode.com/manual",
  devin: null,
  pi: null,
  hermes:
    "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
  omp: null,
};

interface ProviderCandidateConfig {
  readonly selected: ProviderSelection;
  readonly candidates: readonly ProviderCliCandidate[];
}

function candidateConfigForProvider(
  state: ProviderCliState,
  providers: readonly ProviderCliState[],
): ProviderCandidateConfig {
  const sourceId = SHARED_CLI_CANDIDATE_SOURCE[state.providerId];
  if (sourceId === null || state.candidates.length > 0) {
    return { selected: state.selected, candidates: state.candidates };
  }

  const source = providers.find((provider) => provider.providerId === sourceId);
  return {
    selected: state.selected,
    candidates: source?.candidates ?? state.candidates,
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
 * An empty candidate list means "nothing runnable was found on this machine",
 * not "nothing detected yet": the host only omits the bundled row for the
 * providers it ships no binary for (`PROVIDERS_WITHOUT_BUNDLED_BINARY`), and
 * for everyone else the row is always present even when unavailable. So an
 * empty table is a terminal state that owes the user a sentence and, where one
 * exists, a link - not a bare header with no rows under it.
 *
 * This used to be hermes-only, by id. Amp and cursor joined the host's set
 * (their SDKs spawn their own copies, so Traycer vendors neither) and would
 * otherwise have rendered that bare table - which for amp is exactly the dead
 * end this whole change is about: MCP add/remove/auth silently gone, and the
 * one screen that could explain it saying nothing.
 *
 * Extracted for the same reason as `CandidateNotices`: it keeps the section
 * below orchestration, and keeps this anchor's RunnerHost branch out of that
 * component's complexity budget.
 */
/**
 * What the candidate area shows: the table, or one of the two empty states.
 *
 * A plain function rather than nested ternaries in the JSX — the three-way
 * choice reads as a rule here, and the table branch is long enough that a
 * reader arriving at its `)` should not have to reconstruct which of two
 * conditions got them there.
 *
 * `adding` forces the table because that is where the custom-path input lives:
 * a user who opened it must still be able to type, whatever the probe says.
 */
type CandidateArea = "probing" | "missing" | "table";

function candidateAreaFor(args: {
  readonly adding: boolean;
  readonly probePending: boolean;
  readonly candidateCount: number;
}): CandidateArea {
  if (args.adding || args.candidateCount > 0) return "table";
  return args.probePending ? "probing" : "missing";
}

function CandidateEmptyArea({
  area,
  providerId,
}: {
  readonly area: Exclude<CandidateArea, "table">;
  readonly providerId: ProviderId;
}): ReactNode {
  if (area === "probing") {
    return (
      <CliBinaryProbePendingNotice
        providerLabel={PROVIDER_DISPLAY_NAMES[providerId]}
      />
    );
  }
  return (
    <CliBinaryMissingNotice
      providerLabel={PROVIDER_DISPLAY_NAMES[providerId]}
      installGuideUrl={PROVIDER_INSTALL_GUIDE_URL[providerId]}
    />
  );
}

/**
 * Shown INSTEAD of the missing-binary notice while the host's PATH probe is
 * still in flight and has turned up nothing yet.
 *
 * Deliberately says nothing about installing: at this point we do not know
 * whether a binary exists, and the missing notice's advice ("install it, or
 * add its path below") is wrong often enough — every PATH-only provider on a
 * cold open — that showing it early is worse than showing nothing.
 */
function CliBinaryProbePendingNotice({
  providerLabel,
}: {
  readonly providerLabel: string;
}): ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/10 p-3 text-ui-sm text-muted-foreground">
      <MutedAgentSpinner />
      Looking for the {providerLabel} CLI…
    </div>
  );
}

function CliBinaryMissingNotice({
  providerLabel,
  installGuideUrl,
}: {
  readonly providerLabel: string;
  readonly installGuideUrl: string | null;
}): ReactNode {
  const openExternalLink = useRunnerOpenExternalLink();
  const runnerHost = use(RunnerHostContext);
  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3 text-ui-sm text-muted-foreground">
      <p>
        No {providerLabel} CLI was found on this machine, and Traycer ships no
        bundled copy of it. Install it, or add its path below.
      </p>
      {installGuideUrl === null ? null : (
        <a
          href={installGuideUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            // No RunnerHost bound (e.g. web): let the browser open the anchor
            // natively; the desktop shell routes it through `openExternalLink`
            // instead (mirrors PrChip in worktrees-settings-panel).
            if (runnerHost === null) return;
            // oxlint-disable-next-line react-doctor/no-prevent-default -- desktop shell opens external links via the Electron `openExternalLink` bridge, not renderer navigation; the null-guard above preserves native anchor nav in web builds.
            event.preventDefault();
            openExternalLink.mutate(installGuideUrl);
          }}
          className="mt-1 inline-flex text-ui-xs font-medium text-primary transition-colors hover:text-primary/80 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded"
        >
          {providerLabel} installation guide
        </a>
      )}
    </div>
  );
}

/**
 * S14: the CLI-path-management subsection of `ProviderDetail` (binary
 * selection table + "Add custom path" flow), extracted so the panel stays
 * orchestration.
 *
 * Renders for EVERY provider. It used to bail out for cursor and amp via
 * `hidesCliCandidates`, on the premise that an SDK-driven provider has no CLI
 * binary the user could pick. Both of them spawn the Traycer-resolved binary
 * for their MCP write verbs (`runAmpCliCapture`, `runCursorMcpCli`), so this
 * table was never decorative for them - it is the only control over the binary
 * those verbs use, and the only way to supply one when none is on PATH.
 */
export function ProviderCliCandidatesSection({
  state,
  providers,
}: {
  readonly state: ProviderCliState;
  readonly providers: readonly ProviderCliState[];
}): ReactNode {
  const providerId = state.providerId;
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
  // `availabilityPending` means the host's shell/PATH probe is still running,
  // and the protocol is explicit that `candidates` must not be trusted until
  // it settles ("A pending row always carries `available: false` semantically"
  // — provider-schemas). An empty interim list is therefore not evidence of
  // absence: for the PATH-only providers (amp, cursor) this pane would tell
  // people to install a binary the in-flight probe is about to find, and offer
  // an install guide for a CLI they already have.
  const candidateArea = candidateAreaFor({
    adding,
    probePending: state.availabilityPending,
    candidateCount: cliConfig.candidates.length,
  });

  return (
    <>
      <CandidateNotices
        showPathUnblockNotice={showPathUnblockNotice}
        versionVisibility={state.versionVisibility}
        advisory={state.advisory ?? null}
        packPreparing={packPreparing}
      />
      {candidateArea === "table" ? (
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
      ) : (
        <CandidateEmptyArea area={candidateArea} providerId={providerId} />
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
