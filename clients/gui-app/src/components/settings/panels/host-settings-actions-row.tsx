import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import type { ServiceStatusSnapshot } from "@traycer-clients/shared/platform/runner-host";

interface ActionsRowProps {
  readonly status: ServiceStatusSnapshot | undefined;
  readonly pending: boolean;
  readonly anyPending: boolean;
  readonly installPending: boolean;
  readonly restartPending: boolean;
  readonly onInstall: () => void;
  readonly onRestart: () => void;
  readonly onOpenDoctor: () => void;
}

export function ActionsRow(props: ActionsRowProps) {
  const {
    status,
    pending,
    anyPending,
    installPending,
    restartPending,
    onInstall,
    onRestart,
    onOpenDoctor,
  } = props;
  const state = status?.state;
  const isNotInstalled = state === "not-installed";
  const description = isNotInstalled
    ? "Install the host to enable local features."
    : "Restart the host or open diagnostics.";
  return (
    <SettingsRow
      label="Actions"
      description={description}
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {isNotInstalled ? (
            <Button
              variant="default"
              size="sm"
              disabled={anyPending || pending}
              onClick={onInstall}
            >
              {installPending ? (
                <AgentSpinningDots
                  className="mr-2 size-3"
                  testId={undefined}
                  variant={undefined}
                />
              ) : null}
              Install host
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={anyPending || pending}
              onClick={onRestart}
            >
              {restartPending ? (
                <AgentSpinningDots
                  className="mr-2 size-3"
                  testId={undefined}
                  variant={undefined}
                />
              ) : null}
              Restart
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={onOpenDoctor}>
            Run doctor
          </Button>
        </div>
      }
    />
  );
}
