import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown, X } from "lucide-react";
import type { TraycerDetectedShell } from "@traycer-clients/shared/platform/runner-host";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import {
  traycerShellProbeQueryOptions,
  useRunnerTraycerShellProbeQuery,
} from "@/hooks/runner/use-runner-traycer-shell-probe-query";
import { useRunnerHost } from "@/providers/use-runner-host";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { cn } from "@/lib/utils";

const PROBE_DEBOUNCE_MS = 250;

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function looksWindows(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\");
}

/** Case-insensitive when either side looks like a Windows path, exact otherwise. */
function samePath(a: string, b: string): boolean {
  return looksWindows(a) || looksWindows(b)
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * The concrete rows below "System default": detected ∪ added, plus a transient
 * row for a `value` that is neither (e.g. set via the CLI by hand) so the picker
 * never shows an unrepresented choice. Sorted purely alphabetically - the
 * "System default" row carries the auto concept, so default-first ordering no
 * longer means anything here. `matched` is the row (if any) the current value
 * pins to.
 */
function buildEntryList(
  shells: readonly TraycerDetectedShell[],
  value: string,
): { entries: TraycerDetectedShell[]; matched: TraycerDetectedShell | null } {
  const entries: TraycerDetectedShell[] = [...shells];
  if (!entries.some((entry) => samePath(entry.path, value))) {
    entries.push({
      name: basenameOf(value),
      path: value,
      isDefault: false,
      source: "detected",
      missing: false,
    });
  }
  entries.sort(
    (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  );
  const matched = entries.find((entry) => samePath(entry.path, value)) ?? null;
  return { entries, matched };
}

/**
 * The Settings → Shell picker: a first "System default" row (the auto option),
 * followed by one alphabetical list of concrete shells (detected plus the
 * user's remembered "added" ones) and an "Add a shell" section with a
 * live-validated path input and a native Browse action.
 *
 * "System default" is the single place the auto state lives: it is checked when
 * `synthesised`, and picking it clears the selection (returns to the login shell)
 * via `onUseSystemDefault` - remembered shells and their flags are kept, so it
 * stays checked even when the login shell has its own flag entry. A concrete row
 * is checked only when a shell is explicitly stored (`!synthesised`) and its path
 * matches. Selecting a concrete row auto-saves via `onSelect`; adding (Enter on a
 * green path, or a Browse pick that probes executable) auto-saves via `onAdd`;
 * the hover ✕ on an added row removes it via `onRemove` without closing the
 * popover.
 */
export function ShellProgramCombobox(props: {
  readonly value: string;
  readonly synthesised: boolean;
  readonly shells: readonly TraycerDetectedShell[];
  readonly disabled: boolean;
  readonly onSelect: (path: string) => void;
  readonly onAdd: (path: string) => void;
  readonly onRemove: (path: string) => void;
  readonly onUseSystemDefault: () => void;
}) {
  const {
    value,
    synthesised,
    shells,
    disabled,
    onSelect,
    onAdd,
    onRemove,
    onUseSystemDefault,
  } = props;
  const runnerHost = useRunnerHost();
  const traycerCli = runnerHost.traycerCli;
  const pickProgramFile = traycerCli?.pickShellProgramFile ?? null;
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  // The Settings modal is a Radix dialog that scroll-locks everything outside
  // its content shard (react-remove-scroll), so a body-portaled popover list is
  // un-scrollable by wheel/touch. Portaling into the dialog content puts the
  // list inside that shard; outside a dialog (Settings-as-tab) this stays null
  // and the popover falls back to the default body portal.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dialogContainer, setDialogContainer] = useState<HTMLElement | null>(
    null,
  );

  useEffect(() => {
    const trimmed = input.trim();
    const handle = setTimeout(() => setDebounced(trimmed), PROBE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [input]);

  const trimmedInput = input.trim();
  const inputIsAbsolute =
    trimmedInput.length > 0 && isAbsolutePath(trimmedInput);
  const probeQuery = useRunnerTraycerShellProbeQuery({
    path: debounced,
    enabled: open && debounced.length > 0 && isAbsolutePath(debounced),
  });
  // Only trust the probe result when it describes the value currently typed,
  // so a stale (pre-debounce) result never colours the status line.
  const probe =
    debounced === trimmedInput && inputIsAbsolute ? probeQuery.data : undefined;
  const canAdd = probe !== undefined && probe.exists && probe.executable;

  // The OS default powers the dedicated "System default" row; it still appears
  // as a concrete pickable row below (choosing it explicitly stores that path).
  const defaultEntry = shells.find((entry) => entry.isDefault) ?? null;

  const { entries, matched } = buildEntryList(shells, value);

  const closeAndReset = () => {
    setOpen(false);
    setInput("");
    setDebounced("");
  };

  const commitAdd = (path: string) => {
    onAdd(path);
    closeAndReset();
  };

  const commitSelect = (path: string) => {
    // While synthesised, `value` already equals the default path, but an
    // explicit pick still needs storing - it pins the shell so it no longer
    // follows the login shell.
    if (synthesised || !samePath(path, value)) onSelect(path);
    closeAndReset();
  };

  const onBrowse = async () => {
    if (pickProgramFile === null) return;
    try {
      const picked = await pickProgramFile();
      if (picked === null) return;
      setInput(picked);
      setDebounced(picked);
      // Same gate as a typed path: only an executable file is added outright; a
      // non-executable pick is left in the input so its amber status explains why.
      const result = await queryClient.fetchQuery(
        traycerShellProbeQueryOptions(traycerCli, picked, true),
      );
      if (result.exists && result.executable) commitAdd(picked);
    } catch (error) {
      toastFromRunnerError(error, "Failed to browse for a shell");
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          const content = triggerRef.current?.closest<HTMLElement>(
            '[data-slot="dialog-content"]',
          );
          setDialogContainer(content ?? null);
        }
        setOpen(next);
        if (!next) {
          setInput("");
          setDebounced("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          className="inline-flex w-[min(60vw,22rem)] items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left text-ui-sm transition-colors hover:bg-muted/50 disabled:opacity-50"
        >
          <TriggerLabel
            synthesised={synthesised}
            value={value}
            matched={matched}
            defaultEntry={defaultEntry}
          />
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        container={dialogContainer ?? undefined}
        collisionBoundary={dialogContainer ?? undefined}
        collisionPadding={8}
        className="w-[min(88vw,26rem)] p-0"
      >
        <div
          role="listbox"
          aria-label="Shells"
          className="max-h-[min(50vh,15rem)] overflow-y-auto py-1"
        >
          {defaultEntry !== null ? (
            <ShellOptionRow
              checked={synthesised}
              disabled={disabled}
              label="System default"
              labelMono={false}
              detail={`${defaultEntry.name} · ${defaultEntry.path}`}
              missing={false}
              testId="settings-shell-reset"
              onSelect={() => {
                onUseSystemDefault();
                closeAndReset();
              }}
              onRemove={null}
              removeLabel=""
            />
          ) : null}
          {entries.map((entry) => (
            <ShellOptionRow
              key={entry.path}
              checked={!synthesised && samePath(entry.path, value)}
              disabled={disabled}
              label={entry.name}
              labelMono
              detail={entry.path}
              missing={entry.missing}
              testId={null}
              onSelect={() => commitSelect(entry.path)}
              onRemove={
                entry.source === "added" ? () => onRemove(entry.path) : null
              }
              removeLabel={`Remove ${entry.name}`}
            />
          ))}
        </div>

        <div className="border-t border-border/60" />

        <div className="px-2 py-2">
          <div className="px-1 pb-1 text-ui-xs uppercase tracking-wide text-muted-foreground/70">
            Add a shell
          </div>
          <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 focus-within:border-border">
            <span className="shrink-0 font-mono text-[var(--term-ansi-green)]">
              ❯
            </span>
            <input
              type="text"
              value={input}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              aria-label="Add a shell by path"
              placeholder="Absolute path to any program…"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (canAdd) commitAdd(trimmedInput);
                }
              }}
              className="min-w-0 flex-1 bg-transparent font-mono text-code-sm outline-none placeholder:text-muted-foreground/60"
            />
            <button
              type="button"
              disabled={disabled || !canAdd}
              aria-label="Add this shell"
              onClick={() => commitAdd(trimmedInput)}
              className="shrink-0 rounded border border-border/60 px-1 text-ui-xs text-muted-foreground transition-colors hover:enabled:border-border hover:enabled:text-foreground disabled:opacity-50"
            >
              ⏎
            </button>
          </div>
          <ProbeStatus
            input={trimmedInput}
            isAbsolute={inputIsAbsolute}
            probe={probe}
          />
          {pickProgramFile !== null ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                void onBrowse();
              }}
              className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-ui-sm outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 disabled:opacity-50"
            >
              <span className="font-medium">Browse…</span>
              <span className="text-ui-xs text-muted-foreground">
                choose a program file
              </span>
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TriggerLabel(props: {
  readonly synthesised: boolean;
  readonly value: string;
  readonly matched: TraycerDetectedShell | null;
  readonly defaultEntry: TraycerDetectedShell | null;
}) {
  const { synthesised, value, matched, defaultEntry } = props;
  const storedName = matched !== null ? matched.name : basenameOf(value);
  const label = synthesised ? "System default" : storedName;
  const detail =
    synthesised && defaultEntry !== null
      ? `${defaultEntry.name} · ${value}`
      : value;
  return (
    <>
      <span className="shrink-0 font-mono font-medium">{label}</span>
      <StartTruncatedText className="min-w-0 flex-1 font-mono text-code-xs text-muted-foreground">
        {detail}
      </StartTruncatedText>
    </>
  );
}

/**
 * A single selectable option row (the System default row and every concrete
 * shell share this shape). A row that commits a selection and a nested remove
 * control cannot both be `<button>`, so the row is a `div[role=option]` (click +
 * Enter/Space) and the ✕ is a real `<button>` with `stopPropagation`.
 */
function ShellOptionRow(props: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly labelMono: boolean;
  readonly detail: string;
  readonly missing: boolean;
  readonly testId: string | null;
  readonly onSelect: () => void;
  readonly onRemove: (() => void) | null;
  readonly removeLabel: string;
}) {
  const {
    checked,
    disabled,
    label,
    labelMono,
    detail,
    missing,
    testId,
    onSelect,
    onRemove,
    removeLabel,
  } = props;
  return (
    <div
      role="option"
      aria-selected={checked}
      tabIndex={disabled ? -1 : 0}
      data-testid={testId ?? undefined}
      data-checked={checked ? "true" : "false"}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group flex cursor-pointer items-center gap-2 px-3 py-1.5 text-ui-sm outline-none",
        "hover:bg-accent/50 focus-visible:bg-accent/50 data-[checked=true]:bg-accent/30",
      )}
    >
      <Check
        className={cn(
          "size-3.5 shrink-0",
          checked ? "text-[var(--term-ansi-green)]" : "text-transparent",
        )}
      />
      <span className={cn("shrink-0 font-medium", labelMono && "font-mono")}>
        {label}
      </span>
      {/* A vanished (uninstalled) shell keeps its removable row but takes the
          amber validation tone, echoing the add-time probe's "not found". */}
      <StartTruncatedText
        className={cn(
          "min-w-0 flex-1 font-mono text-code-xs",
          missing ? "text-[var(--term-ansi-yellow)]" : "text-muted-foreground",
        )}
      >
        {detail}
      </StartTruncatedText>
      {missing ? (
        <span className="shrink-0 text-ui-xs text-[var(--term-ansi-yellow)]/80">
          not found
        </span>
      ) : null}
      {onRemove !== null ? (
        <button
          type="button"
          disabled={disabled}
          aria-label={removeLabel}
          onClick={(event) => {
            event.stopPropagation();
            if (!disabled) onRemove();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.stopPropagation();
            }
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-[var(--term-ansi-red)] focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function ProbeStatus(props: {
  readonly input: string;
  readonly isAbsolute: boolean;
  readonly probe:
    { readonly exists: boolean; readonly executable: boolean } | undefined;
}) {
  const { input, isAbsolute, probe } = props;
  let content: { text: string; tone: "muted" | "ok" | "warn" } | null = null;
  if (input.length === 0) {
    content = null;
  } else if (!isAbsolute) {
    content = { text: "an absolute path is required", tone: "muted" };
  } else if (probe === undefined) {
    content = null;
  } else if (probe.exists && probe.executable) {
    content = { text: "✓ found · executable", tone: "ok" };
  } else if (probe.exists) {
    content = { text: "found, but not executable", tone: "warn" };
  } else {
    content = { text: "not found on this machine", tone: "warn" };
  }
  return (
    <div className="min-h-[1.25rem] px-1 py-1 text-ui-xs">
      {content !== null ? (
        <span
          className={cn(
            content.tone === "ok" && "text-[var(--term-ansi-green)]",
            content.tone === "warn" && "text-[var(--term-ansi-yellow)]",
            content.tone === "muted" && "text-muted-foreground",
          )}
        >
          {content.text}
        </span>
      ) : null}
    </div>
  );
}
