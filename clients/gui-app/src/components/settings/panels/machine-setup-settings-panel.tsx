import { useState, type ReactNode } from "react";
import type {
  EnvironmentOs,
  SetupAttempt,
  SetupScript,
} from "@traycer/protocol/host/environment-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { MACHINE_SETUP } from "@/components/settings/panels/machine-setup.definitions";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { useExecutableWriteGrant } from "@/hooks/environment/use-executable-write-grant";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { noticeWriteOutcome } from "@/lib/environment/write-outcome";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";

/** The operating systems a script can be written for, in tab order. */
const SCRIPT_OSES: ReadonlyArray<{
  readonly os: Exclude<EnvironmentOs, "any">;
  readonly label: string;
}> = [
  { os: "macos", label: "macOS" },
  { os: "linux", label: "Linux" },
  { os: "windows", label: "Windows" },
];

/**
 * Settings > Personal > Machine setup: one script per operating system that
 * each computer runs to set itself up, and what its runs did. The scripts are
 * read and written through the window's own host (forwarded to the person's
 * settings); the runs are this host's own, with Retry.
 */
export function MachineSetupSettingsPanel(): ReactNode {
  const hostId = useAddressableHostId();
  const scriptsSupported = useHostMethodSupport(
    hostId,
    "environment.setup.get",
  );
  const attemptsSupported = useHostMethodSupport(
    hostId,
    "environment.setup.attempts",
  );
  return (
    <SettingsPanelShell
      title={MACHINE_SETUP.page.label}
      description={MACHINE_SETUP.page.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div className="flex flex-col gap-6">
        {scriptsSupported === true ? <SetupScripts /> : null}
        {attemptsSupported === true ? <SetupAttempts /> : null}
        {scriptsSupported === false && attemptsSupported === false ? (
          <p className="text-ui-sm text-muted-foreground">
            Update this host to use machine setup.
          </p>
        ) : null}
      </div>
    </SettingsPanelShell>
  );
}

function SetupScripts(): ReactNode {
  const hostId = useAddressableHostId();
  const query = useHostQuery<HostRpcRegistry, "environment.setup.get">({
    cacheKeyIdentity: undefined,
    client: useHostClient(),
    method: "environment.setup.get",
    params: {},
    options: { enabled: true },
  });
  if (query.isPending) {
    return (
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
        tone="muted"
      />
    );
  }
  if (query.isError) {
    return (
      <p className="text-ui-sm text-muted-foreground">
        Couldn't read your setup scripts from this host.
      </p>
    );
  }
  const scripts = query.data.scripts;
  return (
    <Tabs defaultValue="macos" data-testid="setup-scripts">
      <TabsList>
        {SCRIPT_OSES.map((entry) => (
          <TabsTrigger key={entry.os} value={entry.os}>
            {entry.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {SCRIPT_OSES.map((entry) => {
        const script = scripts.find((candidate) => candidate.os === entry.os);
        return (
          <TabsContent key={entry.os} value={entry.os}>
            {/* Keyed by host and revision: a re-read after any save remounts
                the editor on the script it now has, and another host's script
                never shows this one's draft. */}
            <SetupScriptEditor
              key={`${hostId}:${entry.os}:${script?.revision ?? "none"}`}
              os={entry.os}
              label={entry.label}
              script={script ?? null}
            />
          </TabsContent>
        );
      })}
    </Tabs>
  );
}

function SetupScriptEditor(props: {
  readonly os: Exclude<EnvironmentOs, "any">;
  readonly label: string;
  readonly script: SetupScript | null;
}): ReactNode {
  const saved = props.script?.text ?? "";
  const [text, setText] = useState(saved);
  // The script runs on every computer of that OS, so a save carries the grant.
  const grant = useExecutableWriteGrant();
  const put = useHostScopedMutationForClient(useHostClient(), {
    method: "environment.setup.put",
    prepareRequest: grant,
    mutationKey: environmentMutationKeys.setupPut(),
    errorMessage: "Couldn't save the setup script.",
    invalidateMethods: [
      "environment.setup.get",
      "environment.setup.attempts",
      "environment.status",
      "environment.review",
    ],
    onSuccess: noticeWriteOutcome,
  });
  return (
    <div className="flex flex-col gap-2 pt-2">
      <Textarea
        aria-label={`${props.label} setup script`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={10}
      />
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={text === saved || put.isPending}
          onClick={() =>
            put.mutate({
              os: props.os,
              text,
              expectedRevision: props.script?.revision ?? null,
              executableWriteGrant: null,
            })
          }
        >
          Save
          {put.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : null}
        </Button>
      </div>
    </div>
  );
}

const TRIGGER_TEXT: Readonly<Record<SetupAttempt["trigger"], string>> = {
  change: "After a change",
  retry: "Retried",
  resume: "On resume",
  restart: "After a restart",
};

const RESULT_TEXT: Readonly<
  Record<NonNullable<SetupAttempt["result"]>, string>
> = {
  succeeded: "Succeeded",
  failed: "Failed",
  timed_out: "Timed out",
  cancelled: "Cancelled",
  unknown: "Ended without a result",
};

function attemptOutcome(attempt: SetupAttempt): string {
  if (attempt.result === null) return "Running";
  const result = RESULT_TEXT[attempt.result];
  if (attempt.result === "failed" && attempt.exitStatus !== null) {
    return `${result} (exit ${attempt.exitStatus})`;
  }
  return result;
}

function SetupAttempts(): ReactNode {
  const client = useHostClient();
  const query = useHostQuery<HostRpcRegistry, "environment.setup.attempts">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.setup.attempts",
    params: {},
    // Re-read while open, at the cadence the method's policy declares.
    options: { enabled: true, poll: true },
  });
  const retry = useHostScopedMutationForClient(client, {
    method: "environment.setup.retry",
    mutationKey: environmentMutationKeys.setupRetry(),
    errorMessage: "Couldn't run the setup script again.",
    invalidateMethods: ["environment.setup.attempts", "environment.status"],
  });
  const attempts = [...(query.data?.attempts ?? [])].sort(
    (a, b) => b.startedAt - a.startedAt,
  );
  const running = attempts.some((attempt) => attempt.result === null);
  return (
    <section className="flex flex-col gap-2" data-testid="setup-attempts">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-ui-sm font-medium text-foreground">
          Runs on this host
        </h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={running || retry.isPending || attempts.length === 0}
          onClick={() => retry.mutate({})}
        >
          Retry
          {retry.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : null}
        </Button>
      </div>
      {attempts.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">
          {query.isError
            ? "Couldn't read this host's setup runs."
            : "No runs on this host yet."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {attempts.map((attempt) => (
            <li
              key={attempt.attemptId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 px-3 py-2 text-ui-xs"
              data-testid="setup-attempt"
            >
              <span className="font-medium text-foreground">
                {attemptOutcome(attempt)}
              </span>
              <span className="text-muted-foreground">
                {TRIGGER_TEXT[attempt.trigger]}
              </span>
              <span className="text-muted-foreground">
                {new Date(attempt.startedAt).toLocaleString()}
              </span>
              {attempt.stageReached !== null &&
              attempt.result !== "succeeded" ? (
                <span className="text-muted-foreground">
                  Reached {attempt.stageReached}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
