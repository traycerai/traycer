import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useStore } from "zustand";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import {
  HostRpcError,
  mayHaveReachedHost,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { finalRefusalOf } from "@traycer-clients/shared/host-transport/retrying-messenger";

const BOT_TITLE_MAX = 500;
/** `bot.create`'s directive bound (`BOT_DIRECTIVE_MAX_LENGTH`). */
const BOT_DIRECTIVE_MAX = 8_000;

/**
 * The form's line for a failed create. Every create carries one request key
 * per form (`requestKeyRef` below), and the cloud makes at most one bot per
 * key, so submitting again after any failure never makes a second bot.
 *
 * - Not created: the host answered with a code the cloud's create only
 *   answers before it writes anything (`NOT_CREATED_CODES`), no earlier
 *   attempt of this call may have reached the host, and no earlier submit
 *   under the same key may have created the bot (`earlierMayHaveCreated`).
 *   A later refusal says nothing about what an earlier try did: membership
 *   revoked between two tries refuses the second although the first made
 *   the bot.
 * - The key already made a bot this create cannot be answered with (the
 *   fields were changed since, or that bot was deleted).
 * - Anything else may have created the bot, and trying again is safe.
 *
 * The error's own text is never shown; the mutation cache logs it.
 */
const CREATE_UNCONFIRMED =
  "Couldn't confirm the bot was created. Try again. It won't make a second bot.";
const CREATE_REFUSED = "The bot wasn't created.";
const CREATE_KEY_REUSED =
  "A bot from an earlier try was already created. Check your bots.";

/**
 * Host answers to `bot.create` that come before any write: the method is not
 * served, the cloud refused the caller, or the cloud refused the request. The
 * host answers every cloud refusal of a create's fields as
 * `E_INVALID_ARGUMENT`, and the cloud's create is one transaction, so a
 * refusal wrote nothing.
 */
const NOT_CREATED_CODES: ReadonlySet<string> = new Set([
  "E_HOST_UNSUPPORTED",
  "FORBIDDEN",
  "E_INVALID_ARGUMENT",
]);

/** What one failed submit says about the bot, on its own. */
type CreateFailure = "key-reused" | "not-created" | "unknown";

function classifyCreateFailure(error: unknown): CreateFailure {
  const refusal = finalRefusalOf(error);
  if (
    refusal instanceof HostRpcError &&
    refusal.code === "E_BOT_REQUEST_KEY_REUSED"
  ) {
    return "key-reused";
  }
  if (
    !mayHaveReachedHost(error) &&
    error instanceof HostRpcError &&
    NOT_CREATED_CODES.has(error.code)
  ) {
    return "not-created";
  }
  return "unknown";
}

function createFailureLine(
  error: Error,
  earlierMayHaveCreated: boolean,
): string {
  const failure = classifyCreateFailure(error);
  if (failure === "key-reused") return CREATE_KEY_REUSED;
  if (failure === "not-created" && !earlierMayHaveCreated) {
    return CREATE_REFUSED;
  }
  return CREATE_UNCONFIRMED;
}

/**
 * Creates a bot INTO one environment (Tracy Bots). The environment is the
 * card's and is sent explicitly; what the reader chooses here is the title,
 * the model and, optionally, the bot's directive. Never the machine: the app picks the host the bot starts on
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
  /** Each connectable host's environment (`useHostEnvironmentBindings`). */
  readonly environmentBindings: HostEnvironmentBindings;
  /** Runs once the bot exists and its tab is open. */
  readonly onCreated: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const {
    environmentId,
    environmentLabel,
    connectableHostIds,
    environmentBindings,
    onCreated,
    onCancel,
  } = props;
  const [title, setTitle] = useState("");
  const [directive, setDirective] = useState("");
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
      stagedSurfaceKey: null,
      sendsToRestingSandbox: false,
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
  // One key for every submit of this form until a create succeeds: a retry
  // after an unknown outcome names the same key, so the cloud answers it with
  // the bot the first try made instead of making a second. Kept across edits
  // too: an edited retry of a create that did go through is refused rather
  // than made twice.
  const requestKeyRef = useRef<string | null>(null);
  // Whether a submit under the current key may have created the bot: set by
  // every failure that is not a refusal before any write, cleared with the
  // key. While set, a later refusal cannot say the bot was not created.
  const [earlierMayHaveCreated, setEarlierMayHaveCreated] = useState(false);
  const openBotTab = useBotTabsStore((s) => s.openBotTab);
  const navigate = useNavigate();
  const titleId = useId();
  const directiveId = useId();

  const trimmedTitle = title.trim();
  const trimmedDirective = directive.trim();
  const canSubmit =
    hostId !== null &&
    trimmedTitle.length > 0 &&
    trimmedTitle.length <= BOT_TITLE_MAX &&
    trimmedDirective.length <= BOT_DIRECTIVE_MAX &&
    modelSlug.length > 0 &&
    !create.isPending;

  const submit = (): void => {
    if (!canSubmit) return;
    const toolbar = toolbarStore.getState();
    requestKeyRef.current ??= crypto.randomUUID();
    const requestKey = requestKeyRef.current;
    // `mutateAsync`, not per-call `mutate` callbacks: those are dropped once
    // the component unmounts, and a form that is closed (or whose group
    // re-renders away) mid-create would still create the bot and never open
    // its tab. The continuation below reads no component state - the store
    // action and the router navigate are both module-level, and writing the
    // key ref or the latch of an unmounted form is a no-op - so it runs
    // whatever happened to the form. A failure is already surfaced by the
    // mutation's own error channel (toast + the inline line); here it only
    // updates the latch.
    void create
      .mutateAsync({
        environmentId,
        title: trimmedTitle,
        harness: toolbar.selection.harnessId,
        model: toolbar.selection.modelSlug,
        effort: toolbar.reasoning.length === 0 ? null : toolbar.reasoning,
        profile: toolbar.selection.profileId,
        requestKey,
        directive: trimmedDirective.length === 0 ? null : trimmedDirective,
      })
      .then(
        (response) => {
          // The create is done: the next one this form makes is another bot.
          requestKeyRef.current = null;
          setEarlierMayHaveCreated(false);
          openBotTab({
            botId: response.bot.botId,
            hostId,
            title: response.bot.title,
          });
          onCreated();
          navigateToTabIntent(
            navigate,
            botTabIntent(response.bot.botId),
            undefined,
          );
        },
        (error: unknown) => {
          if (classifyCreateFailure(error) !== "not-created") {
            setEarlierMayHaveCreated(true);
          }
        },
      )
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
      <div className="flex flex-col gap-1">
        <Label htmlFor={directiveId}>Directive</Label>
        <Textarea
          id={directiveId}
          value={directive}
          size="sm"
          rows={3}
          maxLength={BOT_DIRECTIVE_MAX}
          placeholder="What this bot owns and how it should work (optional)"
          disabled={create.isPending}
          data-testid="create-bot-directive"
          onChange={(event) => setDirective(event.target.value)}
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
          {createFailureLine(create.error, earlierMayHaveCreated)}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={create.isPending}
          onClick={onCancel}
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
export function CreateBotNoHost(props: {
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
        Finding a host that runs {environmentLabel}&apos;s bots…
      </p>
    );
  }
  return (
    <p
      className="text-ui-xs text-muted-foreground"
      data-testid="create-bot-no-host"
    >
      This bot needs a host that runs bots for {environmentLabel}. Set one up in{" "}
      <Button
        type="button"
        variant="link"
        size="xs"
        onClick={() =>
          navigateToTabIntent(navigate, settingsTabIntent("host"), undefined)
        }
      >
        Settings
      </Button>
      .
      {someUnchecked ? (
        <span data-testid="create-bot-unchecked">
          {" "}
          Some of your hosts couldn&apos;t be checked.{" "}
          <Button type="button" variant="link" size="xs" onClick={onRetry}>
            Retry
          </Button>
        </span>
      ) : null}
    </p>
  );
}
