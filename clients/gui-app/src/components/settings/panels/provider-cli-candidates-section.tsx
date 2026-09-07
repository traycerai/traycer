import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Info, Plus, TriangleAlert, Trash2 } from "lucide-react";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
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
import { useOpenLink } from "@/lib/links/open-link";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { cn } from "@/lib/utils";
import { ProviderPackVersionManagerPanel } from "./provider-pack-version-manager-panel";
import { useProviderPackVersionManagerSupport } from "./provider-pack-version-manager-capability";
import {
  managedInstallFailureMessage,
  managedVersionsUnavailableMessage,
} from "./provider-pack-version-manager-model";

type ProviderId = ProviderCliState["providerId"];

// The floor is `0`, not the `5.5rem` a `v0.147.0` wants before it truncates. The cell already truncates, which
// is the graceful answer at that width.
const TABLE_GRID =
  "grid grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,0.2fr)_2.25rem]";
const TABLE_ROW = "col-span-4 grid grid-cols-subgrid items-center";
// Every cell in every row and in the header uses the same horizontal padding, so the Version header's right
// edge lands exactly on each row's version.
const TABLE_CELL_X = "px-2.5";

/** Exhaustive rather than the `traycer || openrouter` id test it replaces. */
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
  // Reasonix ships its own self-contained binary (six prebuilt targets), so it
  // borrows nobody's.
  reasonix: null,
};

/** Exhaustive rather than the `providerId === "hermes"` test it replaces. */
const PROVIDER_INSTALL_GUIDE_URL: Record<ProviderId, string | null> = {
  "claude-code": null,
  codex: null,
  opencode: null,
  // No entry: no cursor-agent install page is referenced anywhere in this repo and one has not been verified, so
  // this stays null rather than shipping a guessed URL that 404s from a screen a stuck user was sent to.
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
  // The one URL `@ampcode/cli`'s own readme publishes.
  amp: "https://ampcode.com/manual",
  devin: null,
  pi: null,
  hermes:
    "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
  omp: null,
  // Reasonix IS bundled, so this empty state is not its normal path - it only appears if the managed binary is
  // missing on this machine. Left null rather than shipping an unverified upstream install page for that edge.
  reasonix: null,
};

interface ProviderCandidateConfig {
  readonly selected: ProviderSelection;
  readonly candidates: readonly ProviderCliCandidate[];
}

type VersionManagerPanelData =
  | {
      readonly kind: "panel";
      readonly packId: string;
      readonly packDisplayName: string;
      readonly managedVersions: NonNullable<
        ProviderCliState["managedVersions"]
      >;
    }
  | {
      readonly kind: "unavailable";
      readonly packId: string;
      readonly packDisplayName: string;
      readonly message: string;
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

/** Silently hiding those was the reported bug - a settings tab with no control and no reason reads as "this
 * feature does not exist on my machine". */
function versionManagerPanelDataFor(args: {
  readonly hostId: string | null;
  readonly supportsVersionManager: boolean | null;
  readonly packId: ProviderCliState["packId"];
  readonly managedVersions: ProviderCliState["managedVersions"];
  readonly managedVersionsUnavailable: ProviderCliState["managedVersionsUnavailable"];
}): VersionManagerPanelData | null {
  // No host is the second case that still hides rather than explains.
  if (args.hostId === null) return null;
  if (args.packId === null || args.packId === undefined) return null;
  // Its manager must retain the shared-store name rather than inheriting whichever provider row happened to open
  // it (for example, `opencode CLI`, not `OpenRouter CLI`).
  const packDisplayName = `${args.packId} CLI`;
  // Null is "not answered yet", not "unsupported" - treat only an explicit false as a capability refusal, so a
  // first paint does not flash a "your host is too old" line at a host that supports it perfectly.
  if (args.supportsVersionManager === false) {
    return {
      kind: "unavailable",
      packId: args.packId,
      packDisplayName,
      message: managedVersionsUnavailableMessage("host-unsupported"),
    };
  }
  if (args.managedVersions === null || args.managedVersions === undefined) {
    const unavailable = args.managedVersionsUnavailable;
    if (unavailable === null || unavailable === undefined) return null;
    return {
      kind: "unavailable",
      packId: args.packId,
      packDisplayName,
      message: managedVersionsUnavailableMessage(unavailable.reason),
    };
  }
  return {
    kind: "panel",
    packId: args.packId,
    packDisplayName,
    managedVersions: args.managedVersions,
  };
}

/** Amp and cursor joined the host's set (their SDKs spawn their own copies, so Traycer vendors neither) and
 * would otherwise have rendered that bare table. */
/** `adding` forces the table because that is where the custom-path input lives: a user who opened it must still
 * be able to type, whatever the probe says. */
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

/** Deliberately says nothing about installing: at this point we do not know whether a binary exists, and the
 * missing notice's advice ("install it, or add its path below") is wrong often enough. */
function CliBinaryProbePendingNotice({
  providerLabel,
}: {
  readonly providerLabel: string;
}): ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-foreground/2 p-3 text-ui-sm text-muted-foreground">
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
  const openLink = useOpenLink();
  return (
    <div className="rounded-lg border border-border/60 bg-foreground/2 p-3 text-ui-sm text-muted-foreground">
      <p>
        No {providerLabel} CLI was found on this machine, and Traycer ships no
        bundled copy of it. Install it, or add its path below.
      </p>
      {installGuideUrl === null ? null : (
        <a
          href={installGuideUrl}
          onClick={(event) => {
            // oxlint-disable-next-line react-doctor/no-prevent-default -- `openLink` owns the open, not renderer navigation.
            // The app owns every URL egress (A6); the `href` stays for anchor
            event.preventDefault();
            void openLink(installGuideUrl, "docs", null);
          }}
          className="mt-1 inline-flex text-ui-xs font-medium text-primary transition-colors hover:text-primary/80 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded"
        >
          {providerLabel} installation guide
        </a>
      )}
    </div>
  );
}

/** Both of them spawn the Traycer-resolved binary for their MCP write verbs (`runAmpCliCapture`,
 * `runCursorMcpCli`), so this table was never decorative for them. */
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
  const [draftPath, setDraftPath] = useState("");
  // Read three-valued: `useHostSupportsMethod` collapses "not answered yet" into `false`, which this surface can
  // no longer use.
  const supportsVersionManager = useProviderPackVersionManagerSupport(hostId);
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

  // Normalize once: an old host's payload leaves the key genuinely absent (`undefined`), which reads identically
  // to an explicit `null` everywhere below.
  const managedInstallState = state.managedInstallState ?? null;
  // Derived from the whole row, which is the only place the fallback candidates live - the point of
  // `providerPackPreparingForProvider` taking a provider rather than a state.
  const packPreparing = providerPackPreparingForProvider(state);
  const versionManagerData = versionManagerPanelDataFor({
    hostId,
    supportsVersionManager,
    packId: state.packId,
    managedVersions: state.managedVersions,
    managedVersionsUnavailable: state.managedVersionsUnavailable,
  });
  // `availabilityPending` means the host's shell/PATH probe is still running, and the protocol is explicit that
  // `candidates` must not be trusted until it settles ("A pending row always carries `available.
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
          // The Version cell IS the control. It carries the reason too, so an
          // unavailable pack still has somewhere to say why.
          versionMenu: versionManagerData,
          versionMenuHostId: hostId,
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
  readonly versionMenu: VersionManagerPanelData | null;
  readonly versionMenuHostId: string | null;
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
  versionMenu,
  versionMenuHostId,
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
    <div
      className={cn(
        TABLE_GRID,
        "overflow-hidden rounded-lg border border-border/60",
      )}
    >
      <div
        className={cn(
          TABLE_ROW,
          "border-b border-border/40 bg-foreground/3 py-2 text-ui-xs font-medium text-muted-foreground",
        )}
      >
        <span />
        <span className={cn("min-w-0", TABLE_CELL_X)}>Path</span>
        {/* Right-aligned to match the cell below it, which now holds nothing
            but the version, so every row's version lands on this edge. */}
        <span className={cn("text-right", TABLE_CELL_X)}>Version</span>
        <span />
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
          versionMenu={candidate.kind === "bundled" ? versionMenu : null}
          versionMenuHostId={versionMenuHostId}
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
    // `col-span-4`: the table container is the shared grid the header and rows subgrid onto, so this form is a
    // grid item too - without it, it lands in the 2.25rem radio column and collapses to a sliver.
    <div className="col-span-4 flex flex-col gap-2 border-t border-border/40 bg-foreground/2 p-3">
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
  versionMenu,
  versionMenuHostId,
}: {
  readonly candidate: ProviderCliCandidate;
  // Provider-level (not per-candidate - see that schema's comment), so only meaningful for the bundled row;
  // other candidates ignore it.
  readonly managedInstallState: ProviderManagedInstallState | null;
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
  readonly versionMenu: VersionManagerPanelData | null;
  readonly versionMenuHostId: string | null;
}): ReactNode {
  const presentation = candidateRowPresentation({
    candidate,
    managedInstallState,
    packPreparing,
    nextRunBinary,
    advisory,
    selection,
    selected,
    differingSessionCount,
  });
  return (
    <div
      className={cn(
        TABLE_ROW,
        "border-b border-border/40 py-2.5 last:border-b-0 hover:bg-foreground/3",
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
      />
      <CandidateVersionCell
        candidate={candidate}
        unavailable={presentation.unavailable}
      />
      <CandidateRowActions
        candidate={candidate}
        busy={busy}
        onRemove={onRemove}
        versionMenu={versionMenu}
        versionMenuHostId={versionMenuHostId}
      />
      <RowStatusLine
        status={presentation.status}
        onRetry={onRetryPack}
        retrying={retryingPack}
      />
    </div>
  );
}

type CandidateRowPresentation = {
  readonly pathLabel: string;
  readonly pathAdvisory: string | null;
  readonly unavailable: boolean;
  readonly status: RowStatus | null;
};

function candidateRowPresentation(args: {
  readonly candidate: ProviderCliCandidate;
  readonly managedInstallState: ProviderManagedInstallState | null;
  readonly packPreparing: ProviderPackPreparing | null;
  readonly nextRunBinary: ProviderNextRunBinary | null;
  readonly advisory: ProviderCliState["advisory"] | null;
  readonly selection: ProviderSelection;
  readonly selected: boolean;
  readonly differingSessionCount: number;
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
    status: rowStatusFor({
      // The managed install, the pack-preparing derivation and the session count are all provider-level facts that
      // belong to the bundled row, so they are scoped here rather than at the call site.
      managedInstallState: isBundled ? args.managedInstallState : null,
      preparing: isBundled ? args.packPreparing : null,
      differingSessionCount: isBundled ? args.differingSessionCount : 0,
      // Not scoped: `nextRunMatchesSelection` has to know whether this provider has a managed pack at all to tell an
      // inline bundled fallback apart from the managed install that shares its row.
      providerManagedInstallState: args.managedInstallState,
      nextRunBinary: args.nextRunBinary,
      selection: args.selection,
      selected: args.selected,
    }),
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
    // `min-h-6` sets the row's content floor.
    <span className="flex min-h-6 items-center justify-center">
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
}: {
  readonly candidate: ProviderCliCandidate;
  readonly pathLabel: string;
  readonly pathAdvisory: string | null;
}): ReactNode {
  if (candidate.kind === "bundled") {
    // It is a status, not an identity, so it moved to the row's one status line where it takes its turn behind an
    // install failure or an install in flight.
    return (
      <span
        className={cn(
          "min-w-0 truncate text-ui-sm text-foreground",
          TABLE_CELL_X,
        )}
      >
        {pathLabel}
      </span>
    );
  }
  return (
    <ExternalCandidatePathCell candidate={candidate} advisory={pathAdvisory} />
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
  const advisoryRef = useRef<HTMLButtonElement>(null);
  const [dialogContainer, setDialogContainer] = useState<HTMLElement | null>(
    null,
  );
  return (
    <div className={cn("flex min-w-0 items-center gap-1", TABLE_CELL_X)}>
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
          collisionBoundary={dialogContainer}
          collisionPadding={8}
          onOpenChange={(next) => {
            if (!next) return;
            setDialogContainer(
              advisoryRef.current?.closest<HTMLElement>(
                '[data-slot="dialog-content"]',
              ) ?? null,
            );
          }}
        >
          <button
            ref={advisoryRef}
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

/** One subject: the version this row would run. */
function CandidateVersionCell({
  candidate,
  unavailable,
}: {
  readonly candidate: ProviderCliCandidate;
  readonly unavailable: boolean;
}): ReactNode {
  return (
    <span
      className={cn(
        "min-w-0 truncate text-right text-ui-sm tabular-nums",
        TABLE_CELL_X,
        unavailable ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {versionLabel(candidate)}
    </span>
  );
}

/** Anchored with the same dialog-scoped collision handling the other settings pickers use, so it cannot escape
 * the modal. */
function VersionMenuTrigger({
  data,
  hostId,
}: {
  readonly data: VersionManagerPanelData;
  readonly hostId: string | null;
}): ReactNode {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dialogContainer, setDialogContainer] = useState<HTMLElement | null>(
    null,
  );
  return (
    <Popover
      onOpenChange={(next) => {
        if (!next) return;
        setDialogContainer(
          triggerRef.current?.closest<HTMLElement>(
            '[data-slot="dialog-content"]',
          ) ?? null,
        );
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={`${data.packDisplayName} version`}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        container={dialogContainer ?? undefined}
        collisionBoundary={dialogContainer ?? undefined}
        collisionPadding={8}
        // Past the dialog's collision boundary the older rows and their Use / Delete controls were simply unreachable,
        // because `overflow-hidden` clips rather than scrolls.
        className="flex max-h-[min(70vh,32rem)] w-[min(90vw,26rem)] flex-col overflow-hidden p-0"
      >
        {data.kind === "unavailable" ? (
          <div className="px-4 py-3" data-testid="version-manager-unavailable">
            <p className="text-ui-sm font-medium text-foreground">
              {data.packDisplayName} versions are unavailable
            </p>
            <p className="mt-1 text-ui-xs text-muted-foreground">
              {data.message}
            </p>
          </div>
        ) : (
          <ProviderPackVersionManagerPanel
            packId={data.packId}
            packDisplayName={data.packDisplayName}
            managedVersions={data.managedVersions}
            hostId={hostId}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The two can never collide - `versionMenu` is only ever passed for the bundled candidate, and a custom row is
 * never bundled. */
function CandidateRowActions({
  candidate,
  busy,
  onRemove,
  versionMenu,
  versionMenuHostId,
}: {
  readonly candidate: ProviderCliCandidate;
  readonly busy: boolean;
  readonly onRemove: (path: string) => void;
  readonly versionMenu: VersionManagerPanelData | null;
  readonly versionMenuHostId: string | null;
}): ReactNode {
  if (candidate.kind === "custom") {
    return (
      <span className="flex items-center justify-center">
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
  if (versionMenu === null) {
    return <span className="flex items-center justify-center" />;
  }
  return (
    <span className="flex items-center justify-center">
      <VersionMenuTrigger data={versionMenu} hostId={versionMenuHostId} />
    </span>
  );
}

function versionLabel(candidate: ProviderCliCandidate): string {
  // Pending resolves inside the column rather than replacing it with a spinner and a label, so a probing row
  // keeps the same shape as every other row.
  if (candidate.versionPending) return "Checking…";
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

/** 4 genuinely is starved, and that is the accepted trade: it is a quiet, self-correcting count, and it is
 * never why someone opened this screen while 1-3 are true. */
type RowStatus =
  | {
      readonly kind: "install-failed";
      readonly text: string;
      readonly retryable: boolean;
    }
  | {
      readonly kind: "installing";
      readonly label: string;
      readonly percent: number | null;
      readonly note: string | null;
    }
  | { readonly kind: "substituted"; readonly text: string }
  | { readonly kind: "sessions"; readonly text: string };

function rowStatusFor(args: {
  /** Bundled-row-scoped: null on every other row. */
  readonly managedInstallState: ProviderManagedInstallState | null;
  readonly preparing: ProviderPackPreparing | null;
  readonly differingSessionCount: number;
  readonly providerManagedInstallState: ProviderManagedInstallState | null;
  readonly nextRunBinary: ProviderNextRunBinary | null;
  readonly selection: ProviderSelection;
  readonly selected: boolean;
}): RowStatus | null {
  // Non-null only on the row the radio picks, and only when the host says it will start something else.
  const runningInstead =
    args.selected &&
    args.nextRunBinary !== null &&
    !nextRunMatchesSelection(
      args.nextRunBinary,
      args.selection,
      args.providerManagedInstallState,
    )
      ? nextRunSourceLabel(args.nextRunBinary)
      : null;

  const managed = args.managedInstallState;
  if (managed?.status === "error") {
    const detail = managedInstallFailureMessage(
      managed.reason,
      managed.version ?? null,
    );
    return {
      kind: "install-failed",
      // What runs comes first. Leading with the failure is what made a provider that had cleanly fallen back read as
      // broken.
      text:
        runningInstead === null
          ? detail
          : `Running ${runningInstead}. ${detail}`,
      retryable:
        args.preparing !== null && providerPackRetryable(args.preparing),
    };
  }
  if (managed?.status === "downloading") {
    return {
      kind: "installing",
      label: installProgressLabel(managed.version ?? null, managed.percent),
      percent: managed.percent,
      note:
        runningInstead === null
          ? null
          : `Running ${runningInstead} until it's ready.`,
    };
  }
  if (runningInstead !== null) {
    return {
      kind: "substituted",
      text: `Not used right now — Traycer will start ${runningInstead} instead. Sessions already running keep the binary they started with.`,
    };
  }
  if (args.differingSessionCount > 0) {
    return {
      kind: "sessions",
      text: differentVersionSessionsLabel(args.differingSessionCount),
    };
  }
  return null;
}

function nextRunSourceLabel(nextRunBinary: ProviderNextRunBinary): string {
  switch (nextRunBinary.kind) {
    case "managed":
      return "the managed copy";
    case "bundled":
      return "the bundled build";
    case "path":
      return "the copy on your PATH";
    case "custom":
      return "your custom binary";
  }
}

function nextRunMatchesSelection(
  nextRunBinary: ProviderNextRunBinary,
  selection: ProviderSelection,
  managedInstallState: ProviderManagedInstallState | null,
): boolean {
  if (nextRunBinary.kind === "managed") {
    return selection.kind === "bundled";
  }
  // The inline `bundled` fallback and a managed install share the Managed UI row but are different binaries, so
  // that IS a substitution worth naming.
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

// "Bundled" while this provider still ships the still-inline binary (no install-state signal at all, whether
// an old host or T7 hasn't cut this provider over yet).
function bundledPathLabel(
  managedInstallState: ProviderManagedInstallState | null,
): string {
  return managedInstallState === null ? "Bundled" : "Managed";
}

/** The wrapper keeps its border, hover and dimming untouched - which is what lets a status appear and disappear
 * without any column resizing. */
function RowStatusLine({
  status,
  onRetry,
  retrying,
}: {
  readonly status: RowStatus | null;
  readonly onRetry: () => void;
  readonly retrying: boolean;
}): ReactNode {
  if (status === null) return null;
  if (status.kind === "installing") {
    // Clamp before the value reaches a width or an accessible name.
    const percent =
      status.percent === null
        ? null
        : Math.min(100, Math.max(0, Math.round(status.percent)));
    return (
      // Column layout also drops `shrink-0`, which only existed to stop the bar collapsing in that fight.
      <span className="col-span-3 col-start-2 mt-1.5 flex min-w-0 flex-col gap-1.5 px-2.5">
        <span className="min-w-0 text-ui-xs text-muted-foreground">
          {/* Own element so the visible progress label stays byte-identical to the progressbar's accessible name, whether
             or not a fallback clause follows it. */}
          <span>{status.label}</span>
          {status.note === null ? null : <span> · {status.note}</span>}
        </span>
        <span
          role="progressbar"
          aria-label={status.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent === null ? undefined : percent}
          // `max-w-48` is a fixed layout width, which this repo's UI rule excludes for layout surfaces - the track has
          // to shrink with a narrow settings dialog rather than hold a rem figure chosen against one window size.
          className="h-1 w-full max-w-[min(100%,30vw)] overflow-hidden rounded-full bg-foreground/8"
        >
          <span
            className={cn(
              "block h-full rounded-full bg-primary",
              percent === null ? "w-1/3 animate-pulse" : "",
            )}
            style={
              percent === null ? undefined : { width: `${String(percent)}%` }
            }
          />
        </span>
      </span>
    );
  }
  return (
    <span className="col-span-3 col-start-2 mt-1.5 flex min-w-0 items-start gap-1.5 px-2.5 text-ui-xs text-muted-foreground">
      {status.kind === "sessions" ? null : (
        <TriangleAlert
          className="mt-0.5 size-3.5 shrink-0 text-warning"
          aria-hidden="true"
        />
      )}
      {/* The reason is text, not a tooltip. */}
      <span className="min-w-0">{status.text}</span>
      {status.kind === "install-failed" && status.retryable ? (
        <button
          type="button"
          disabled={retrying}
          onClick={onRetry}
          className="shrink-0 rounded-md px-1.5 text-ui-xs font-medium text-primary underline-offset-2 transition-colors hover:underline disabled:opacity-50"
        >
          Retry
        </button>
      ) : null}
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
