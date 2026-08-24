import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Info, RotateCcw } from "lucide-react";
import {
  defaultShellArgs,
  isLoginShellFamily,
  windowsShellCaptionFamily,
} from "@traycer/protocol/config/shell-family";
import type {
  ConfigDetectedShell,
  ConfigEnvEntry,
} from "@traycer/protocol/host/config/index";
import type { ITraycerCli } from "@traycer-clients/shared/platform/runner-host";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { isWindows } from "@/lib/keybindings/platform";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SETTINGS_ROW_STACK } from "@/components/settings/settings-row-layout";
import {
  HostConfigUnsupportedNotice,
  LocalConfigFallbackNotice,
  NoConfigSourceNotice,
} from "@/components/settings/host-scope/host-config-notices";
import {
  HostScopeConnecting,
  HostScopeGate,
} from "@/components/settings/host-scope/host-scope-gate";
import {
  localConfigFallbackReason,
  type LocalConfigFallbackReason,
} from "@/components/settings/host-scope/host-scope-model";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import {
  useHostScope,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { EffectiveCommandPreview } from "@/components/settings/panels/shell/effective-command-preview";
import { EnvOverrideEditor } from "@/components/settings/panels/env-override-editor";
import { ShellFlagChips } from "@/components/settings/panels/shell/shell-flag-chips";
import { ShellProgramCombobox } from "@/components/settings/panels/shell/shell-program-combobox";
import type {
  ShellConfigController,
  ShellConfigSnapshot,
  ShellProbeSource,
} from "@/components/settings/panels/shell/shell-config-controller";
import { useBridgeShellConfigController } from "@/components/settings/panels/shell/use-bridge-shell-config-controller";
import { useRpcShellConfigController } from "@/components/settings/panels/shell/use-rpc-shell-config-controller";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { HostRuntimeContext } from "@/lib/host";
import { useHostCapabilityProbe } from "@/hooks/host/use-host-capability-probe";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
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
// the WSLg remedy behind a hover card instead of inline prose.
const WSL_INSTALL_DOCS_URL = "https://docs.traycer.ai/install#windows-via-wsl";

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

/**
 * The method every `config.shell.*` write travels beside. The whole family
 * lands in one host release, so one representative answers "can this host be
 * configured from here at all?" for the page.
 */
const SHELL_CONFIG_GATE_METHOD = "config.shell.get";

/**
 * Shell + host environment for the SELECTED host, over that host's own config
 * RPC — local and remote alike, one code path.
 *
 * The single exception is deliberate and lives in `localConfigFallbackReason`:
 * when the host being configured is THIS computer's and its process cannot
 * answer — stopped, or running a version that predates these methods — the
 * local CLI bridge answers instead, against the same on-disk store the host
 * loads, under a notice that says which. Both are states in which the RPC-only
 * page would go dark exactly when someone needs it: one while debugging a host
 * that will not start, the other for the whole window in which the app has
 * updated and the host it manages has not. Two paths, stated rather than hidden.
 *
 * A REMOTE host in either state gets the notice, not the bridge — there is no
 * local truth about it to fall back to.
 */
export function ShellSettingsPanel() {
  const scope = useHostScope();
  // Hoisted above the branch, because the branch itself depends on it. The
  // nullable form is load-bearing: `false` is a host that HANDSHAKED without
  // the methods, while `null` is "no handshake yet" — and the panel's own first
  // RPC is what produces one. Treating `null` as absent would divert a capable
  // host onto the bridge permanently, before its RPC path was ever tried.
  const supported = useHostMethodSupport(
    scope.hostId,
    SHELL_CONFIG_GATE_METHOD,
  );
  // Also before the branch — hooks may not be conditional. Null for every scope
  // that is not an explicit, resolved pick.
  const scopedBinding = useScopedHostBinding(scope);
  const fallbackReason = localConfigFallbackReason(scope.host, supported);
  // Both `false` outcomes below — the bridge fallback and the remote capability
  // notice — park every host read this page owns, which would also park the
  // handshake that overturns the verdict. The probe is what keeps the answer
  // refutable; `scope.client` (never the ambient one) so it asks the host this
  // page is actually showing.
  useHostCapabilityProbe({
    client: scope.client,
    stale: supported === false,
    incarnation: [
      scope.host?.version ?? null,
      scope.host?.connectable ?? false,
    ],
  });

  if (fallbackReason !== null) {
    return (
      <ShellSettingsPanelOverLocalStore
        hostName={scope.hostLabel}
        reason={fallbackReason}
      />
    );
  }

  const inner = (
    <SettingsPanelShell
      title="Shell"
      description={PANEL_DESCRIPTION}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <HostScopeGate
        scope={scope}
        skeleton={<HostScopeConnecting hostName={scope.hostLabel} />}
      >
        <ShellSettingsPanelOverRpc scope={scope} supported={supported} />
      </HostScopeGate>
    </SettingsPanelShell>
  );
  // Only a genuinely resolved override re-provides the runtime; `following`
  // already points at this host, and the non-ready states have no client at
  // all and fall to the gate above.
  if (scopedBinding === null) return inner;
  return (
    <HostRuntimeContext.Provider value={scopedBinding}>
      {inner}
    </HostRuntimeContext.Provider>
  );
}

/**
 * Everything that talks to the scoped host, mounted only once the gate has
 * proven there is a client behind the host name.
 */
function ShellSettingsPanelOverRpc(props: {
  readonly scope: HostScope;
  /** Resolved by the panel above, which branches on it. `null` = not yet known. */
  readonly supported: boolean | null;
}) {
  const { scope, supported } = props;
  const runnerHost = useRunnerHost();
  // A native file dialog can only name paths on THIS machine, so it is offered
  // only when this machine is the one being configured. Every other target
  // degrades to the picker's typed-path field, which works everywhere.
  const pickProgramFile =
    scope.host?.isLocalMachine === true
      ? (runnerHost.traycerCli?.pickShellProgramFile ?? null)
      : null;
  const controller = useRpcShellConfigController({
    enabled: supported !== false,
    pickProgramFile,
  });

  // Only a REMOTE host reaches this: a local one with the same answer took the
  // bridge fallback above, where there is a local store that describes it.
  if (supported === false) {
    return (
      <HostConfigUnsupportedNotice
        hostName={scope.hostLabel}
        subject="shell configuration"
      />
    );
  }
  return <ShellSettingsPanelBody controller={controller} notice={null} />;
}

/**
 * This computer's host, unable to answer for itself: the CLI bridge reads the
 * same on-disk store the host will load.
 */
function ShellSettingsPanelOverLocalStore(props: {
  readonly hostName: string;
  readonly reason: LocalConfigFallbackReason;
}) {
  const runnerHost = useRunnerHost();
  const traycerCli = runnerHost.traycerCli;
  if (traycerCli === null) {
    return (
      <SettingsPanelShell title="Shell" description={PANEL_DESCRIPTION}>
        <NoConfigSourceNotice hostName={props.hostName} />
      </SettingsPanelShell>
    );
  }
  return (
    <SettingsPanelShell
      title="Shell"
      description={PANEL_DESCRIPTION}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <ShellSettingsPanelOverBridge
        traycerCli={traycerCli}
        hostName={props.hostName}
        reason={props.reason}
      />
    </SettingsPanelShell>
  );
}

function ShellSettingsPanelOverBridge(props: {
  readonly traycerCli: ITraycerCli;
  readonly hostName: string;
  readonly reason: LocalConfigFallbackReason;
}) {
  const controller = useBridgeShellConfigController({
    traycerCli: props.traycerCli,
  });
  return (
    <ShellSettingsPanelBody
      controller={controller}
      notice={
        <LocalConfigFallbackNotice
          hostName={props.hostName}
          reason={props.reason}
        />
      }
    />
  );
}

/**
 * The editor itself, identical for both transports — see `ShellConfigController`
 * for why that identity is the point.
 */
function ShellSettingsPanelBody(props: {
  readonly controller: ShellConfigController;
  /** Rendered above the cards; the stopped-local banner, or nothing. */
  readonly notice: ReactNode;
}) {
  const { controller } = props;
  const compact = useSettingsDensity() === "compact";

  const config = controller.config;
  const shells = controller.shells;
  const overrides = controller.overrides;

  const shellPending = controller.shellPending;
  const envPending = controller.envPending;
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

  const shellSaveCallbacks = (target: ShellSaveTarget) => ({
    onSuccess: () => finishShellSave(target),
    onError: cancelShellSave,
  });
  const envSaveCallbacks = {
    onSuccess: finishEnvSave,
    onError: cancelEnvSave,
  };

  const onSavePath = (path: string): void => {
    if (shellPending) return;
    beginShellSave("program");
    controller.setShell({ path, args: null }, shellSaveCallbacks("program"));
  };
  const onAddShell = (path: string): void => {
    if (shellPending) return;
    beginShellSave("program");
    controller.addShell(path, shellSaveCallbacks("program"));
  };
  const onRemoveShell = (path: string): void => {
    if (shellPending) return;
    beginShellSave("program");
    controller.removeShell(path, shellSaveCallbacks("program"));
  };
  // Picking "System default" clears only the selection, returning to the login
  // shell; remembered shells and their flags are kept (the login shell's own
  // flags are inherited).
  const onUseSystemDefault = (): void => {
    if (shellPending) return;
    beginShellSave("program");
    controller.resetShell(shellSaveCallbacks("program"));
  };
  const onAddFlag = (flag: string): void => {
    if (config === undefined || shellPending) return;
    beginShellSave("flags");
    controller.setShell(
      { path: null, args: [...config.args, flag] },
      shellSaveCallbacks("flags"),
    );
  };
  const onRemoveFlag = (index: number): void => {
    if (config === undefined || shellPending) return;
    beginShellSave("flags");
    controller.setShell(
      { path: null, args: config.args.filter((_, i) => i !== index) },
      shellSaveCallbacks("flags"),
    );
  };
  // Restore the SELECTED shell's flags to its family default, keeping the shell
  // remembered. Works in the synthesised state too (reverting the login shell).
  const onRevertFlags = (): void => {
    if (config === undefined || shellPending) return;
    beginShellSave("flags");
    controller.revertShellArgs(config.path, shellSaveCallbacks("flags"));
  };
  const onEnvCommit = (
    oldKey: string,
    newKey: string,
    value: string | null,
  ): void => {
    if (envPending) return;
    beginEnvSave();
    if (oldKey === newKey) {
      controller.setEnv({ key: newKey, value }, envSaveCallbacks);
      return;
    }
    // ONE call, not a set whose per-`mutate` `onSuccess` fires the delete.
    // Chained here, the delete sat on the far side of an unmount boundary
    // TanStack does not cross: close Settings or switch host while the set is
    // in flight and the observer is gone, so the old key was never dropped and
    // the rename left two live variables. The controller owns the sequencing
    // now - create first, then drop, so a failed delete still leaves a
    // harmless duplicate rather than a lost value.
    controller.renameEnv({ oldKey, newKey, value }, envSaveCallbacks);
  };
  const onEnvDelete = (key: string): void => {
    if (envPending) return;
    beginEnvSave();
    controller.deleteEnv(key, envSaveCallbacks);
  };

  return (
    <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
      {props.notice}
      <TerminalShellGroup
        compact={compact}
        config={config}
        configError={controller.configError}
        onRetryConfig={controller.retryConfig}
        shells={shells}
        probeSource={controller.probeSource}
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
  );
}

/**
 * What the shell card shows when there is no config to show.
 *
 * A failed read is not a slow one, and these queries do not retry: without the
 * error arm a remote host that drops mid-read leaves the card skeletoning
 * forever, with no error text and no way back. Extracted rather than inlined so
 * the third state does not push `TerminalShellGroup` past the complexity ceiling.
 */
function ShellConfigUnavailable(props: {
  readonly compact: boolean;
  readonly configError: HostRpcError | null;
  readonly onRetryConfig: () => void;
}): ReactNode {
  if (props.configError === null) {
    return (
      <div className={cn(props.compact ? "p-4" : "p-5")}>
        <ShellCardSkeleton />
      </div>
    );
  }
  return (
    <div
      className={cn("space-y-3", props.compact ? "p-4" : "p-5")}
      data-testid="shell-config-read-failed"
    >
      <p className="text-ui-sm text-muted-foreground">
        Couldn&apos;t read this host&apos;s shell settings.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={props.onRetryConfig}
      >
        Try again
      </Button>
    </div>
  );
}

function TerminalShellGroup(props: {
  readonly compact: boolean;
  readonly config: ShellConfigSnapshot | undefined;
  readonly configError: HostRpcError | null;
  readonly onRetryConfig: () => void;
  readonly shells: readonly ConfigDetectedShell[];
  readonly probeSource: ShellProbeSource;
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
          <ShellConfigUnavailable
            compact={props.compact}
            configError={props.configError}
            onRetryConfig={props.onRetryConfig}
          />
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
                SETTINGS_ROW_STACK.container,
                props.compact ? "px-4 py-2.5" : "px-5 py-4",
              )}
            >
              <div
                className={cn(
                  "min-w-0 flex-1 space-y-1",
                  SETTINGS_ROW_STACK.label,
                )}
              >
                <div className="text-ui-sm font-medium text-foreground">
                  Shell program
                </div>
                <p className="text-ui-xs text-muted-foreground">
                  Pick a shell, or add any program on this machine.
                </p>
              </div>
              <div className="flex max-w-full flex-col items-end gap-1.5 max-md:items-start">
                <div className="flex max-w-full items-center gap-2">
                  <ShellProgramCombobox
                    value={config.path}
                    synthesised={config.synthesised}
                    shells={props.shells}
                    probeSource={props.probeSource}
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
                SETTINGS_ROW_STACK.container,
                props.compact ? "px-4 py-2.5" : "px-5 py-4",
              )}
            >
              <div
                className={cn(
                  "min-w-0 flex-1 space-y-1",
                  SETTINGS_ROW_STACK.label,
                )}
              >
                <div className="text-ui-sm font-medium text-foreground">
                  {`Startup flags for ${programName(config.path)}`}
                </div>
                <p className="text-ui-xs text-muted-foreground">
                  {isLoginShellFamily(config.path)
                    ? "“-i -l” loads your full shell profile (PATH, aliases)."
                    : `Passed to ${programName(config.path)} each time a terminal opens.`}
                </p>
              </div>
              <div
                className={cn(
                  "flex max-w-full flex-wrap items-center justify-end gap-2",
                  SETTINGS_ROW_STACK.control,
                )}
              >
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
 * The WSL boundary in one quiet line: the setting changes terminal tabs, but
 * the host and agent chats stay Windows processes. The full explanation and
 * the primary remedy (the Linux Traycer app running through WSLg) live
 * in the hover card - reachable because `HoverCard`'s close grace lets the
 * pointer travel into the card's link. The hover card is pointer-only, so the
 * Info glyph is itself a focusable anchor to the install page - keyboard
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
          WSL applies to terminal tabs only
          <a
            href={WSL_INSTALL_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Install Traycer in WSL"
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
          Choosing WSL here changes the shell for new terminal tabs. It does not
          move the Traycer host or agents into WSL.
        </p>
        <a
          href={WSL_INSTALL_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-block font-medium text-foreground underline underline-offset-4 hover:opacity-80"
        >
          Install Traycer in WSL
        </a>
      </HoverCardContent>
    </HoverCard>
  );
}

function HostEnvironmentGroup(props: {
  readonly compact: boolean;
  readonly overrides: readonly ConfigEnvEntry[];
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
            // muted-fill-ok: /15 wash under its own border-b border-border/40
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
      <div className="h-20 animate-pulse rounded-md bg-foreground/10" />
      <div className="h-9 animate-pulse rounded-md bg-foreground/10" />
    </div>
  );
}
