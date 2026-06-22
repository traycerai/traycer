import { Check } from "lucide-react";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { EffectiveCommandPreview } from "@/components/settings/panels/shell/effective-command-preview";
import { EnvOverrideEditor } from "@/components/settings/panels/env-override-editor";
import { ShellFlagChips } from "@/components/settings/panels/shell/shell-flag-chips";
import { ShellProgramCombobox } from "@/components/settings/panels/shell/shell-program-combobox";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useRunnerTraycerEnvOverrideDeleteMutation } from "@/hooks/runner/use-runner-traycer-env-override-delete-mutation";
import { useRunnerTraycerEnvOverrideListQuery } from "@/hooks/runner/use-runner-traycer-env-override-list-query";
import { useRunnerTraycerEnvOverrideSetMutation } from "@/hooks/runner/use-runner-traycer-env-override-set-mutation";
import { useRunnerTraycerShellConfigQuery } from "@/hooks/runner/use-runner-traycer-shell-config-query";
import { useRunnerTraycerShellConfigResetMutation } from "@/hooks/runner/use-runner-traycer-shell-config-reset-mutation";
import { useRunnerTraycerShellConfigSetMutation } from "@/hooks/runner/use-runner-traycer-shell-config-set-mutation";
import { useRunnerTraycerShellListQuery } from "@/hooks/runner/use-runner-traycer-shell-list-query";
import { useRunnerHost } from "@/providers/use-runner-host";

const PANEL_DESCRIPTION =
  "How Traycer launches terminals, the host, and provider harnesses. New terminals pick up shell changes immediately; host env changes apply on restart.";

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
  const envSetMutation = useRunnerTraycerEnvOverrideSetMutation();
  const envDeleteMutation = useRunnerTraycerEnvOverrideDeleteMutation();

  const config = configQuery.data;
  const detected = shellListQuery.data ?? [];
  const overrides = envListQuery.data ?? [];

  const shellPending = setMutation.isPending || resetMutation.isPending;
  const envPending = envSetMutation.isPending || envDeleteMutation.isPending;

  const onSavePath = (path: string): void => {
    if (shellPending) return;
    setMutation.mutate({ path, args: null });
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
    <section className="mx-auto w-full max-w-5xl px-8 py-10">
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
              <EffectiveCommandPreview
                path={config.path}
                args={config.args}
                synthesised={config.synthesised}
              />
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="text-ui-sm font-medium text-foreground">
                    Shell program
                  </div>
                  <p className="text-ui-xs text-muted-foreground">
                    Detected on your machine — or type a custom path.
                  </p>
                </div>
                <ShellProgramCombobox
                  value={config.path}
                  detected={detected}
                  disabled={shellPending}
                  onSave={onSavePath}
                />
              </div>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-xs space-y-1">
                  <div className="text-ui-sm font-medium text-foreground">
                    Startup flags
                  </div>
                  <p className="text-ui-xs text-muted-foreground">
                    “-i -l” loads your full shell profile (PATH, aliases).
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
        <div className="flex items-center justify-between border-t border-border/40 px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={
              shellPending || config === undefined || config.synthesised
            }
            onClick={() => resetMutation.mutate()}
            data-testid="settings-shell-reset"
          >
            {resetMutation.isPending ? (
              <AgentSpinningDots
                className="text-muted-foreground"
                testId="settings-shell-reset-spinner"
                variant={undefined}
              />
            ) : null}
            Reset to defaults
          </Button>
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
