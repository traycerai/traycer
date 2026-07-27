import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Info, RotateCcw } from "lucide-react";
import {
  defaultShellArgs,
  isLoginShellFamily,
  windowsShellCaptionFamily,
} from "@traycer/protocol/config/shell-family";
import type {
  TraycerDetectedShell,
  TraycerEnvOverride,
  TraycerShellConfig,
} from "@traycer-clients/shared/platform/runner-host";
import { isWindows } from "@/lib/keybindings/platform";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { EffectiveCommandPreview } from "@/components/settings/panels/shell/effective-command-preview";
import { EnvOverrideEditor } from "@/components/settings/panels/env-override-editor";
import { ShellFlagChips } from "@/components/settings/panels/shell/shell-flag-chips";
import { ShellProgramCombobox } from "@/components/settings/panels/shell/shell-program-combobox";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useRunnerTraycerEnvOverrideDeleteMutation } from "@/hooks/runner/use-runner-traycer-env-override-delete-mutation";
import { useRunnerTraycerEnvOverrideListQuery } from "@/hooks/runner/use-runner-traycer-env-override-list-query";
import { useRunnerTraycerEnvOverrideSetMutation } from "@/hooks/runner/use-runner-traycer-env-override-set-mutation";
import { useRunnerTraycerShellConfigAddMutation } from "@/hooks/runner/use-runner-traycer-shell-add-mutation";
import { useRunnerTraycerShellConfigQuery } from "@/hooks/runner/use-runner-traycer-shell-config-query";
import { useRunnerTraycerShellConfigRemoveMutation } from "@/hooks/runner/use-runner-traycer-shell-remove-mutation";
import { useRunnerTraycerShellConfigResetMutation } from "@/hooks/runner/use-runner-traycer-shell-config-reset-mutation";
import { useRunnerTraycerShellConfigSetMutation } from "@/hooks/runner/use-runner-traycer-shell-config-set-mutation";
import { useRunnerTraycerShellRevertArgsMutation } from "@/hooks/runner/use-runner-traycer-shell-revert-args-mutation";
import { useRunnerTraycerShellListQuery } from "@/hooks/runner/use-runner-traycer-shell-list-query";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { useRunnerHost } from "@/providers/use-runner-host";

const PANEL_DESCRIPTION =
  "How Traycer launches terminals, the host, and provider harnesses. New terminals pick up shell changes immediately; host env changes apply on restart.";
const SAVED_FLASH_MS = 1600;
type ShellSaveTarget = "program" | "flags";

// WSL is the one shell selection where the choice silently diverges from what
// agents see: agent chats stay Windows processes, so tools installed inside
// WSL never reach them. Every other family behaves as users expect
// (PowerShell / Git Bash profiles are read into the agent env), so only WSL
// earns a caption (Windows hosts only) - one quiet line under the picker, with
// the remedy behind a hover card instead of inline prose.
const WSL_AGENTS_DOCS_URL = "https://docs.traycer.ai/settings/shell#using-wsl";

/** Final path segment of the resolved shell, used to name its flags. */
function programName(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/**
 * Whether the visible flags differ from the selected program's family default.
 * Thanks to the store's canonicalisation, this is exactly "a stored deviation
 * exists", and it drives the "Restore default flags" affordance.
 */
function flagsDeviateFromDefault(
  path: string,
  args: readonly string[],
): boolean {
  const familyDefault = defaultShellArgs(path);
  return (
    args.length !== familyDefault.length ||
    args.some((flag, i) => flag !== familyDefault[i])
  );
}

export function ShellSettingsPanel() {
  const runnerHost = useRunnerHost();
  if (runnerHost.traycerCli === null) {
    return (
      <SettingsPanelShell
        title="Shell"
        description="Shell and environment settings are only available on the desktop app."
      >
        <div className="px-6 py-8 text-ui-sm text-muted-foreground">
          This shell does not expose the local host CLI.
        </div>
      </SettingsPanelShell>
    );
  }
  return <ShellSettingsPanelInner />;
}

function ShellSettingsPanelInner() {
  const compact = useSettingsDensity() === "compact";
  const configQuery = useRunnerTraycerShellConfigQuery();
  const shellListQuery = useRunnerTraycerShellListQuery();
  const envListQuery = useRunnerTraycerEnvOverrideListQuery();
  const setMutation = useRunnerTraycerShellConfigSetMutation();
  const resetMutation = useRunnerTraycerShellConfigResetMutation();
  const addMutation = useRunnerTraycerShellConfigAddMutation();
  const removeMutation = useRunnerTraycerShellConfigRemoveMutation();
  const revertMutation = useRunnerTraycerShellRevertArgsMutation();
  const envSetMutation = useRunnerTraycerEnvOverrideSetMutation();
  const envDeleteMutation = useRunnerTraycerEnvOverrideDeleteMutation();

  const config = configQuery.data;
  const shells = shellListQuery.data ?? [];
  const overrides = envListQuery.data ?? [];

  const shellPending =
    setMutation.isPending ||
    resetMutation.isPending ||
    addMutation.isPending ||
    removeMutation.isPending ||
    revertMutation.isPending;
  const envPending = envSetMutation.isPending || envDeleteMutation.isPending;
  const [shellSaveTarget, setShellSaveTarget] =
    useState<ShellSaveTarget | null>(null);
  const [shellSavedTarget, setShellSavedTarget] =
    useState<ShellSaveTarget | null>(null);
  const [envSaveActive, setEnvSaveActive] = useState(false);
  const [envJustSaved, setEnvJustSaved] = useState(false);
  const shellSavedFlashRef = useRef<number | null>(null);
  const envSavedFlashRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (shellSavedFlashRef.current !== null) {
        window.clearTimeout(shellSavedFlashRef.current);
      }
      if (envSavedFlashRef.current !== null) {
        window.clearTimeout(envSavedFlashRef.current);
      }
    };
  }, []);

  const beginShellSave = (target: ShellSaveTarget): void => {
    if (shellSavedFlashRef.current !== null) {
      window.clearTimeout(shellSavedFlashRef.current);
      shellSavedFlashRef.current = null;
    }
    setShellSavedTarget(null);
    setShellSaveTarget(target);
  };
  const finishShellSave = (target: ShellSaveTarget): void => {
    setShellSaveTarget(null);
    setShellSavedTarget(target);
    shellSavedFlashRef.current = window.setTimeout(() => {
      shellSavedFlashRef.current = null;
      setShellSavedTarget(null);
    }, SAVED_FLASH_MS);
  };
  const cancelShellSave = (): void => {
    setShellSaveTarget(null);
  };
  const beginEnvSave = (): void => {
    if (envSavedFlashRef.current !== null) {
      window.clearTimeout(envSavedFlashRef.current);
      envSavedFlashRef.current = null;
    }
    setEnvJustSaved(false);
    setEnvSaveActive(true);
  };
  const finishEnvSave = (): void => {
    setEnvSaveActive(false);
    setEnvJustSaved(true);
    envSavedFlashRef.current = window.setTimeout(() => {
      envSavedFlashRef.current = null;
      setEnvJustSaved(false);
    }, SAVED_FLASH_MS);
  };
  const cancelEnvSave = (): void => {
    setEnvSaveActive(false);
  };

  const onSavePath = (path: string): void => {
    if (shellPending) return;
    beginShellSave("program");
    setMutation.mutate(
      { path, args: null },
      {
        onSuccess: () => finishShellSave("program"),
        onError: cancelShellSave,
      },
    );
  };
  const onAddShell = (path: string): void => {
    if (shellPending) return;
    beginShellSave("program");
    addMutation.mutate(
      { path },
      {
        onSuccess: () => finishShellSave("program"),
        onError: cancelShellSave,
      },
    );
  };
  const onRemoveShell = (path: string): void => {
    if (shellPending) return;
    beginShellSave("program");
    removeMutation.mutate(
      { path },
      {
        onSuccess: () => finishShellSave("program"),
        onError: cancelShellSave,
      },
    );
  };
  // Picking "System default" clears only the selection, returning to the login
  // shell; remembered shells and their flags are kept (the login shell's own
  // flags are inherited).
  const onUseSystemDefault = (): void => {
    if (shellPending) return;
    beginShellSave("program");
    resetMutation.mutate(undefined, {
      onSuccess: () => finishShellSave("program"),
      onError: cancelShellSave,
    });
  };
  const onAddFlag = (flag: string): void => {
    if (config === undefined || shellPending) return;
    beginShellSave("flags");
    setMutation.mutate(
      { path: null, args: [...config.args, flag] },
      {
        onSuccess: () => finishShellSave("flags"),
        onError: cancelShellSave,
      },
    );
  };
  const onRemoveFlag = (index: number): void => {
    if (config === undefined || shellPending) return;
    beginShellSave("flags");
    setMutation.mutate(
      {
        path: null,
        args: config.args.filter((_, i) => i !== index),
      },
      {
        onSuccess: () => finishShellSave("flags"),
        onError: cancelShellSave,
      },
    );
  };
  // Restore the SELECTED shell's flags to its family default, keeping the shell
  // remembered. Works in the synthesised state too (reverting the login shell).
  const onRevertFlags = (): void => {
    if (config === undefined || shellPending) return;
    beginShellSave("flags");
    revertMutation.mutate(
      { path: config.path },
      {
        onSuccess: () => finishShellSave("flags"),
        onError: cancelShellSave,
      },
    );
  };
  const onEnvCommit = (
    oldKey: string,
    newKey: string,
    value: string | null,
  ): void => {
    if (envPending) return;
    beginEnvSave();
    if (oldKey === newKey) {
      envSetMutation.mutate(
        { key: newKey, value },
        {
          onSuccess: finishEnvSave,
          onError: cancelEnvSave,
        },
      );
      return;
    }
    // Rename: create the new key first, then drop the old one so a failed
    // delete leaves a harmless duplicate rather than a lost value.
    envSetMutation.mutate(
      { key: newKey, value },
      {
        onSuccess: () => {
          if (oldKey.length > 0) {
            envDeleteMutation.mutate(
              { key: oldKey },
              {
                onSuccess: finishEnvSave,
                onError: cancelEnvSave,
              },
            );
          } else {
            finishEnvSave();
          }
        },
        onError: cancelEnvSave,
      },
    );
  };
  const onEnvDelete = (key: string): void => {
    if (envPending) return;
    beginEnvSave();
    envDeleteMutation.mutate(
      { key },
      {
        onSuccess: finishEnvSave,
        onError: cancelEnvSave,
      },
    );
  };

  return (
    <SettingsPanelShell
      title="Shell"
      description={PANEL_DESCRIPTION}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
        <TerminalShellGroup
          compact={compact}
          config={config}
          shells={shells}
          pending={shellPending}
          saveTarget={shellSaveTarget}
          savedTarget={shellSavedTarget}
          onSavePath={onSavePath}
          onAddShell={onAddShell}
          onRemoveShell={onRemoveShell}
          onUseSystemDefault={onUseSystemDefault}
          onAddFlag={onAddFlag}
          onRemoveFlag={onRemoveFlag}
          onRevertFlags={onRevertFlags}
        />

        <HostEnvironmentGroup
          compact={compact}
          overrides={overrides}
          pending={envPending}
          saveActive={envSaveActive}
          justSaved={envJustSaved}
          onCommit={onEnvCommit}
          onDelete={onEnvDelete}
        />
      </div>
    </SettingsPanelShell>
  );
}

function TerminalShellGroup(props: {
  readonly compact: boolean;
  readonly config: TraycerShellConfig | undefined;
  readonly shells: readonly TraycerDetectedShell[];
  readonly pending: boolean;
  readonly saveTarget: ShellSaveTarget | null;
  readonly savedTarget: ShellSaveTarget | null;
  readonly onSavePath: (path: string) => void;
  readonly onAddShell: (path: string) => void;
  readonly onRemoveShell: (path: string) => void;
  readonly onUseSystemDefault: () => void;
  readonly onAddFlag: (flag: string) => void;
  readonly onRemoveFlag: (index: number) => void;
  readonly onRevertFlags: () => void;
}) {
  const { config } = props;
  const showWslCaption =
    config !== undefined &&
    isWindows() &&
    windowsShellCaptionFamily(config.path) === "wsl";
  return (
    <SettingsGroup
      title="Terminal shell · New terminals"
      tone="default"
      dataTestId="terminal-shell-settings"
      fill={false}
    >
      <>
        <TransientSaveLiveStatus
          pending={props.pending ? props.saveTarget === "program" : false}
          saved={props.savedTarget === "program"}
          label="Shell program"
        />
        <TransientSaveLiveStatus
          pending={props.pending ? props.saveTarget === "flags" : false}
          saved={props.savedTarget === "flags"}
          label="Startup flags"
        />
        {config === undefined ? (
          <div className={props.compact ? "p-4" : "p-5"}>
            <ShellCardSkeleton />
          </div>
        ) : (
          <div>
            <div className={props.compact ? "p-3" : "p-5"}>
              <EffectiveCommandPreview path={config.path} args={config.args} />
            </div>
            <div
              className={cn(
                "flex flex-wrap justify-between gap-4 border-t border-border/40",
                // The WSL caption stacks under the picker in its own column,
                // so the row top-aligns only while it is shown.
                showWslCaption ? "items-start" : "items-center",
                props.compact ? "px-4 py-2.5" : "px-5 py-4",
              )}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-ui-sm font-medium text-foreground">
                  Shell program
                </div>
                <p className="text-ui-xs text-muted-foreground">
                  Pick a shell, or add any program on this machine.
                </p>
              </div>
              <div className="flex max-w-full flex-col items-end gap-1.5">
                <div className="flex max-w-full items-center gap-2">
                  <ShellProgramCombobox
                    value={config.path}
                    synthesised={config.synthesised}
                    shells={props.shells}
                    disabled={props.pending}
                    onSelect={props.onSavePath}
                    onAdd={props.onAddShell}
                    onRemove={props.onRemoveShell}
                    onUseSystemDefault={props.onUseSystemDefault}
                  />
                  <TransientSaveIndicator
                    pending={
                      props.pending ? props.saveTarget === "program" : false
                    }
                    saved={props.savedTarget === "program"}
                    testId="settings-shell-program-saving-spinner"
                  />
                </div>
                {showWslCaption ? <WslAgentCaption /> : null}
              </div>
            </div>
            <div
              className={cn(
                "flex flex-wrap items-start justify-between gap-4 border-t border-border/40",
                props.compact ? "px-4 py-2.5" : "px-5 py-4",
              )}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-ui-sm font-medium text-foreground">
                  {`Startup flags for ${programName(config.path)}`}
                </div>
                <p className="text-ui-xs text-muted-foreground">
                  {isLoginShellFamily(config.path)
                    ? "“-i -l” loads your full shell profile (PATH, aliases)."
                    : `Passed to ${programName(config.path)} each time a terminal opens.`}
                </p>
              </div>
              <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
                <ShellFlagChips
                  args={config.args}
                  disabled={props.pending}
                  onAdd={props.onAddFlag}
                  onRemove={props.onRemoveFlag}
                />
                <button
                  type="button"
                  disabled={
                    props.pending ||
                    !flagsDeviateFromDefault(config.path, config.args)
                  }
                  onClick={props.onRevertFlags}
                  className="inline-flex items-center gap-1 text-ui-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  <RotateCcw className="size-3" />
                  Restore default flags
                </button>
                <TransientSaveIndicator
                  pending={props.pending ? props.saveTarget === "flags" : false}
                  saved={props.savedTarget === "flags"}
                  testId="settings-shell-flags-saving-spinner"
                />
              </div>
            </div>
          </div>
        )}
      </>
    </SettingsGroup>
  );
}

/**
 * The WSL boundary in one quiet line: terminal tabs open in WSL, but
 * agent chats stay Windows processes, so WSL-installed tools never reach them.
 * The full explanation and the remedy (a Traycer host inside WSL) live
 * in the hover card - reachable because `HoverCard`'s close grace lets the
 * pointer travel into the card's link. The hover card is pointer-only, so the
 * Info glyph is itself a focusable anchor to the same docs page - keyboard
 * users reach the remedy without a mouse.
 */
function WslAgentCaption() {
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <span className="inline-flex cursor-default items-center gap-1.5 text-ui-xs text-muted-foreground">
          <span
            aria-hidden
            className="size-1.5 rounded-full bg-[var(--term-ansi-yellow)]"
          />
          Agents won&apos;t see tools installed in WSL
          <a
            href={WSL_AGENTS_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="How to run agents inside WSL"
            className="rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Info className="size-3" />
          </a>
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        align="end"
        className="w-[min(90vw,20rem)] space-y-2 text-ui-xs"
      >
        <p className="text-muted-foreground">
          Terminal tabs open in WSL, but agent chats run as Windows processes
          with the Windows environment.
        </p>
        <a
          href={WSL_AGENTS_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-block font-medium text-foreground underline underline-offset-4 hover:opacity-80"
        >
          Run agents inside WSL
        </a>
      </HoverCardContent>
    </HoverCard>
  );
}

function HostEnvironmentGroup(props: {
  readonly compact: boolean;
  readonly overrides: readonly TraycerEnvOverride[];
  readonly pending: boolean;
  readonly saveActive: boolean;
  readonly justSaved: boolean;
  readonly onCommit: (
    oldKey: string,
    newKey: string,
    value: string | null,
  ) => void;
  readonly onDelete: (key: string) => void;
}) {
  return (
    <SettingsGroup
      title="Host environment · After restart"
      tone="default"
      dataTestId="host-environment-settings"
      fill={false}
    >
      <>
        <TransientSaveLiveStatus
          pending={props.pending ? props.saveActive : false}
          saved={props.justSaved}
          label="Host environment"
        />
        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-3 border-b border-border/40 bg-muted/15",
            props.compact ? "px-4 py-2.5" : "px-5 py-3",
          )}
        >
          <p className="text-ui-xs text-muted-foreground">
            Per-provider environment variables live in Settings → Providers.
          </p>
          <TransientSaveIndicator
            pending={props.pending ? props.saveActive : false}
            saved={props.justSaved}
            testId="settings-shell-environment-saving-spinner"
          />
        </div>
        <div className={props.compact ? "p-4" : "p-5"}>
          <EnvOverrideEditor
            overrides={props.overrides}
            disabled={props.pending}
            namePlaceholder="OPENAI_API_KEY"
            emptyLabel="No host environment variables. The host starts with the environment your shell produces."
            onCommit={props.onCommit}
            onDelete={props.onDelete}
          />
        </div>
      </>
    </SettingsGroup>
  );
}

function TransientSaveLiveStatus(props: {
  readonly pending: boolean;
  readonly saved: boolean;
  readonly label: string;
}) {
  let text: string | null = null;
  if (props.pending) {
    text = `${props.label} saving`;
  } else if (props.saved) {
    text = `${props.label} saved`;
  }
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {text}
    </span>
  );
}

function TransientSaveIndicator(props: {
  readonly pending: boolean;
  readonly saved: boolean;
  readonly testId: string;
}) {
  let indicator: ReactNode = null;
  if (props.pending) {
    indicator = (
      <AgentSpinningDots
        className="text-muted-foreground"
        testId={props.testId}
        variant={undefined}
      />
    );
  } else if (props.saved) {
    indicator = (
      <Check aria-hidden className="size-3.5 text-[var(--term-ansi-green)]" />
    );
  }
  return indicator;
}

function ShellCardSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-20 animate-pulse rounded-md bg-muted/40" />
      <div className="h-9 animate-pulse rounded-md bg-muted/30" />
    </div>
  );
}
