import { useId, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useStore } from "zustand";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import { chatMaxModeContextForToolbar } from "@/components/home/data/model-max-mode";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostsAdvertisingMethod } from "@/hooks/host/use-hosts-advertising-method";
import { useBotCreateMutation } from "@/hooks/bots/use-bot-mutations";
import type { HostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import { chooseBotCreateHost } from "@/lib/home-bots/bot-create-host";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { botTabIntent, settingsTabIntent } from "@/lib/tab-navigation/intents";
import { navigateToTabIntent } from "@/lib/tab-navigation";

const BOT_TITLE_MAX = 500;

/**
 * Creates a bot INTO one environment (Tracy Bots). The environment is the
 * card's and is sent explicitly; what the reader chooses here is the title
 * and the model. Never the machine: the app picks the host the bot starts on
 * (`chooseBotCreateHost`, which documents the order), and the form names no
 * host - when none qualifies it says the bot needs a machine that runs bots,
 * and where to set one up.
 *
 * The create goes to the chosen host's own client, and the tab the success
 * opens binds to that host.
 */
export function CreateBotForm(props: {
  readonly environmentId: string;
  readonly environmentLabel: string;
  /** Hosts this client can dial now; the candidates the choice walks. */
  readonly connectableHostIds: ReadonlyArray<string>;
  /** Each connectable host's environment, as `environment.host.read` says. */
  readonly environmentBindings: HostEnvironmentBindings;
  readonly onDone: () => void;
}): ReactNode {
  const {
    environmentId,
    environmentLabel,
    connectableHostIds,
    environmentBindings,
    onDone,
  } = props;
  const [title, setTitle] = useState("");
  const localHostId = useReactiveLocalHostId();
  const effectiveHostId = useEffectiveHostId();
  const creatingHostIds = useHostsAdvertisingMethod(
    connectableHostIds,
    "bot.create",
  );
  const choice = chooseBotCreateHost({
    environmentId,
    localHostId,
    effectiveHostId,
    connectableHostIds,
    bindings: environmentBindings.byHostId,
    failedHostIds: environmentBindings.failedHostIds,
    creatingHostIds,
  });
  const hostId = choice.kind === "chosen" ? choice.hostId : null;
  const namedClient = useHostClientForHostId(hostId);
  const client = hostId === null ? null : namedClient;
  const toolbarStore = useComposerToolbarStore(
    null,
    fallbackSeedSource(null, client),
    null,
    // The per-host last-used buckets the store reads and writes are the
    // chosen host's, the machine the bot will run on.
    {
      hostClient: client,
      hostId,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
    },
  );
  const modelSlug = useStore(toolbarStore, (s) => s.selection.modelSlug);
  const reasoning = useStore(toolbarStore, (s) => s.reasoning);
  // Bot creation persists no service tier; the trunk starts with Fast off.
  const maxModeContext = useMemo(
    () => chatMaxModeContextForToolbar(reasoning, ""),
    [reasoning],
  );
  const create = useBotCreateMutation(client);
  const openBotTab = useBotTabsStore((s) => s.openBotTab);
  const navigate = useNavigate();
  const titleId = useId();

  const trimmedTitle = title.trim();
  const canSubmit =
    hostId !== null &&
    trimmedTitle.length > 0 &&
    trimmedTitle.length <= BOT_TITLE_MAX &&
    modelSlug.length > 0 &&
    !create.isPending;

  const submit = (): void => {
    if (!canSubmit) return;
    const toolbar = toolbarStore.getState();
    // `mutateAsync`, not per-call `mutate` callbacks: those are dropped once
    // the component unmounts, and a form that is closed (or whose group
    // re-renders away) mid-create would still create the bot and never open
    // its tab. The continuation below holds no component state - the store
    // action and the router navigate are both module-level - so it runs
    // whatever happened to the form. A failure is already surfaced by the
    // mutation's own error channel (toast + the inline line), so the
    // rejection is swallowed here.
    void create
      .mutateAsync({
        environmentId,
        title: trimmedTitle,
        harness: toolbar.selection.harnessId,
        model: toolbar.selection.modelSlug,
        effort: toolbar.reasoning.length === 0 ? null : toolbar.reasoning,
        profile: toolbar.selection.profileId,
      })
      .then((response) => {
        openBotTab({
          botId: response.bot.botId,
          hostId,
          title: response.bot.title,
        });
        onDone();
        navigateToTabIntent(
          navigate,
          botTabIntent(response.bot.botId),
          undefined,
        );
      })
      .catch(() => undefined);
  };

  return (
    <form
      data-testid="create-bot-form"
      className="flex flex-col gap-3 rounded-md border border-border/60 bg-foreground/3 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={titleId}>Name</Label>
        <Input
          id={titleId}
          value={title}
          maxLength={BOT_TITLE_MAX}
          placeholder="What this bot looks after"
          disabled={create.isPending}
          data-testid="create-bot-title"
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      {choice.kind === "chosen" ? null : (
        <CreateBotNoHost
          checking={choice.kind === "checking"}
          environmentLabel={environmentLabel}
          someUnchecked={environmentBindings.failedHostIds.length > 0}
          onRetry={environmentBindings.retryFailed}
        />
      )}
      <div className="flex flex-col gap-1">
        <span className="text-ui-xs text-muted-foreground">Model</span>
        <div className="flex min-w-0">
          <HarnessModelPicker
            labelDisplay="responsive"
            maxModeContext={maxModeContext}
            store={toolbarStore}
            withServiceTier={false}
            withReasoning
            tuiOnly={false}
            lockedHarnessId={null}
            disabled={create.isPending || hostId === null}
            registerActivation={false}
            createProfileHostId={hostId}
            runTargetHostId={hostId}
            terminalLoginSurface={null}
            profileAdmission={null}
            embedding={null}
          />
        </div>
      </div>
      {create.error === null ? null : (
        <p role="alert" className="text-ui-xs text-destructive">
          {create.error.message}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={create.isPending}
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={!canSubmit}
          data-testid="create-bot-submit"
        >
          Create bot
          {create.isPending ? (
            <AgentSpinningDots
              className="ml-1"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      </div>
    </form>
  );
}

/**
 * Said in place of a host when the choice found none, or is still asking:
 * what the bot needs and where to set it up, never which machines were
 * looked at.
 */
function CreateBotNoHost(props: {
  readonly checking: boolean;
  readonly environmentLabel: string;
  readonly someUnchecked: boolean;
  readonly onRetry: () => void;
}): ReactNode {
  const { checking, environmentLabel, someUnchecked, onRetry } = props;
  const navigate = useNavigate();
  if (checking) {
    return (
      <p className="text-ui-xs text-muted-foreground" aria-busy="true">
        Finding a machine that runs {environmentLabel}&apos;s bots…
      </p>
    );
  }
  return (
    <p
      className="text-ui-xs text-muted-foreground"
      data-testid="create-bot-no-host"
    >
      This bot needs a machine that runs bots for {environmentLabel}. Set one up
      in{" "}
      <Button
        type="button"
        variant="link"
        size="xs"
        onClick={() =>
          navigateToTabIntent(navigate, settingsTabIntent("host"), undefined)
        }
      >
        Host settings
      </Button>
      .
      {someUnchecked ? (
        <span data-testid="create-bot-unchecked">
          {" "}
          Some of your machines couldn&apos;t be checked.{" "}
          <Button type="button" variant="link" size="xs" onClick={onRetry}>
            Retry
          </Button>
        </span>
      ) : null}
    </p>
  );
}
