import { Check, RotateCcw } from "lucide-react";
import {
  defaultShellArgs,
  isLoginShellFamily,
} from "@traycer/protocol/config/shell-family";
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
import { useRunnerHost } from "@/providers/use-runner-host";

const PANEL_DESCRIPTION =
  "How Traycer launches terminals, the host, and provider harnesses. New terminals pick up shell changes immediately; host env changes apply on restart.";

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

  const onSavePath = (path: string): void => {
    if (shellPending) return;
    setMutation.mutate({ path, args: null });
  };
  const onAddShell = (path: string): void => {
    if (shellPending) return;
    addMutation.mutate({ path });
  };
  const onRemoveShell = (path: string): void => {
    if (shellPending) return;
    removeMutation.mutate({ path });
  };
  // Picking "System default" clears only the selection, returning to the login
  // shell; remembered shells and their flags are kept (the login shell's own
  // flags are inherited).
  const onUseSystemDefault = (): void => {
    if (shellPending) return;
    resetMutation.mutate();
  };
  const onAddFlag = (flag: string): void => {
    if (config === undefined || shellPending) return;
    setMutation.mutate({ path: null, args: [...config.args, flag] });
  };
  const onRemoveFlag = (index: number): void => {
    if (config === undefined || shellPending) return;
    setMutation.mutate({
      path: null,
      args: config.args.filter((_, i) => i !== index),
    });
  };
  // Restore the SELECTED shell's flags to its family default, keeping the shell
  // remembered. Works in the synthesised state too (reverting the login shell).
  const onRevertFlags = (): void => {
    if (config === undefined || shellPending) return;
    revertMutation.mutate({ path: config.path });
  };
  const onEnvCommit = (
    oldKey: string,
    newKey: string,
    value: string | null,
  ): void => {
    if (envPending) return;
    if (oldKey === newKey) {
      envSetMutation.mutate({ key: newKey, value });
      return;
    }
    // Rename: create the new key first, then drop the old one so a failed
    // delete leaves a harmless duplicate rather than a lost value.
    envSetMutation.mutate(
      { key: newKey, value },
      {
        onSuccess: () => {
          if (oldKey.length > 0) {
            envDeleteMutation.mutate({ key: oldKey });
          }
        },
      },
    );
  };
  const onEnvDelete = (key: string): void => {
    if (envPending) return;
    envDeleteMutation.mutate({ key });
  };

  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-10">
      <header className="mb-8 space-y-2">
        <h1 className="text-title-lg font-semibold text-foreground">Shell</h1>
        <p className="max-w-2xl text-ui-sm text-muted-foreground">
          {PANEL_DESCRIPTION}
        </p>
      </header>

      <div className="overflow-hidden rounded-xl border border-border/60 bg-card/40">
        <div className="border-b border-border/40 px-5 py-4">
          <div className="font-medium text-foreground">Shell</div>
          <p className="mt-1 text-ui-sm text-muted-foreground">
            The program and flags every terminal tab starts with.
          </p>
        </div>
        <div className="space-y-5 px-5 py-5">
          {config === undefined ? (
            <ShellCardSkeleton />
          ) : (
            <>
              <EffectiveCommandPreview path={config.path} args={config.args} />
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="text-ui-sm font-medium text-foreground">
                    Shell program
                  </div>
                  <p className="text-ui-xs text-muted-foreground">
                    Pick a shell, or add any program on this machine.
                  </p>
                </div>
                <ShellProgramCombobox
                  value={config.path}
                  synthesised={config.synthesised}
                  shells={shells}
                  disabled={shellPending}
                  onSelect={onSavePath}
                  onAdd={onAddShell}
                  onRemove={onRemoveShell}
                  onUseSystemDefault={onUseSystemDefault}
                />
              </div>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-xs space-y-1">
                  <div className="text-ui-sm font-medium text-foreground">
                    {`Startup flags for ${programName(config.path)}`}
                  </div>
                  <p className="text-ui-xs text-muted-foreground">
                    {isLoginShellFamily(config.path)
                      ? "“-i -l” loads your full shell profile (PATH, aliases)."
                      : `Passed to ${programName(config.path)} each time a terminal opens.`}
                  </p>
                </div>
                <ShellFlagChips
                  args={config.args}
                  disabled={shellPending}
                  onAdd={onAddFlag}
                  onRemove={onRemoveFlag}
                />
              </div>
            </>
          )}
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-border/40 px-5 py-3">
          <button
            type="button"
            disabled={
              shellPending ||
              config === undefined ||
              !flagsDeviateFromDefault(config.path, config.args)
            }
            onClick={onRevertFlags}
            className="inline-flex items-center gap-1 text-ui-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <RotateCcw className="size-3" />
            Restore default flags
          </button>
          <SaveStatus pending={shellPending} />
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-border/60 bg-card/40">
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-4">
          <div>
            <div className="font-medium text-foreground">
              Environment variables
            </div>
            <p className="mt-1 text-ui-sm text-muted-foreground">
              Set or unset variables for the host process; applied on its next
              restart. Per-harness variables live in Settings → Providers.
            </p>
          </div>
          <SaveStatus pending={envPending} />
        </div>
        <div className="px-5 py-5">
          <EnvOverrideEditor
            overrides={overrides}
            disabled={envPending}
            namePlaceholder="OPENAI_API_KEY"
            emptyLabel="No host environment variables. The host starts with the environment your shell produces."
            onCommit={onEnvCommit}
            onDelete={onEnvDelete}
          />
        </div>
      </div>
    </section>
  );
}

function SaveStatus(props: { readonly pending: boolean }) {
  if (props.pending) {
    return (
      <span className="inline-flex items-center gap-1.5 text-ui-xs text-muted-foreground">
        <AgentSpinningDots
          className="text-muted-foreground"
          testId="settings-shell-saving-spinner"
          variant={undefined}
        />
        Saving…
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-ui-xs text-muted-foreground">
      <Check className="size-3.5 text-[var(--term-ansi-green)]" />
      Saved
    </span>
  );
}

function ShellCardSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-20 animate-pulse rounded-md bg-muted/40" />
      <div className="h-9 animate-pulse rounded-md bg-muted/30" />
    </div>
  );
}
