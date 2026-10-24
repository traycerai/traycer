import type { ReactNode } from "react";
import { Check, Circle } from "lucide-react";
import {
  SET_UP_PERSONAL_LEAD,
  SET_UP_PERSONAL_STEPS,
  SET_UP_PERSONAL_TITLE,
  setUpPersonalDone,
  setUpPersonalProgress,
} from "@/components/onboarding/set-up-personal";
import { Button } from "@/components/ui/button";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useOptionalHostClient, type HostRpcRegistry } from "@/lib/host";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";

/**
 * The checklist's "Set up Personal" group, under the guide cards on Settings
 * ▸ Getting started and on Home: three optional steps, each opening its page
 * and checked off by what the person's settings already hold, read through
 * the window's own host, so a step done in the dashboard is checked here too.
 */
export function SetUpPersonalGroup(props: {
  readonly surface: "settings" | "home";
}): ReactNode {
  const client = useOptionalHostClient();
  // The host the client reaches: the window's own.
  const hostId = useRequesterHostId(client);
  const providers = useProvidersListForClient(client, {
    enabled: client !== null,
    subscribed: true,
  });
  const secretsSupported = useHostMethodSupport(
    hostId,
    "environment.secrets.list",
  );
  const secrets = useHostQuery<HostRpcRegistry, "environment.secrets.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.secrets.list",
    params: { environmentId: null },
    options: { enabled: secretsSupported === true },
  });
  const status = useEnvironmentStatusRead(client, hostId, true);
  const done = setUpPersonalDone({
    providers: providers.data?.providers ?? null,
    secrets: secrets.data?.secrets ?? null,
    status: status.data,
  });
  return (
    <section
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border/60",
        props.surface === "settings" ? "mt-4 p-5" : "mt-3 p-4",
      )}
      aria-labelledby={`set-up-personal-${props.surface}`}
      data-testid="set-up-personal"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3
          id={`set-up-personal-${props.surface}`}
          className="font-medium text-foreground"
        >
          {SET_UP_PERSONAL_TITLE}
        </h3>
        <span
          className="text-ui-xs tabular-nums text-muted-foreground"
          data-testid="set-up-personal-progress"
        >
          {setUpPersonalProgress(done)}
        </span>
      </div>
      <p className="text-ui-sm text-muted-foreground">{SET_UP_PERSONAL_LEAD}</p>
      <ul className="flex flex-col gap-1.5">
        {SET_UP_PERSONAL_STEPS.map((step) => {
          const stepDone = done.has(step.id);
          return (
            <li
              key={step.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
              data-testid="set-up-personal-step"
              data-step={step.id}
              data-done={stepDone}
            >
              <span className="flex min-w-0 items-center gap-2 text-ui-sm text-foreground">
                {stepDone ? (
                  <Check
                    className="size-3.5 shrink-0 text-success"
                    aria-label="Done"
                  />
                ) : (
                  <Circle
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                )}
                <span className="min-w-0">{step.text}</span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  navigateToSettingsSection(step.section);
                }}
              >
                {step.action}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
