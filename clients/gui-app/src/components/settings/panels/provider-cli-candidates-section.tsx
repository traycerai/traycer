import { use, useCallback, useId, useState, type ReactNode } from "react";
import { Info, Plus, Trash2 } from "lucide-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliCandidate,
  type ProviderCliState,
  type ProviderManagedInstallState,
  type ProviderNextRunBinary,
  type ProviderSelection,
} from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilePathTooltip } from "@/components/file-path-tooltip";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useProvidersSetSelection } from "@/hooks/providers/use-providers-set-selection-mutation";
import { useProvidersAddCustomPath } from "@/hooks/providers/use-providers-add-custom-path-mutation";
import { useProvidersRemoveCustomPath } from "@/hooks/providers/use-providers-remove-custom-path-mutation";
import { useProvidersDetectVersion } from "@/hooks/providers/use-providers-detect-version-query";
import { useProvidersEnsurePack } from "@/hooks/providers/use-providers-ensure-pack-mutation";
import {
  providerPackBlocksExecution,
  providerPackPreparingForProvider,
  providerPackRetryable,
  type ProviderPackPreparing,
} from "@/components/providers/provider-pack-readiness";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { cn } from "@/lib/utils";
import {
  PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHOD,
  ProviderPackVersionManagerPanel,
} from "./provider-pack-version-manager-panel";

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
  huggingface: "opencode",
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
  // Borrows OpenCode's binary (see `SHARED_CLI_CANDIDATE_SOURCE`), so there is
  // no Hugging-Face-specific install page to send anyone to.
  huggingface: null,
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

type VersionManagerPanelData = {
  readonly packId: string;
  readonly packDisplayName: string;
  readonly managedVersions: NonNullable<ProviderCliState["managedVersions"]>;
};

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

function versionManagerPanelDataFor(args: {
  readonly supportsVersionManager: boolean | null;
  readonly packId: ProviderCliState["packId"];
  readonly managedVersions: ProviderCliState["managedVersions"];
}): VersionManagerPanelData | null {
  if (
    !args.supportsVersionManager ||
    args.packId === null ||
    args.packId === undefined ||
    args.managedVersions === null ||
    args.managedVersions === undefined
  ) {
    return null;
  }
  return {
    packId: args.packId,
    // A pack can back several providers. Its manager must retain the
    // shared-store name rather than inheriting whichever provider row
    // happened to open it (for example, `opencode CLI`, not
    // `OpenRouter CLI`).
    packDisplayName: `${args.packId} CLI`,
    managedVersions: args.managedVersions,
  };
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
  hostId,
}: {
  readonly state: ProviderCliState;
  readonly providers: readonly ProviderCliState[];
  readonly hostId: string | null;
}): ReactNode {
  const providerId = state.providerId;
  const cliConfig = candidateConfigForProvider(state, providers);
  const radioName = useId();
  const [adding, setAdding] = useState(false);
  const [versionManagerOpen, setVersionManagerOpen] = useState(false);
  const [draftPath, setDraftPath] = useState("");
  // The version manager's RPCs are all non-floor. `false` also covers the
  // handshake's transient unknown state, so we keep its entry point absent
  // until this host has positively advertised the representative method.
  const supportsVersionManager = useHostSupportsMethod(
    hostId,
    PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHOD,
  );
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
  const versionManagerData = versionManagerPanelDataFor({
    supportsVersionManager,
    packId: state.packId,
    managedVersions: state.managedVersions,
  });
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
      <CandidateAreaContent
        area={candidateArea}
        providerId={providerId}
        table={{
          candidates: cliConfig.candidates,
          managedInstallState,
          packPreparing,
          nextRunBinary: state.nextRunBinary ?? null,
          advisory: state.advisory ?? null,
          differingSessionCount:
            state.versionVisibility?.differingSessionCount ?? 0,
          radioName,
          selection: cliConfig.selected,
          busy: setSelection.isPending || removeCustom.isPending,
          onSelect,
          onRetryPack: () => ensurePack.mutate({ providerId }),
          retryingPack: ensurePack.isPending,
          onRemove: (path) => removeCustom.mutate({ providerId, path }),
          canManageVersions: versionManagerData !== null,
          onToggleVersionManager: () => setVersionManagerOpen((open) => !open),
          versionManagerOpen,
          adding,
          draftPath,
          onDraftPathChange: setDraftPath,
          focusDraftInput,
          onSaveCustom,
          savingCustom: addCustom.isPending,
          onCancelCustom: () => {
            setAdding(false);
            setDraftPath("");
          },
          probing: probe.isFetching,
          probeExecutable: probe.data?.executable ?? null,
          probeVersion: probe.data?.version ?? null,
        }}
      />
      <VersionManagerMount
        open={versionManagerOpen}
        hostId={hostId}
        data={versionManagerData}
      />
      <AddCustomPathButton hidden={adding} onClick={() => setAdding(true)} />
    </>
  );
}

type CandidateTableProps = {
  readonly candidates: readonly ProviderCliCandidate[];
  readonly managedInstallState: ProviderManagedInstallState | null;
  readonly packPreparing: ProviderPackPreparing | null;
  readonly nextRunBinary: ProviderNextRunBinary | null;
  readonly advisory: ProviderCliState["advisory"] | null;
  readonly differingSessionCount: number;
  readonly radioName: string;
  readonly selection: ProviderSelection;
  readonly busy: boolean;
  readonly onSelect: (selection: ProviderSelection) => void;
  readonly onRetryPack: () => void;
  readonly retryingPack: boolean;
  readonly onRemove: (path: string) => void;
  readonly canManageVersions: boolean;
  readonly onToggleVersionManager: () => void;
  readonly versionManagerOpen: boolean;
  readonly adding: boolean;
  readonly draftPath: string;
  readonly onDraftPathChange: (path: string) => void;
  readonly focusDraftInput: (node: HTMLInputElement | null) => void;
  readonly onSaveCustom: () => void;
  readonly savingCustom: boolean;
  readonly onCancelCustom: () => void;
  readonly probing: boolean;
  readonly probeExecutable: boolean | null;
  readonly probeVersion: string | null;
};

function CandidateAreaContent({
  area,
  providerId,
  table,
}: {
  readonly area: CandidateArea;
  readonly providerId: ProviderId;
  readonly table: CandidateTableProps;
}): ReactNode {
  if (area !== "table") {
    return <CandidateEmptyArea area={area} providerId={providerId} />;
  }
  return <CandidateTable {...table} />;
}

function CandidateTable({
  candidates,
  managedInstallState,
  packPreparing,
  nextRunBinary,
  advisory,
  differingSessionCount,
  radioName,
  selection,
  busy,
  onSelect,
  onRetryPack,
  retryingPack,
  onRemove,
  canManageVersions,
  onToggleVersionManager,
  versionManagerOpen,
  adding,
  draftPath,
  onDraftPathChange,
  focusDraftInput,
  onSaveCustom,
  savingCustom,
  onCancelCustom,
  probing,
  probeExecutable,
  probeVersion,
}: CandidateTableProps): ReactNode {
  return (
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
      {candidates.map((candidate) => (
        <CandidateRow
          key={candidateKey(candidate)}
          candidate={candidate}
          managedInstallState={managedInstallState}
          packPreparing={packPreparing}
          nextRunBinary={nextRunBinary}
          advisory={advisory}
          differingSessionCount={differingSessionCount}
          radioName={radioName}
          selection={selection}
          selected={isSelected(selection, candidate)}
          busy={busy}
          onSelect={onSelect}
          onRetryPack={onRetryPack}
          retryingPack={retryingPack}
          onRemove={onRemove}
          onManageVersions={
            candidate.kind === "bundled" && canManageVersions
              ? onToggleVersionManager
              : null
          }
          versionManagerOpen={versionManagerOpen}
        />
      ))}
      <CustomPathForm
        open={adding}
        draftPath={draftPath}
        onDraftPathChange={onDraftPathChange}
        focusDraftInput={focusDraftInput}
        onSave={onSaveCustom}
        saving={savingCustom}
        onCancel={onCancelCustom}
        probing={probing}
        executable={probeExecutable}
        version={probeVersion}
      />
    </div>
  );
}

function CustomPathForm({
  open,
  draftPath,
  onDraftPathChange,
  focusDraftInput,
  onSave,
  saving,
  onCancel,
  probing,
  executable,
  version,
}: {
  readonly open: boolean;
  readonly draftPath: string;
  readonly onDraftPathChange: (path: string) => void;
  readonly focusDraftInput: (node: HTMLInputElement | null) => void;
  readonly onSave: () => void;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly probing: boolean;
  readonly executable: boolean | null;
  readonly version: string | null;
}): ReactNode {
  if (!open) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-border/40 bg-muted/10 p-3">
      <div className="flex items-center gap-2">
        <Input
          ref={focusDraftInput}
          className="w-full font-mono text-ui-sm"
          placeholder="/absolute/path/to/binary"
          value={draftPath}
          onChange={(event) => onDraftPathChange(event.target.value)}
          disabled={saving}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSave();
            if (event.key === "Escape") onCancel();
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={onSave}
          disabled={saving || draftPath.trim().length === 0}
        >
          {saving ? <MutedAgentSpinner /> : null}
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
      <ProbeLine probing={probing} executable={executable} version={version} />
    </div>
  );
}

function VersionManagerMount({
  open,
  hostId,
  data,
}: {
  readonly open: boolean;
  readonly hostId: string | null;
  readonly data: VersionManagerPanelData | null;
}): ReactNode {
  if (!open || data === null) return null;
  return (
    <div className="mt-3">
      <ProviderPackVersionManagerPanel {...data} hostId={hostId} />
    </div>
  );
}

function AddCustomPathButton({
  hidden,
  onClick,
}: {
  readonly hidden: boolean;
  readonly onClick: () => void;
}): ReactNode {
  if (hidden) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-ui-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
    >
      <Plus className="size-4" /> Add custom path
    </button>
  );
}

function CandidateRow({
  candidate,
  managedInstallState,
  packPreparing,
  nextRunBinary,
  advisory,
  differingSessionCount,
  radioName,
  selection,
  selected,
  busy,
  onSelect,
  onRetryPack,
  retryingPack,
  onRemove,
  onManageVersions,
  versionManagerOpen,
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
  readonly nextRunBinary: ProviderNextRunBinary | null;
  readonly advisory: ProviderCliState["advisory"] | null;
  readonly differingSessionCount: number;
  readonly radioName: string;
  readonly selection: ProviderSelection;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly onSelect: (selection: ProviderSelection) => void;
  readonly onRetryPack: () => void;
  readonly retryingPack: boolean;
  readonly onRemove: (path: string) => void;
  readonly onManageVersions: (() => void) | null;
  readonly versionManagerOpen: boolean;
}): ReactNode {
  const presentation = candidateRowPresentation({
    candidate,
    managedInstallState,
    packPreparing,
    nextRunBinary,
    advisory,
    selection,
  });
  return (
    <div
      className={cn(
        TABLE_GRID,
        "border-b border-border/40 last:border-b-0 hover:bg-muted/20",
        presentation.unavailable ? "opacity-60" : "",
      )}
    >
      <CandidateSelectionControl
        candidate={candidate}
        radioName={radioName}
        selected={selected}
        busy={busy}
        onSelect={onSelect}
      />
      <CandidatePathCell
        candidate={candidate}
        pathLabel={presentation.pathLabel}
        pathAdvisory={presentation.pathAdvisory}
        differingSessionCount={differingSessionCount}
        onManageVersions={onManageVersions}
        versionManagerOpen={versionManagerOpen}
      />
      <CandidateVersionCell
        candidate={candidate}
        preparing={presentation.preparing}
        managedInstallState={presentation.managedInstallState}
        activeLabel={presentation.activeLabel}
        unavailable={presentation.unavailable}
        onRetry={onRetryPack}
        retrying={retryingPack}
      />
      <CandidateRowActions
        candidate={candidate}
        busy={busy}
        onRemove={onRemove}
      />
    </div>
  );
}

type CandidateRowPresentation = {
  readonly pathLabel: string;
  readonly pathAdvisory: string | null;
  readonly unavailable: boolean;
  readonly activeLabel: string | null;
  readonly preparing: ProviderPackPreparing | null;
  readonly managedInstallState: ProviderManagedInstallState | null;
};

function candidateRowPresentation(args: {
  readonly candidate: ProviderCliCandidate;
  readonly managedInstallState: ProviderManagedInstallState | null;
  readonly packPreparing: ProviderPackPreparing | null;
  readonly nextRunBinary: ProviderNextRunBinary | null;
  readonly advisory: ProviderCliState["advisory"] | null;
  readonly selection: ProviderSelection;
}): CandidateRowPresentation {
  const isBundled = args.candidate.kind === "bundled";
  const packExcusesMissingBinary =
    isBundled &&
    args.packPreparing !== null &&
    (args.packPreparing.kind === "downloading" ||
      !providerPackBlocksExecution(args.packPreparing));
  return {
    pathLabel: isBundled
      ? bundledPathLabel(args.managedInstallState)
      : args.candidate.path,
    pathAdvisory:
      args.candidate.kind === "path" &&
      args.advisory?.kind === "row-incompatibility"
        ? args.advisory.detail
        : null,
    unavailable:
      !args.candidate.available &&
      !args.candidate.versionPending &&
      !packExcusesMissingBinary,
    activeLabel: activeLabelForCandidate(
      args.nextRunBinary,
      args.candidate,
      args.selection,
      args.managedInstallState,
    ),
    preparing: isBundled ? args.packPreparing : null,
    managedInstallState: isBundled ? args.managedInstallState : null,
  };
}

function CandidateSelectionControl({
  candidate,
  radioName,
  selected,
  busy,
  onSelect,
}: {
  readonly candidate: ProviderCliCandidate;
  readonly radioName: string;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly onSelect: (selection: ProviderSelection) => void;
}): ReactNode {
  const label =
    candidate.kind === "bundled"
      ? "Select bundled binary"
      : `Select ${candidate.path}`;
  return (
    <span className="flex items-center justify-center py-2.5">
      <input
        type="radio"
        aria-label={label}
        name={radioName}
        checked={selected}
        disabled={busy}
        onChange={() => onSelect(selectionFor(candidate))}
        className="size-3.5 cursor-pointer accent-primary"
      />
    </span>
  );
}

function CandidatePathCell({
  candidate,
  pathLabel,
  pathAdvisory,
  differingSessionCount,
  onManageVersions,
  versionManagerOpen,
}: {
  readonly candidate: ProviderCliCandidate;
  readonly pathLabel: string;
  readonly pathAdvisory: string | null;
  readonly differingSessionCount: number;
  readonly onManageVersions: (() => void) | null;
  readonly versionManagerOpen: boolean;
}): ReactNode {
  if (candidate.kind === "bundled") {
    return (
      <BundledCandidatePathCell
        pathLabel={pathLabel}
        differingSessionCount={differingSessionCount}
        onManageVersions={onManageVersions}
        versionManagerOpen={versionManagerOpen}
      />
    );
  }
  return (
    <ExternalCandidatePathCell candidate={candidate} advisory={pathAdvisory} />
  );
}

function BundledCandidatePathCell({
  pathLabel,
  differingSessionCount,
  onManageVersions,
  versionManagerOpen,
}: {
  readonly pathLabel: string;
  readonly differingSessionCount: number;
  readonly onManageVersions: (() => void) | null;
  readonly versionManagerOpen: boolean;
}): ReactNode {
  return (
    <div className="min-w-0 p-2.5 text-ui-sm text-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate">{pathLabel}</span>
        {onManageVersions === null ? null : (
          <button
            type="button"
            aria-expanded={versionManagerOpen}
            onClick={onManageVersions}
            className="shrink-0 text-ui-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Manage versions
          </button>
        )}
      </div>
      {differingSessionCount > 0 ? (
        <p className="mt-1 text-ui-xs text-muted-foreground">
          {differentVersionSessionsLabel(differingSessionCount)}
        </p>
      ) : null}
    </div>
  );
}

function ExternalCandidatePathCell({
  candidate,
  advisory,
}: {
  readonly candidate: Exclude<
    ProviderCliCandidate,
    { readonly kind: "bundled" }
  >;
  readonly advisory: string | null;
}): ReactNode {
  return (
    <div className="flex min-w-0 items-center gap-1 p-2.5">
      <FilePathTooltip content={candidate.path} side="bottom">
        <StartTruncatedText className="min-w-0 font-mono text-ui-sm text-foreground">
          {candidate.path}
        </StartTruncatedText>
      </FilePathTooltip>
      {advisory === null ? null : (
        <TooltipWrapper
          label={advisory}
          side="bottom"
          sideOffset={undefined}
          align={undefined}
        >
          <button
            type="button"
            aria-label="Why this PATH binary is not used automatically"
            className="shrink-0 rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Info className="size-3.5" aria-hidden="true" />
          </button>
        </TooltipWrapper>
      )}
    </div>
  );
}

function CandidateVersionCell({
  candidate,
  preparing,
  managedInstallState,
  activeLabel,
  unavailable,
  onRetry,
  retrying,
}: {
  readonly candidate: ProviderCliCandidate;
  readonly preparing: ProviderPackPreparing | null;
  readonly managedInstallState: ProviderManagedInstallState | null;
  readonly activeLabel: string | null;
  readonly unavailable: boolean;
  readonly onRetry: () => void;
  readonly retrying: boolean;
}): ReactNode {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 truncate p-2.5 text-ui-sm",
        unavailable ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <CandidateStatus
        candidate={candidate}
        preparing={preparing}
        managedInstallState={managedInstallState}
        activeLabel={activeLabel}
        onRetry={onRetry}
        retrying={retrying}
      />
    </span>
  );
}

function CandidateRowActions({
  candidate,
  busy,
  onRemove,
}: {
  readonly candidate: ProviderCliCandidate;
  readonly busy: boolean;
  readonly onRemove: (path: string) => void;
}): ReactNode {
  if (candidate.kind !== "custom") {
    return <span className="flex items-center justify-center py-2.5" />;
  }
  return (
    <span className="flex items-center justify-center py-2.5">
      <button
        type="button"
        aria-label="Remove custom path"
        disabled={busy}
        onClick={() => onRemove(candidate.path)}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
      >
        <Trash2 className="size-3.5" />
      </button>
    </span>
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

function differentVersionSessionsLabel(differingSessionCount: number): string {
  return differingSessionCount === 1
    ? "1 running session uses a different version."
    : `${differingSessionCount} running sessions use a different version.`;
}

function activeLabelForCandidate(
  nextRunBinary: ProviderNextRunBinary | null,
  candidate: ProviderCliCandidate,
  selection: ProviderSelection,
  managedInstallState: ProviderManagedInstallState | null,
): string | null {
  if (
    nextRunBinary === null ||
    nextRunMatchesSelection(nextRunBinary, selection, managedInstallState) ||
    !nextRunMatchesCandidate(nextRunBinary, candidate)
  ) {
    return null;
  }
  return nextRunBinary.kind === "bundled" ? "Active (bundled build)" : "Active";
}

function nextRunMatchesSelection(
  nextRunBinary: ProviderNextRunBinary,
  selection: ProviderSelection,
  managedInstallState: ProviderManagedInstallState | null,
): boolean {
  if (nextRunBinary.kind === "managed") {
    return selection.kind === "bundled";
  }
  // The inline `bundled` fallback and a managed install share the Managed UI
  // row but are different binaries, so show the chip in that state. A legacy
  // Bundled row (`managedInstallState === null`) is the inline binary itself,
  // where a bundled next run matches the persisted bundled selection.
  if (nextRunBinary.kind === "bundled") {
    return selection.kind === "bundled" && managedInstallState === null;
  }
  if (nextRunBinary.kind === "path") return selection.kind === "path";
  return (
    selection.kind === "custom" &&
    nextRunBinary.path !== null &&
    selection.path === nextRunBinary.path
  );
}

function nextRunMatchesCandidate(
  nextRunBinary: ProviderNextRunBinary,
  candidate: ProviderCliCandidate,
): boolean {
  if (nextRunBinary.kind === "managed" || nextRunBinary.kind === "bundled") {
    return candidate.kind === "bundled";
  }
  if (nextRunBinary.kind === "path") return candidate.kind === "path";
  return (
    candidate.kind === "custom" &&
    nextRunBinary.path !== null &&
    candidate.path === nextRunBinary.path
  );
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

function CandidateStatus({
  candidate,
  preparing,
  managedInstallState,
  activeLabel,
  onRetry,
  retrying,
}: {
  readonly candidate: ProviderCliCandidate;
  readonly preparing: ProviderPackPreparing | null;
  readonly managedInstallState: ProviderManagedInstallState | null;
  readonly activeLabel: string | null;
  readonly onRetry: () => void;
  readonly retrying: boolean;
}): ReactNode {
  if (managedInstallState?.status === "downloading") {
    return (
      <ManagedInstallProgress
        version={managedInstallState.version ?? null}
        percent={managedInstallState.percent}
        activeLabel={activeLabel}
      />
    );
  }
  if (managedInstallState?.status === "error") {
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="text-ui-xs">Install failed</span>
        {preparing !== null && providerPackRetryable(preparing) ? (
          <>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              disabled={retrying}
              onClick={onRetry}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-ui-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
            >
              Retry
            </button>
          </>
        ) : null}
        <ActiveNextRunChip label={activeLabel} />
      </span>
    );
  }
  if (candidate.versionPending) {
    return (
      <>
        <MutedAgentSpinner />
        <span className="text-ui-xs">checking…</span>
      </>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      {versionLabel(candidate)}
      <ActiveNextRunChip label={activeLabel} />
    </span>
  );
}

function ManagedInstallProgress({
  version,
  percent,
  activeLabel,
}: {
  readonly version: string | null;
  readonly percent: number | null;
  readonly activeLabel: string | null;
}): ReactNode {
  const label = installProgressLabel(version, percent);
  return (
    <span className="flex w-full min-w-0 flex-col gap-1">
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="truncate text-ui-xs">{label}</span>
        <ActiveNextRunChip label={activeLabel} />
      </span>
      <span
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : percent}
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        <span
          className={cn(
            "block h-full rounded-full bg-primary",
            percent === null ? "w-1/3 animate-pulse" : "",
          )}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </span>
    </span>
  );
}

function installProgressLabel(
  version: string | null,
  percent: number | null,
): string {
  const versionLabel =
    version === null ? "Installing" : `Installing v${version}`;
  return percent === null
    ? `${versionLabel}…`
    : `${versionLabel} · ${percent}%`;
}

function ActiveNextRunChip({
  label,
}: {
  readonly label: string | null;
}): ReactNode {
  if (label === null) return null;
  return (
    <TooltipWrapper
      label="New sessions use this binary. Running sessions keep the binary they started with."
      side="bottom"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-ui-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {label}
      </button>
    </TooltipWrapper>
  );
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
