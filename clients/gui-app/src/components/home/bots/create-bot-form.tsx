import { useId, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useStore } from "zustand";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useBotCreateMutation } from "@/hooks/bots/use-bot-mutations";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { botTabIntent, settingsTabIntent } from "@/lib/tab-navigation/intents";
import { navigateToTabIntent } from "@/lib/tab-navigation";

const BOT_TITLE_MAX = 500;

/**
 * Creates a bot INTO one environment (Tracy Bots). The environment is the
 * card's and is sent explicitly; what the reader chooses here is the title,
 * the model, and - when more than one of their hosts runs this environment -
 * which host the bot's trunk starts on. A host that runs a different
 * environment is not offered, because the host, not the form, decides what
 * environment it serves; that is changed in Settings.
 *
 * The create goes to the chosen host's own client, and the tab the success
 * opens binds to that host for life.
 */
export function CreateBotForm(props: {
  readonly environmentId: string;
  readonly environmentLabel: string;
  /** Connectable hosts whose `environment.host.read` names this environment. */
  readonly boundHostIds: ReadonlyArray<string>;
  /** Every connectable host has answered; false while one is still asked. */
  readonly bindingsResolved: boolean;
  /** Connectable hosts whose environment could not be read: not offered, and
   * said so, since a host that could not be asked may well run this one. */
  readonly failedHostIds: ReadonlyArray<string>;
  readonly onRetryFailedHosts: () => void;
  readonly hostLabels: ReadonlyMap<string, string>;
  readonly onDone: () => void;
}): ReactNode {
  const {
    environmentId,
    environmentLabel,
    boundHostIds,
    bindingsResolved,
    failedHostIds,
    onRetryFailedHosts,
    hostLabels,
    onDone,
  } = props;
  const [title, setTitle] = useState("");
  const [pickedHostId, setPickedHostId] = useState<string | null>(null);
  const hostId = resolveHostChoice(boundHostIds, pickedHostId);
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
      <CreateBotHostField
        environmentLabel={environmentLabel}
        boundHostIds={boundHostIds}
        bindingsResolved={bindingsResolved}
        hostLabels={hostLabels}
        hostId={hostId}
        disabled={create.isPending}
        onPick={setPickedHostId}
      />
      {failedHostIds.length === 0 ? null : (
        <p
          role="status"
          className="text-ui-xs text-muted-foreground"
          data-testid="create-bot-failed-hosts"
        >
          Couldn&apos;t read which environment{" "}
          {failedHostIds.map((id) => hostLabels.get(id) ?? id).join(", ")}{" "}
          {failedHostIds.length === 1 ? "runs" : "run"}, so{" "}
          {failedHostIds.length === 1 ? "it is" : "they are"} not offered.{" "}
          <Button
            type="button"
            variant="link"
            size="xs"
            onClick={onRetryFailedHosts}
          >
            Retry
          </Button>
        </p>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-ui-xs text-muted-foreground">Model</span>
        <div className="flex min-w-0">
          <HarnessModelPicker
            labelDisplay="responsive"
            maxModeContext={{ kind: "none" }}
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
 * The host the create goes to: the reader's pick while it is still one of
 * the bound hosts, else the first bound host, else none.
 */
function resolveHostChoice(
  boundHostIds: ReadonlyArray<string>,
  pickedHostId: string | null,
): string | null {
  if (pickedHostId !== null && boundHostIds.includes(pickedHostId)) {
    return pickedHostId;
  }
  return boundHostIds.length > 0 ? boundHostIds[0] : null;
}

function CreateBotHostField(props: {
  readonly environmentLabel: string;
  readonly boundHostIds: ReadonlyArray<string>;
  readonly bindingsResolved: boolean;
  readonly hostLabels: ReadonlyMap<string, string>;
  readonly hostId: string | null;
  readonly disabled: boolean;
  readonly onPick: (hostId: string) => void;
}): ReactNode {
  const {
    environmentLabel,
    boundHostIds,
    bindingsResolved,
    hostLabels,
    hostId,
    disabled,
    onPick,
  } = props;
  const navigate = useNavigate();
  const fieldId = useId();
  if (hostId === null) {
    if (!bindingsResolved) {
      return (
        <p className="text-ui-xs text-muted-foreground" aria-busy="true">
          Checking which hosts run {environmentLabel}…
        </p>
      );
    }
    return (
      <p
        className="text-ui-xs text-muted-foreground"
        data-testid="create-bot-no-host"
      >
        None of your connected hosts runs {environmentLabel}. A host runs one
        environment at a time; choose it in{" "}
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={() =>
            navigateToTabIntent(
              navigate,
              settingsTabIntent("agents"),
              undefined,
            )
          }
        >
          Settings
        </Button>
        .
      </p>
    );
  }
  if (boundHostIds.length === 1) {
    return (
      <p
        className="text-ui-xs text-muted-foreground"
        data-testid="create-bot-host"
      >
        Runs on {hostLabels.get(hostId) ?? hostId}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={fieldId}>Runs on</Label>
      <Select value={hostId} onValueChange={onPick} disabled={disabled}>
        <SelectTrigger
          id={fieldId}
          size="sm"
          className="w-full"
          data-testid="create-bot-host"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {boundHostIds.map((id) => (
            <SelectItem key={id} value={id}>
              {hostLabels.get(id) ?? id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
