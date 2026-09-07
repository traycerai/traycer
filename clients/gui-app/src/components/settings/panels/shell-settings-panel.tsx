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
import { useOpenLink } from "@/lib/links/open-link";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { useRunnerHost } from "@/providers/use-runner-host";

const PANEL_DESCRIPTION =
  "How Traycer launches terminals, the host, and provider harnesses. New terminals pick up shell changes immediately; host env changes apply on restart.";
const SAVED_FLASH_MS = 1600;
type ShellSaveTarget = "program" | "flags";

// Wsl is the one shell selection where the choice silently diverges from what agents see: agent chats stay
// Windows processes, so tools installed inside wsl never reach them.
const WSL_INSTALL_DOCS_URL = "https://docs.traycer.ai/install#windows-via-wsl";

/** `href` stays for anchor semantics; the click goes through `openLink` because the app owns every URL egress
 * (A6) and a bare `target="_blank"` would bypass the setting entirely. */
function WslInstallDocsLink(props: {
  readonly className: string;
  readonly ariaLabel: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const openLink = useOpenLink();
  return (
    <a
      href={WSL_INSTALL_DOCS_URL}
      aria-label={props.ariaLabel}
      className={props.className}
      onClick={(event) => {
        event.preventDefault();
        void openLink(WSL_INSTALL_DOCS_URL, "docs", null);
      }}
    >
      {props.children}
    </a>
  );
}

function programName(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/** Whether the visible flags differ from the selected program's family default. */
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

/** The method every `config.shell.*` write travels beside. */
const SHELL_CONFIG_GATE_METHOD = "config.shell.get";

/** The single exception is deliberate and lives in `localConfigFallbackReason`: when the host being configured
 * is this computer's and its process cannot answer - stopped, or running a version that predates these */
export function ShellSettingsPanel() {
  const scope = useHostScope();
  // Treating `null` as absent would divert a capable host onto the bridge permanently, before its RPC path was
  // ever tried.
  const supported = useHostMethodSupport(
    scope.hostId,
    SHELL_CONFIG_GATE_METHOD,
  );
  // Also before the branch - hooks may not be conditional. Null for every scope that is not an explicit,
  // resolved pick.
  const scopedBinding = useScopedHostBinding(scope);
  const fallbackReason = localConfigFallbackReason(scope.host, supported);
  // The probe is what keeps the answer refutable; `scope.client` (never the ambient one) so it asks the host
  // this page is actually showing.
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
  // Only a genuinely resolved override re-provides the runtime; `following` already points at this host, and the
  // non-ready states have no client at all and fall to the gate above.
  if (scopedBinding === null) return inner;
  return (
    <HostRuntimeContext.Provider value={scopedBinding}>
      {inner}
    </HostRuntimeContext.Provider>
  );
}

/** Everything that talks to the scoped host, mounted only once the gate has proven there is a client behind the
 * host name. */
function ShellSettingsPanelOverRpc(props: {
  readonly scope: HostScope;
  readonly supported: boolean | null;
}) {
  const { scope, supported } = props;
  const runnerHost = useRunnerHost();
  // A native file dialog can only name paths on this machine, so it is offered only when this machine is the one
  // being configured.
  const pickProgramFile =
    scope.host?.isLocalMachine === true
      ? (runnerHost.traycerCli?.pickShellProgramFile ?? null)
      : null;
  const controller = useRpcShellConfigController({
    enabled: supported !== false,
    pickProgramFile,
  });

  // Only a remote host reaches this: a local one with the same answer took the bridge fallback above, where
  // there is a local store that describes it.
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

/** This computer's host, unable to answer for itself: the CLI bridge reads the same on-disk store the host will
 * load. */
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

/** The editor itself, identical for both transports - see `ShellConfigController` for why that identity is the
 * point. */
function ShellSettingsPanelBody(props: {
  readonly controller: ShellConfigController;
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
  // Picking "System default" clears only the selection, returning to the login shell; remembered shells and
  // their flags are kept (the login shell's own flags are inherited).
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
  // Restore the selected shell's flags to its family default, keeping the shell remembered. Works in the
  // synthesised state too (reverting the login shell).
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
    // Chained here, the delete sat on the far side of an unmount boundary TanStack does not cross.
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
        onRefreshShells={controller.refreshShells}
        shellsRefreshing={controller.shellsRefreshing}
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

/** A failed read is not a slow one, and these queries do not retry: without the error arm a remote host that
 * drops mid-read leaves the card skeletoning forever, with no error text and no way back. */
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
  readonly onRefreshShells: () => void;
  readonly shellsRefreshing: boolean;
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
  const wslCaption = resolveWslCaption(config, props.shells);
  const showWslCaption = wslCaption !== null;
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
                    onRefresh={props.onRefreshShells}
                    refreshing={props.shellsRefreshing}
                  />
                  <TransientSaveIndicator
                    pending={
                      props.pending ? props.saveTarget === "program" : false
                    }
                    saved={props.savedTarget === "program"}
                    testId="settings-shell-program-saving-spinner"
                  />
                </div>
                <WslCaptionSlot caption={wslCaption} />
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

/** The full explanation and the primary remedy (the Linux Traycer app running through WSLg) live in the hover
 * card - reachable because `HoverCard`'s close grace lets the pointer travel into the card's link. */
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
          <WslInstallDocsLink
            ariaLabel="Install Traycer in WSL"
            className="rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Info className="size-3" />
          </WslInstallDocsLink>
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
        <WslInstallDocsLink
          ariaLabel={undefined}
          className="inline-block font-medium text-foreground underline underline-offset-4 hover:opacity-80"
        >
          Install Traycer in WSL
        </WslInstallDocsLink>
      </HoverCardContent>
    </HoverCard>
  );
}

type WslHealthValue = NonNullable<ConfigDetectedShell["wslHealth"]>;

type WslCaption =
  | { readonly kind: "unavailable"; readonly health: WslHealthValue }
  | { readonly kind: "scoping" }
  | null;

/** The configured shell can already BE a broken wsl (picked before it broke, or set via the CLI), which
 * outranks the quiet scoping note. */
function resolveWslCaption(
  config: ShellConfigSnapshot | undefined,
  shells: readonly ConfigDetectedShell[],
): WslCaption {
  if (config === undefined) return null;
  const health = shells.find(
    // win32 paths, so case-insensitive; only such rows carry `wslHealth`.
    (shell) => shell.path.toLowerCase() === config.path.toLowerCase(),
  )?.wslHealth;
  if (health !== undefined) return { kind: "unavailable", health };
  if (isWindows() && windowsShellCaptionFamily(config.path) === "wsl") {
    return { kind: "scoping" };
  }
  return null;
}

function WslCaptionSlot(props: { readonly caption: WslCaption }) {
  const { caption } = props;
  if (caption === null) return null;
  if (caption.kind === "unavailable") {
    return <WslUnavailableCaption health={caption.health} />;
  }
  return <WslAgentCaption />;
}

/** The caption when the configured shell is a wsl that cannot host a terminal: a new tab would spawn wsl.exe,
 * which prints usage text (the installer stub) or "no distributions" and exits immediately. */
function WslUnavailableCaption(props: { readonly health: WslHealthValue }) {
  const notInstalled = props.health === "not-installed";
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <span
          data-testid="settings-shell-wsl-unavailable"
          className="inline-flex cursor-default items-center gap-1.5 text-ui-xs text-muted-foreground"
        >
          <span
            aria-hidden
            className="size-1.5 rounded-full bg-[var(--term-ansi-red)]"
          />
          {notInstalled
            ? "WSL isn't installed — terminals won't start"
            : "WSL has no Linux distribution — terminals won't start"}
          <WslInstallDocsLink
            ariaLabel="Install Traycer in WSL"
            className="rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Info className="size-3" />
          </WslInstallDocsLink>
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        align="end"
        className="w-[min(90vw,20rem)] space-y-2 text-ui-xs"
      >
        <p className="text-muted-foreground">
          {notInstalled
            ? "wsl.exe on this machine is only the Windows installer stub, so a terminal tab opens, prints its usage text, and exits. Run the command below from an elevated terminal, restart Windows, then re-detect shells."
            : "WSL runs, but no Linux distribution is registered, so a terminal tab exits immediately. Run the command below, then re-detect shells."}
        </p>
        <code className="block rounded bg-foreground/5 px-2 py-1 font-mono">
          {notInstalled ? "wsl --install" : "wsl --install -d Ubuntu"}
        </code>
        <WslInstallDocsLink
          ariaLabel={undefined}
          className="inline-block font-medium text-foreground underline underline-offset-4 hover:opacity-80"
        >
          Install Traycer in WSL
        </WslInstallDocsLink>
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
