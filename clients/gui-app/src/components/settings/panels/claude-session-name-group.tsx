/**
 * Docs: see ../SETTINGS.md (Providers ▸ General ▸ Session name).
 * Update that file whenever this settings surface changes.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  SESSION_NAME_TEMPLATE_MAX_LENGTH,
  renderSessionName,
  sessionNameClockValues,
  unknownSessionNamePlaceholders,
} from "@traycer/protocol/config/session-name-template";
import type { ConfigSessionNamesResponse } from "@traycer/protocol/host/config/schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { PROVIDERS } from "@/components/settings/panels/providers-settings.definitions";
import { resolveAutoCleanupGate } from "@/components/settings/panels/worktree-auto-cleanup-gate";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { trackSettingChanged } from "@/lib/analytics";
import { configMutationKeys, sessionNamesWriteScope } from "@/lib/query-keys";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";

const SESSION_NAMES_GET = "config.sessionNames.get";
const SESSION_NAMES_SET = "config.sessionNames.set";

const READ_ERROR_STATUS =
  "Couldn't read this host's setting. Repair Traycer's config.json on that machine, or back it up before resetting it, then reopen Settings.";

/** What the preview renders the template against. */
const PREVIEW_VALUES = {
  project: "my-app",
  repository: "my-app",
  branch: "main",
  task: "Fix login timeout",
  agent: "Claude",
  agent_id: "1a2b3c4d",
} as const;

/**
 * Settings ▸ Providers ▸ Claude Code ▸ General ▸ Session name: the template
 * the scoped host renders into the name of a Claude Code session it starts on
 * the Terminal interface. Stored in the `sessionNames` block of
 * `~/.traycer/cli/config.json` on that host and read at the launch that
 * creates the session, so a change names sessions started after it.
 *
 * The placeholders offered and accepted are the ones the host reports, so a
 * newer app never saves a template an older host would render literally.
 * Gated like the Model list group (reachable host, both methods negotiated):
 * a host without the setting draws nothing.
 */
export function ClaudeSessionNameGroup(props: {
  readonly providerId: ProviderId;
  readonly hostId: string | null;
}): ReactNode {
  // The name is Claude Code's alone: no other provider's terminal launch takes
  // one.
  if (props.providerId !== "claude-code") return null;
  return <ClaudeSessionNameGate hostId={props.hostId} />;
}

function ClaudeSessionNameGate(props: {
  readonly hostId: string | null;
}): ReactNode {
  const { hostId } = props;
  const client = useHostClient();
  const reachability = useHostReachability(hostId ?? "");
  // Two statements, not one `&&` - a short-circuited hook call is a
  // rules-of-hooks violation.
  const getSupported = useHostMethodSupport(hostId, SESSION_NAMES_GET);
  const setSupported = useHostMethodSupport(hostId, SESSION_NAMES_SET);
  const gate = resolveAutoCleanupGate({
    hostId,
    // Mounted under the providers panel's host-scope gate.
    scopeUsable: true,
    reachabilityStatus: reachability.status,
    hasClient: true,
    supported:
      getSupported === null || setSupported === null
        ? null
        : getSupported && setSupported,
  });
  if (gate !== "ready" || hostId === null) return null;
  // Keyed by host: a switch straight from one usable host to another must not
  // carry the outgoing host's draft across.
  return <ClaudeSessionNameRows key={hostId} client={client} hostId={hostId} />;
}

function ClaudeSessionNameRows(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
}): ReactNode {
  const { client, hostId } = props;
  const query = useHostQuery<HostRpcRegistry, "config.sessionNames.get">({
    cacheKeyIdentity: undefined,
    client,
    method: SESSION_NAMES_GET,
    params: {},
    options: { enabled: true },
  });
  const setTemplate = useHostScopedMutationForClient(client, {
    method: SESSION_NAMES_SET,
    mutationKey: configMutationKeys.sessionNamesSet(),
    errorMessage: "Couldn't update the session name",
    invalidateMethods: [SESSION_NAMES_GET],
    // One queue, so the host ends on the user's last save.
    scope: sessionNamesWriteScope(hostId),
  });
  const state = query.data ?? null;

  return (
    <SettingsGroup
      group={PROVIDERS.definitions.sessionName}
      showTitle
      tone="default"
      dataTestId="claude-session-name-group"
      fill={false}
    >
      {state === null ? (
        <SettingsRow
          row={PROVIDERS.definitions.sessionNameTemplate}
          status={
            query.isError ? <p role="alert">{READ_ERROR_STATUS}</p> : undefined
          }
          control={query.isError ? null : <MutedAgentSpinner />}
          controlSpansLine={false}
          details={undefined}
        />
      ) : (
        <ClaudeSessionNameField
          state={state}
          saving={setTemplate.isPending}
          onSave={(claudeTemplate) => {
            trackSettingChanged("providers", "claudeSessionName");
            setTemplate.mutate({ claudeTemplate });
          }}
        />
      )}
    </SettingsGroup>
  );
}

function ClaudeSessionNameField(props: {
  readonly state: ConfigSessionNamesResponse;
  readonly saving: boolean;
  readonly onSave: (claudeTemplate: string) => void;
}): ReactNode {
  const { state, saving, onSave } = props;
  const saved = state.claudeTemplate;
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(saved);
  // What this field last asked the host to hold. A write still in flight has
  // not reached `saved` yet, so an edit back to the stored value must be
  // compared against the write, not the read.
  const lastSent = useRef(saved);
  // The host's value can change from outside this field (another window, a
  // hand edit); follow it unless the user is mid-edit.
  useEffect(() => {
    lastSent.current = saved;
    if (document.activeElement !== inputRef.current) setDraft(saved);
  }, [saved]);

  const problem = templateProblem(draft.trim(), state.placeholders);
  const preview = renderSessionName(draft, {
    ...PREVIEW_VALUES,
    ...sessionNameClockValues(new Date()),
  });

  const commit = (next: string): void => {
    const trimmed = next.trim();
    if (trimmed !== next) setDraft(trimmed);
    if (templateProblem(trimmed, state.placeholders) !== null) return;
    if (trimmed === lastSent.current) return;
    lastSent.current = trimmed;
    onSave(trimmed);
  };

  return (
    <SettingsRow
      row={PROVIDERS.definitions.sessionNameTemplate}
      status={
        <div className="flex flex-col gap-1">
          <p>{PROVIDERS.definitions.sessionNameTemplate.description}</p>
          <p>
            Placeholders:{" "}
            <span className="font-mono">
              {state.placeholders.map((name) => `{${name}}`).join(" ")}
            </span>
            . {"{task}"} and {"{agent}"}: as titled when the session starts.
          </p>
          {problem !== null ? (
            <p role="alert" className="text-destructive">
              {problem}
            </p>
          ) : (
            <p data-testid="claude-session-name-preview">
              Preview: <span className="text-foreground">{preview}</span>
            </p>
          )}
        </div>
      }
      control={
        <div className="flex w-full items-center gap-2">
          <Input
            ref={inputRef}
            id={inputId}
            aria-label="Session name template"
            data-testid="claude-session-name-input"
            className="w-full"
            placeholder={state.defaultClaudeTemplate}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => commit(draft)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            font="mono"
            size="sm"
          />
          {saving ? <MutedAgentSpinner /> : null}
          {draft !== state.defaultClaudeTemplate ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="claude-session-name-reset"
              disabled={saving}
              // Keeps focus in the field, so the draft Reset discards is not
              // saved by the field's blur on the way to the click.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setDraft(state.defaultClaudeTemplate);
                commit(state.defaultClaudeTemplate);
              }}
            >
              Reset
            </Button>
          ) : null}
        </div>
      }
      controlSpansLine
      details={undefined}
    />
  );
}

/** Why the host would refuse a template, or `null` when it would take it. */
function templateProblem(
  template: string,
  placeholders: readonly string[],
): string | null {
  if (template.length > SESSION_NAME_TEMPLATE_MAX_LENGTH) {
    return `Up to ${SESSION_NAME_TEMPLATE_MAX_LENGTH} characters.`;
  }
  const unknown = unknownSessionNamePlaceholders(template, placeholders);
  if (unknown.length > 0) {
    return `Unknown placeholder: ${unknown.map((name) => `{${name}}`).join(", ")}`;
  }
  return null;
}
