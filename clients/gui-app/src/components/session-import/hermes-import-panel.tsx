/**
 * The Hermes profile rows of the import wizard: a directory on the picked
 * host, a scan of what it holds, the rows to tick (bundled skills unchecked),
 * where they go, a one-sentence summary, and the run's per-item outcome.
 *
 * Rehostable by construction: it takes the host's client and reports an
 * "open the identity" through `onOpenIdentity`, as the identities list panel
 * does, so the same body can serve a Settings section later. The rows reuse
 * the session wizard's checkbox-row shape (`role="checkbox"` on the row) but
 * not its scan store: a profile is a directory the user names, not a session
 * catalogue the host streams.
 */
import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, Minus, ScanSearch } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { AgentIdentitySummary } from "@traycer/protocol/host/agent-identity/schemas";
import type {
  AgentIdentityHermesRunItemResult,
  AgentIdentityHermesRunResponse,
  AgentIdentityHermesScanItem,
  AgentIdentityHermesScanResponse,
} from "@traycer/protocol/host/agent-identity/unary-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  useIdentityHermesRunForClient,
  useIdentityHermesScanForClient,
} from "@/hooks/identities/use-identity-mutations";
import { useIdentityListForClient } from "@/hooks/identities/use-identity-queries";
import type { HostRpcRegistry } from "@/lib/host";
import { identityRefusalCopy } from "@/lib/identities/refusal-copy";
import { cn } from "@/lib/utils";
import {
  countHermesSelection,
  defaultHermesSelection,
  HERMES_DEFAULT_DIRECTORY,
  hermesImportSummary,
  hermesItemRelPath,
  hermesRunRequest,
  hermesRunSubmittable,
  hermesTargetMemoryForScan,
  hermesTargetOfKind,
  rememberHermesTarget,
  type HermesImportTarget,
  type HermesTargetMemory,
} from "./hermes-import-model";

type ScanState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "scanned";
      readonly directory: string;
      readonly response: AgentIdentityHermesScanResponse;
    }
  | { readonly phase: "failed"; readonly message: string };

type RunState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "done";
      readonly response: AgentIdentityHermesRunResponse;
    }
  | { readonly phase: "failed"; readonly message: string };

export function HermesImportPanel(props: {
  readonly hostId: string;
  readonly client: HostClient<HostRpcRegistry> | null;
  /** Opens the identity a run imported into; the caller owns navigation. */
  readonly onOpenIdentity: (identity: AgentIdentitySummary) => void;
  readonly onClose: () => void;
}): ReactNode {
  const { client, onOpenIdentity, onClose } = props;
  const scan = useIdentityHermesScanForClient(client);
  const run = useIdentityHermesRunForClient(client);
  const [directory, setDirectory] = useState(HERMES_DEFAULT_DIRECTORY);
  const [scanState, setScanState] = useState<ScanState>({ phase: "idle" });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [targetMemory, setTargetMemory] = useState<HermesTargetMemory>(() =>
    hermesTargetMemoryForScan(null),
  );
  const [target, setTarget] = useState<HermesImportTarget>(() =>
    hermesTargetOfKind("new", hermesTargetMemoryForScan(null)),
  );
  const [runState, setRunState] = useState<RunState>({ phase: "idle" });
  const identities = useIdentityListForClient(client, client !== null);

  const changeTarget = (next: HermesImportTarget): void => {
    setTarget(next);
    setTargetMemory((current) => rememberHermesTarget(current, next));
  };

  /**
   * Editing the folder RETIRES the scan: the rows and the Import action
   * describe the directory that was scanned, and a run always submits that
   * directory, so leaving them up under a different path would import the
   * previous profile while the field names the new one (finding 49). The
   * results return on the next Scan.
   */
  const changeDirectory = (next: string): void => {
    setDirectory(next);
    if (scanState.phase !== "idle") setScanState({ phase: "idle" });
    if (runState.phase !== "idle") setRunState({ phase: "idle" });
  };

  const submitScan = async (): Promise<void> => {
    const trimmed = directory.trim();
    if (trimmed.length === 0 || scan.isPending) return;
    setScanState({ phase: "idle" });
    setRunState({ phase: "idle" });
    try {
      const response = await scan.mutateAsync({ directory: trimmed });
      setScanState({ phase: "scanned", directory: trimmed, response });
      if (response.kind === "profile") {
        setSelected(defaultHermesSelection(response.items));
        // A new scan is a new profile: what the picker remembered about the
        // last one (a typed title, a picked identity) goes with it. A target
        // already on an existing identity keeps that identity in view.
        const memory = hermesTargetMemoryForScan(response.profileName);
        setTargetMemory(memory);
        setTarget((current) =>
          current.kind === "new" ? hermesTargetOfKind("new", memory) : current,
        );
      }
    } catch (error) {
      setScanState({
        phase: "failed",
        message:
          error instanceof Error && error.message.length > 0
            ? error.message
            : "The host couldn't read that path.",
      });
    }
  };

  const toggle = (relPath: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  const submitRun = async (
    directoryScanned: string,
    items: readonly AgentIdentityHermesScanItem[],
  ): Promise<void> => {
    if (run.isPending || !hermesRunSubmittable(selected, target)) return;
    setRunState({ phase: "idle" });
    try {
      const response = await run.mutateAsync(
        hermesRunRequest({
          directory: directoryScanned,
          items,
          selected,
          target,
        }),
      );
      setRunState({ phase: "done", response });
    } catch (error) {
      setRunState({
        phase: "failed",
        message:
          error instanceof Error && error.message.length > 0
            ? error.message
            : "The import failed.",
      });
    }
  };

  if (runState.phase === "done") {
    return (
      <HermesRunResult
        response={runState.response}
        onOpenIdentity={onOpenIdentity}
        onClose={onClose}
        onBack={() => setRunState({ phase: "idle" })}
      />
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4"
      data-testid="hermes-import-panel"
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submitScan();
        }}
      >
        <Input
          value={directory}
          aria-label="Hermes profile folder"
          placeholder={HERMES_DEFAULT_DIRECTORY}
          disabled={scan.isPending || run.isPending}
          onChange={(event) => changeDirectory(event.target.value)}
          data-testid="hermes-import-directory"
        />
        <Button
          type="submit"
          size="sm"
          variant="muted"
          disabled={
            directory.trim().length === 0 || scan.isPending || run.isPending
          }
          data-testid="hermes-import-scan"
        >
          <ScanSearch className="size-3.5" />
          Scan
        </Button>
      </form>
      <p className="text-ui-xs text-muted-foreground">
        The default profile is <code>~/.hermes</code>; a named one is{" "}
        <code>~/.hermes/profiles/&lt;name&gt;</code>. Configuration, secrets,
        sessions and schedules are never read.
      </p>
      {scan.isPending ? (
        <div
          className="flex items-center gap-2 text-ui-sm text-muted-foreground"
          role="status"
          data-testid="hermes-import-scanning"
        >
          <MutedAgentSpinner />
          Reading the profile…
        </div>
      ) : null}
      {scanState.phase === "failed" ? (
        <PanelNotice testId="hermes-import-scan-failed" tone="warn">
          {scanState.message}
        </PanelNotice>
      ) : null}
      {scanState.phase === "scanned" &&
      scanState.response.kind === "notAProfile" ? (
        <PanelNotice testId="hermes-import-not-a-profile" tone="warn">
          {scanState.response.detail}
        </PanelNotice>
      ) : null}
      {scanState.phase === "scanned" &&
      scanState.response.kind === "profile" ? (
        <HermesScanBody
          items={scanState.response.items}
          selected={selected}
          onToggle={toggle}
          target={target}
          targetMemory={targetMemory}
          onTargetChange={changeTarget}
          identities={identities.data?.identities ?? null}
          identitiesFailed={identities.isError}
          running={run.isPending}
          runFailure={runState.phase === "failed" ? runState.message : null}
          onSubmit={() =>
            void submitRun(
              scanState.directory,
              scanState.response.kind === "profile"
                ? scanState.response.items
                : [],
            )
          }
        />
      ) : null}
    </div>
  );
}

function HermesScanBody(props: {
  readonly items: readonly AgentIdentityHermesScanItem[];
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (relPath: string) => void;
  readonly target: HermesImportTarget;
  readonly targetMemory: HermesTargetMemory;
  readonly onTargetChange: (target: HermesImportTarget) => void;
  readonly identities: readonly AgentIdentitySummary[] | null;
  readonly identitiesFailed: boolean;
  readonly running: boolean;
  readonly runFailure: string | null;
  readonly onSubmit: () => void;
}): ReactNode {
  const {
    items,
    selected,
    onToggle,
    target,
    targetMemory,
    onTargetChange,
    identities,
    identitiesFailed,
    running,
    runFailure,
    onSubmit,
  } = props;
  const counts = countHermesSelection(items, selected);
  const existingTitle =
    target.kind === "existing"
      ? (identities?.find((row) => row.identityId === target.identityId)
          ?.title ?? null)
      : null;
  const submittable = hermesRunSubmittable(selected, target) && !running;
  const skills = items.filter((item) => item.kind === "skill");
  const unreadable = items.filter(
    (
      item,
    ): item is Extract<AgentIdentityHermesScanItem, { kind: "unreadable" }> =>
      item.kind === "unreadable",
  );
  const soulAndMemories = items.filter(
    (item) => item.kind === "soul" || item.kind === "memory",
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
        data-testid="hermes-import-rows"
      >
        <RowGroupHeading>Persona and memories</RowGroupHeading>
        {soulAndMemories.map((item) => (
          <HermesItemRow
            key={hermesItemRelPath(item)}
            item={item}
            selected={selected.has(hermesItemRelPath(item))}
            disabled={running}
            onToggle={onToggle}
          />
        ))}
        {skills.length > 0 ? <RowGroupHeading>Skills</RowGroupHeading> : null}
        {skills.map((item) => (
          <HermesItemRow
            key={hermesItemRelPath(item)}
            item={item}
            selected={selected.has(hermesItemRelPath(item))}
            disabled={running}
            onToggle={onToggle}
          />
        ))}
        {unreadable.length > 0 ? (
          <RowGroupHeading>Skipped</RowGroupHeading>
        ) : null}
        {unreadable.map((item) => (
          <HermesUnreadableRow key={`unreadable:${item.relPath}`} item={item} />
        ))}
      </div>
      <HermesTargetPicker
        target={target}
        memory={targetMemory}
        onChange={onTargetChange}
        identities={identities}
        identitiesFailed={identitiesFailed}
        disabled={running}
      />
      <div className="flex items-center gap-3 border-t border-border/60 pt-3">
        <p
          className="min-w-0 flex-1 text-ui-sm text-muted-foreground"
          data-testid="hermes-import-summary"
        >
          {runFailure ?? hermesImportSummary(counts, target, existingTitle)}
        </p>
        {running ? <MutedAgentSpinner /> : null}
        <Button
          type="button"
          size="sm"
          disabled={!submittable}
          onClick={onSubmit}
          data-testid="hermes-import-run"
        >
          Import
        </Button>
      </div>
    </div>
  );
}

function RowGroupHeading(props: { readonly children: ReactNode }): ReactNode {
  return (
    <p className="px-1.5 pt-2 pb-0.5 text-ui-xs font-medium text-muted-foreground">
      {props.children}
    </p>
  );
}

function itemTitle(
  item: Exclude<AgentIdentityHermesScanItem, { kind: "unreadable" }>,
): string {
  if (item.kind === "soul") return "SOUL.md";
  if (item.kind === "memory") return item.relPath;
  return item.name;
}

function itemMeta(
  item: Exclude<AgentIdentityHermesScanItem, { kind: "unreadable" }>,
): string {
  if (item.kind === "soul") {
    return `${item.characters.toLocaleString()} characters`;
  }
  if (item.kind === "memory") {
    return `${item.entries.toLocaleString()} ${item.entries === 1 ? "entry" : "entries"}`;
  }
  return item.description ?? item.relPath;
}

/**
 * The session wizard's row shape: the whole row is the checkbox, with the
 * visual box in the first column and no interactive element nested inside.
 */
function HermesItemRow(props: {
  readonly item: Exclude<AgentIdentityHermesScanItem, { kind: "unreadable" }>;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onToggle: (relPath: string) => void;
}): ReactNode {
  const { item, selected, disabled, onToggle } = props;
  const relPath = hermesItemRelPath(item);
  const bundled = item.kind === "skill" && item.bundled;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-disabled={disabled}
      aria-label={itemTitle(item)}
      data-testid="hermes-import-row"
      data-rel-path={relPath}
      data-bundled={bundled}
      onClick={() => {
        if (!disabled) onToggle(relPath);
      }}
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60",
        disabled && "cursor-default opacity-55",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-current/40 text-muted-foreground",
        )}
      >
        {selected ? <Check className="size-3" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="min-w-0 truncate text-ui-sm text-foreground">
          {itemTitle(item)}
        </span>
        <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
          {itemMeta(item)}
        </span>
      </span>
      {bundled ? (
        <TooltipWrapper
          label="Shipped with Hermes and unchanged. Traycer's stock skills already cover these, so it is unticked by default."
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <span className="shrink-0 rounded bg-foreground/8 px-1.5 py-0.5 text-ui-xs text-muted-foreground">
            Bundled
          </span>
        </TooltipWrapper>
      ) : null}
    </button>
  );
}

function HermesUnreadableRow(props: {
  readonly item: Extract<AgentIdentityHermesScanItem, { kind: "unreadable" }>;
}): ReactNode {
  const { item } = props;
  return (
    <TooltipWrapper
      label={item.detail}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <div
        data-testid="hermes-import-row"
        data-rel-path={item.relPath}
        data-unreadable="true"
        className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left opacity-55"
      >
        <span
          aria-hidden
          className="flex size-4 shrink-0 items-center justify-center rounded-sm border border-current/40 text-muted-foreground"
        >
          <Minus className="size-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
          {item.relPath}
        </span>
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          {item.reason === "source_empty" ? "Empty" : "Can't read"}
        </span>
      </div>
    </TooltipWrapper>
  );
}

/**
 * Stateless: the target and what a radio flip restores (`memory`) both
 * belong to the panel, which resets them on every scan.
 */
function HermesTargetPicker(props: {
  readonly target: HermesImportTarget;
  readonly memory: HermesTargetMemory;
  readonly onChange: (target: HermesImportTarget) => void;
  readonly identities: readonly AgentIdentitySummary[] | null;
  readonly identitiesFailed: boolean;
  readonly disabled: boolean;
}): ReactNode {
  const { target, memory, onChange, identities, identitiesFailed, disabled } =
    props;
  const rows = identities ?? [];

  return (
    <div className="flex flex-col gap-2" data-testid="hermes-import-target">
      <Label variant="muted">Import into</Label>
      <RadioGroup
        value={target.kind}
        disabled={disabled}
        onValueChange={(value) =>
          onChange(
            hermesTargetOfKind(value === "new" ? "new" : "existing", memory),
          )
        }
        className="sm:grid-cols-2"
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem
            value="new"
            id="hermes-import-target-new"
            data-testid="hermes-import-target-new"
          />
          <Label htmlFor="hermes-import-target-new">New identity</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem
            value="existing"
            id="hermes-import-target-existing"
            data-testid="hermes-import-target-existing"
            disabled={disabled || rows.length === 0}
          />
          <Label htmlFor="hermes-import-target-existing">
            Existing identity
          </Label>
          {identitiesFailed ? (
            <span className="text-ui-xs text-muted-foreground">
              (couldn&apos;t load)
            </span>
          ) : null}
        </div>
      </RadioGroup>
      {target.kind === "new" ? (
        <Input
          value={target.title}
          aria-label="New identity name"
          placeholder="Identity name"
          disabled={disabled}
          onChange={(event) =>
            onChange({ kind: "new", title: event.target.value })
          }
          data-testid="hermes-import-title"
        />
      ) : (
        <Select
          value={target.identityId.length > 0 ? target.identityId : undefined}
          disabled={disabled}
          onValueChange={(identityId) =>
            onChange({ kind: "existing", identityId })
          }
        >
          <SelectTrigger
            size="sm"
            aria-label="Existing identity"
            className="w-full"
            data-testid="hermes-import-existing"
          >
            <SelectValue placeholder="Choose an identity" />
          </SelectTrigger>
          <SelectContent>
            {rows.map((row) => (
              <SelectItem key={row.identityId} value={row.identityId}>
                {row.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function OutcomeGlyph(props: {
  readonly outcome: AgentIdentityHermesRunItemResult["outcome"];
}): ReactNode {
  if (props.outcome === "failed") {
    return (
      <AlertTriangle className="size-4 shrink-0 text-warning-foreground" />
    );
  }
  if (props.outcome === "imported") {
    return <Check className="size-4 shrink-0 text-success-foreground" />;
  }
  return <Minus className="size-4 shrink-0 text-muted-foreground" />;
}

function outcomeLabel(item: AgentIdentityHermesRunItemResult): string {
  if (item.outcome === "imported") {
    return item.truncated ? "Imported, truncated" : "Imported";
  }
  return item.outcome === "skipped" ? "Skipped" : "Failed";
}

function HermesRunResult(props: {
  readonly response: AgentIdentityHermesRunResponse;
  readonly onOpenIdentity: (identity: AgentIdentitySummary) => void;
  readonly onClose: () => void;
  readonly onBack: () => void;
}): ReactNode {
  const { response, onOpenIdentity, onClose, onBack } = props;
  if (response.kind === "refused") {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4"
        data-testid="hermes-import-refused"
      >
        <PanelNotice testId="hermes-import-refusal" tone="warn">
          {identityRefusalCopy(response.reason)}
        </PanelNotice>
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="muted" onClick={onBack}>
            Back
          </Button>
          <Button type="button" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    );
  }
  const failed = response.items.filter((item) => item.outcome === "failed");
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4"
      data-testid="hermes-import-result"
    >
      <p className="text-ui-sm text-foreground">
        Imported into “{response.identity.title}”
        {failed.length > 0
          ? ` with ${failed.length.toLocaleString()} ${failed.length === 1 ? "item" : "items"} that failed.`
          : "."}
      </p>
      <ul
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
        data-testid="hermes-import-result-rows"
      >
        {response.items.map((item) => (
          <li
            key={item.relPath}
            className="flex min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1.5"
            data-outcome={item.outcome}
            data-truncated={item.truncated}
          >
            <OutcomeGlyph outcome={item.outcome} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="min-w-0 truncate text-ui-sm text-foreground">
                {item.relPath}
              </span>
              {item.detail !== null ? (
                <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
                  {item.detail}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-ui-xs text-muted-foreground">
              {outcomeLabel(item)}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-3">
        <Button type="button" size="sm" variant="muted" onClick={onClose}>
          Close
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => onOpenIdentity(response.identity)}
          data-testid="hermes-import-open-identity"
        >
          Open identity
        </Button>
      </div>
    </div>
  );
}

function PanelNotice(props: {
  readonly testId: string;
  readonly tone: "warn";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <p
      role="status"
      data-testid={props.testId}
      className="rounded-md border border-border/60 px-3 py-2 text-ui-sm text-muted-foreground"
    >
      {props.children}
    </p>
  );
}
