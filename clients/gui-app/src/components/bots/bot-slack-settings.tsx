import { useId, useState, type MouseEvent, type ReactNode } from "react";
import {
  slackAppRegisterRequestSchema,
  type SlackAppView,
} from "@traycer/protocol/host/slack-app";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BotSettingsRefusal,
  SettingsGroup,
} from "@/components/bots/bot-settings-group";
import {
  isSlackAccessRefused,
  slackUnavailableLine,
} from "@/hooks/bots/bot-slack-app-error";
import {
  useBotSlackAppQuery,
  useBotSlackManifestQuery,
} from "@/hooks/bots/use-bot-slack-app-query";
import {
  useBotSlackDisconnectMutation,
  useBotSlackInstallUrlMutation,
  useBotSlackRegisterMutation,
} from "@/hooks/bots/use-bot-slack-mutations";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useOpenLink } from "@/lib/links/open-link";
import { formatSettingsDate } from "@/lib/settings/settings-date";
import { useBotSlackPendingInstallStore } from "@/stores/bots/bot-slack-pending-install-store";

const SLACK_APPS_URL = "https://api.slack.com/apps";
const COPIED_RESET_MS = 2_000;

/**
 * The bot's own Slack app (Slack for Tracy, S4), in three states:
 * - no app: create one in Slack from the manifest, then register its
 *   credentials;
 * - registered (or uninstalled, which keeps the credentials): install it to a
 *   workspace, or register other credentials;
 * - installed: the workspace and app, install again, disconnect.
 *
 * Rendered from the server's app read alone; every write refreshes that read.
 * Each refusal is shown in place, under the control that made it.
 */
export function BotSlackSettings(props: { readonly botId: string }): ReactNode {
  const { botId } = props;
  const appQuery = useBotSlackAppQuery(botId);
  const app = appQuery.data;
  const error = appQuery.error;
  const accessRefused = isSlackAccessRefused(error);
  const unavailable = slackUnavailableLine(error);
  let body: ReactNode;
  if (unavailable !== null) {
    body = <BotSlackUnavailable line={unavailable} />;
  } else if (app === undefined || accessRefused) {
    body = (
      <BotSlackAppUnread
        error={appQuery.error}
        loading={appQuery.fetchStatus === "fetching"}
      />
    );
  } else if (app === null) {
    body = <BotSlackNotConnected botId={botId} />;
  } else if (app.installState === "installed") {
    body = <BotSlackConnected app={app} />;
  } else {
    body = <BotSlackRegistered app={app} />;
  }
  // A read that failed after one succeeded keeps the app the last one read,
  // and says so under it.
  const staleError =
    app !== undefined && !accessRefused && unavailable === null ? error : null;
  return (
    <SettingsGroup title="Slack" testId="bot-settings-slack">
      {body}
      <BotSettingsRefusal
        message={staleError === null ? null : staleError.message}
      />
    </SettingsGroup>
  );
}

function BotSlackAppUnread(props: {
  readonly error: Error | null;
  readonly loading: boolean;
}): ReactNode {
  if (props.error !== null) {
    return <BotSettingsRefusal message={props.error.message} />;
  }
  if (props.loading) {
    return (
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
      />
    );
  }
  // Not read and not reading: there is no session to read it with.
  return (
    <BotSettingsRefusal message="Sign in to change this bot's Slack app." />
  );
}

/** No bot can be connected to Slack from here: one line, nothing to retry. */
function BotSlackUnavailable(props: { readonly line: string }): ReactNode {
  return (
    <p
      className="text-ui-xs text-muted-foreground"
      data-testid="bot-settings-slack-unavailable"
    >
      {props.line}
    </p>
  );
}

function BotSlackNotConnected(props: { readonly botId: string }): ReactNode {
  const { botId } = props;
  const manifest = useBotSlackManifestQuery(botId);
  const openLink = useOpenLink();
  const { copied, copy } = useClipboardCopy({
    resetMs: COPIED_RESET_MS,
    onSuccess: null,
    onError: null,
  });
  const unavailable = slackUnavailableLine(manifest.error);
  if (unavailable !== null) return <BotSlackUnavailable line={unavailable} />;
  const text = manifest.data ?? null;
  return (
    <div className="flex flex-col gap-4" data-testid="bot-settings-slack-setup">
      <p className="text-ui-xs text-muted-foreground">
        The bot answers in Slack when someone mentions it.
      </p>
      <ol className="flex list-decimal flex-col gap-1 ps-5 text-ui-sm text-foreground">
        <li>Create a Slack app from this manifest.</li>
        <li>Paste the app's credentials from its Basic Information page.</li>
        <li>Install the app to your workspace.</li>
      </ol>
      {text === null ? (
        <BotSettingsRefusal
          message={manifest.error === null ? null : manifest.error.message}
        />
      ) : (
        <pre
          className="max-h-48 overflow-auto rounded-md border border-border/60 bg-foreground/3 p-3 font-mono text-ui-xs text-foreground"
          data-testid="bot-settings-slack-manifest"
        >
          {text}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={text === null}
          onClick={() => {
            if (text !== null) copy(text);
          }}
        >
          {copied ? "Copied" : "Copy manifest"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={(event) => void openLink(SLACK_APPS_URL, "account", event)}
        >
          Open api.slack.com/apps
        </Button>
      </div>
      <BotSlackRegisterForm botId={botId} />
    </div>
  );
}

const CREDENTIAL_FIELDS = [
  { key: "appId", label: "App ID", secret: false },
  { key: "clientId", label: "Client ID", secret: false },
  { key: "clientSecret", label: "Client Secret", secret: true },
  { key: "signingSecret", label: "Signing Secret", secret: true },
] as const;

type CredentialKey = (typeof CREDENTIAL_FIELDS)[number]["key"];

const EMPTY_CREDENTIALS: Readonly<Record<CredentialKey, string>> = {
  appId: "",
  clientId: "",
  clientSecret: "",
  signingSecret: "",
};

/**
 * The app's four credentials. The values live in this form alone: never in
 * a store or the query cache, and the register mutation is reset (and so
 * dropped from the cache) once it settles. A registration replaces the
 * bot's previous one.
 */
function BotSlackRegisterForm(props: { readonly botId: string }): ReactNode {
  const { botId } = props;
  const register = useBotSlackRegisterMutation(botId);
  const [values, setValues] =
    useState<Readonly<Record<CredentialKey, string>>>(EMPTY_CREDENTIALS);
  const [refusal, setRefusal] = useState<string | null>(null);
  const formId = useId();
  const request = slackAppRegisterRequestSchema.safeParse({
    botId,
    appId: values.appId.trim(),
    clientId: values.clientId.trim(),
    clientSecret: values.clientSecret.trim(),
    signingSecret: values.signingSecret.trim(),
  });
  const canRegister = request.success && !register.isPending;
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="bot-settings-slack-register"
      onSubmit={(event) => {
        event.preventDefault();
        if (!request.success || register.isPending) return;
        setRefusal(null);
        register.mutate(request.data, {
          onSuccess: () => setValues(EMPTY_CREDENTIALS),
          onError: (error) => setRefusal(error.message),
          onSettled: () => register.reset(),
        });
      }}
    >
      <div className="flex flex-col gap-3">
        {CREDENTIAL_FIELDS.map((field) => (
          <div key={field.key} className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={`${formId}-${field.key}`}>{field.label}</Label>
            <Input
              id={`${formId}-${field.key}`}
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              value={values[field.key]}
              disabled={register.isPending}
              onChange={(event) => {
                const next = event.target.value;
                setValues((current) => ({ ...current, [field.key]: next }));
              }}
            />
          </div>
        ))}
      </div>
      <div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!canRegister}
        >
          Register
          {register.isPending ? (
            <AgentSpinningDots
              className="ml-1"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      </div>
      <BotSettingsRefusal message={refusal} />
    </form>
  );
}

/** Registered and not installed: never installed, or removed from its workspace since. */
function BotSlackRegistered(props: { readonly app: SlackAppView }): ReactNode {
  const { app } = props;
  return (
    <div
      className="flex flex-col gap-4"
      data-testid="bot-settings-slack-registered"
    >
      <p
        className="text-ui-sm text-foreground"
        data-testid="bot-settings-slack-status"
      >
        {registeredStatusLine(app)}
      </p>
      <p className="text-ui-xs text-muted-foreground">
        In Slack, retry the request URL under Event Subscriptions, then install
        the app.
      </p>
      <BotSlackInstall app={app} label="Install to workspace" />
      <BotSlackRegisterForm botId={app.botId} />
    </div>
  );
}

/** An uninstalled app names the workspace it left, whoever removed it. */
function registeredStatusLine(app: SlackAppView): string {
  if (app.installState !== "uninstalled") return "Registered, not installed.";
  return app.teamName === null
    ? "Not installed in a workspace."
    : `Not installed in ${app.teamName}.`;
}

function BotSlackConnected(props: { readonly app: SlackAppView }): ReactNode {
  const { app } = props;
  const disconnect = useBotSlackDisconnectMutation(app.botId);
  return (
    <div
      className="flex flex-col gap-4"
      data-testid="bot-settings-slack-connected"
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ui-sm">
        <dt className="text-muted-foreground">Workspace</dt>
        <dd className="min-w-0 truncate text-foreground">
          {app.teamName ?? app.teamId}
        </dd>
        <dt className="text-muted-foreground">App</dt>
        <dd className="min-w-0 truncate text-foreground">{app.appId}</dd>
        {app.installedAt === null ? null : (
          <>
            <dt className="text-muted-foreground">Installed</dt>
            <dd className="min-w-0 truncate text-foreground">
              {formatSettingsDate(app.installedAt, true)}
            </dd>
          </>
        )}
      </dl>
      <p className="text-ui-xs text-muted-foreground">
        Mention the app in a channel it is in to ask the bot something.
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <BotSlackInstall app={app} label="Install again" />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disconnect.isPending}
          onClick={() => disconnect.mutate()}
        >
          Disconnect
          {disconnect.isPending ? (
            <AgentSpinningDots
              className="ml-1"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      </div>
      <BotSettingsRefusal
        message={disconnect.error === null ? null : disconnect.error.message}
      />
    </div>
  );
}

/**
 * Mints Slack's consent URL and opens it in the browser. Until the install
 * lands or the URL expires, a line says the bot is waiting for it; pressing
 * again mints a fresh URL.
 */
function BotSlackInstall(props: {
  readonly app: SlackAppView;
  readonly label: string;
}): ReactNode {
  const { app, label } = props;
  const install = useBotSlackInstallUrlMutation(app.botId);
  const openLink = useOpenLink();
  const waiting = useBotSlackPendingInstallStore((s) =>
    Object.hasOwn(s.entries, app.botId),
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={install.isPending}
          onClick={(event: MouseEvent<HTMLButtonElement>) =>
            install.mutate(
              { baselineInstalledAt: app.installedAt },
              {
                onSuccess: (minted) => void openLink(minted.url, "auth", event),
              },
            )
          }
        >
          {label}
          {install.isPending ? (
            <AgentSpinningDots
              className="ml-1"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
        {waiting ? (
          <span
            className="flex items-center gap-2 text-ui-xs text-muted-foreground"
            data-testid="bot-settings-slack-waiting"
          >
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
            Waiting for Slack
          </span>
        ) : null}
      </div>
      <BotSettingsRefusal
        message={install.error === null ? null : install.error.message}
      />
    </div>
  );
}
