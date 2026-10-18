import { useId, useMemo, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { guiHarnessIdSchema } from "@traycer/protocol/host/index";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  useBotDeleteMutation,
  useBotUpdateRunSettingsMutation,
  useBotUpdateTitleMutation,
} from "@/hooks/bots/use-bot-mutations";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";

const BOT_TITLE_MAX = 500;

/**
 * A bot's own settings (Tracy Bots): its name, the model its trunk runs on,
 * and deletion. Every write goes through the tab host's client - the host
 * `bot.open` chose to serve the tab - with nothing gated on which host that
 * is: a host that cannot make the change refuses it, and the refusal is shown
 * in place, under the control. The stream snapshot, not the mutation's
 * answer, is what the header re-renders from.
 */
export function BotSettingsPanel(props: {
  readonly bot: BotRecord;
}): ReactNode {
  const { bot } = props;
  return (
    <div className="flex flex-col gap-6 overflow-y-auto p-4">
      {/* Keyed by the stream's title: a rename made elsewhere remounts the
          form on the new name instead of leaving the field on the old one. */}
      <BotTitleForm key={bot.title} bot={bot} />
      <BotRunSettingsForm bot={bot} />
      <BotDeleteSection bot={bot} />
    </div>
  );
}

/** A write's refusal, under the control that made it. */
function BotSettingsRefusal(props: {
  readonly message: string | null;
}): ReactNode {
  if (props.message === null) return null;
  return (
    <p
      role="alert"
      className="text-ui-xs text-destructive"
      data-testid="bot-settings-refusal"
    >
      {props.message}
    </p>
  );
}

function BotTitleForm(props: { readonly bot: BotRecord }): ReactNode {
  const { bot } = props;
  const client = useTabHostClient();
  const update = useBotUpdateTitleMutation(client);
  const setBotTabTitle = useBotTabsStore((s) => s.setBotTabTitle);
  const [title, setTitle] = useState(bot.title);
  const inputId = useId();
  const trimmed = title.trim();
  const dirty = trimmed !== bot.title;
  const canSave =
    dirty &&
    trimmed.length > 0 &&
    trimmed.length <= BOT_TITLE_MAX &&
    !update.isPending;
  return (
    <form
      className="flex flex-col gap-2"
      data-testid="bot-settings-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        update.mutate(
          { botId: bot.botId, title: trimmed },
          {
            onSuccess: (response) =>
              setBotTabTitle(bot.botId, response.bot.title),
          },
        );
      }}
    >
      <Label htmlFor={inputId}>Name</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          value={title}
          maxLength={BOT_TITLE_MAX}
          disabled={update.isPending}
          className="max-w-md flex-1"
          onChange={(event) => setTitle(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={!canSave}>
          Rename
          {update.isPending ? (
            <AgentSpinningDots
              className="ml-1"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      </div>
      <BotSettingsRefusal
        message={update.error === null ? null : update.error.message}
      />
    </form>
  );
}

function BotRunSettingsForm(props: { readonly bot: BotRecord }): ReactNode {
  const { bot } = props;
  const client = useTabHostClient();
  const hostId = useTabHostId();
  const update = useBotUpdateRunSettingsMutation(client);
  // The picker opens on what the bot RUNS, not on the app default: seeded
  // from the bot row's harness, model, effort and profile, so Apply has
  // nothing to apply until the person changes something. Permission and
  // agent mode are not the bot's to set; the seed carries the app's.
  const defaultPermission = useSettingsStore((s) => s.defaultPermission);
  const botSeed = useMemo<ChatRunSettings | null>(() => {
    const harness = guiHarnessIdSchema.safeParse(bot.harness);
    if (!harness.success) return null;
    return {
      harnessId: harness.data,
      model: bot.model,
      permissionMode: defaultPermission,
      reasoningEffort: bot.effort,
      serviceTier: null,
      agentMode: "regular",
      profileId: bot.profile,
    };
  }, [bot.effort, bot.harness, bot.model, bot.profile, defaultPermission]);
  const toolbarStore = useComposerToolbarStore(
    null,
    fallbackSeedSource(botSeed, client),
    null,
    {
      hostClient: client,
      hostId,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
    },
  );
  const selection = useStore(toolbarStore, (s) => s.selection);
  const reasoning = useStore(toolbarStore, (s) => s.reasoning);
  const effort = reasoning.length === 0 ? null : reasoning;
  const unchanged =
    selection.harnessId === bot.harness &&
    selection.modelSlug === bot.model &&
    effort === bot.effort &&
    selection.profileId === bot.profile;
  const canApply =
    !unchanged && selection.modelSlug.length > 0 && !update.isPending;
  return (
    <section
      className="flex flex-col gap-2"
      aria-label="Model"
      data-testid="bot-settings-model"
    >
      <span className="text-ui-sm font-medium text-foreground">Model</span>
      <p className="text-ui-xs text-muted-foreground">
        Runs on {bot.harness} · {bot.model}
        {bot.effort === null ? null : ` · ${bot.effort}`}. The next turn uses
        what you apply here.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <HarnessModelPicker
          labelDisplay="responsive"
          store={toolbarStore}
          withServiceTier={false}
          withReasoning
          tuiOnly={false}
          lockedHarnessId={null}
          disabled={update.isPending}
          registerActivation={false}
          createProfileHostId={hostId}
          runTargetHostId={hostId}
          terminalLoginSurface={null}
          profileAdmission={null}
          embedding={null}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canApply}
          onClick={() =>
            update.mutate({
              botId: bot.botId,
              harness: selection.harnessId,
              model: selection.modelSlug,
              effort,
              profile: selection.profileId,
            })
          }
        >
          Apply
          {update.isPending ? (
            <AgentSpinningDots
              className="ml-1"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      </div>
      <BotSettingsRefusal
        message={update.error === null ? null : update.error.message}
      />
    </section>
  );
}

function BotDeleteSection(props: { readonly bot: BotRecord }): ReactNode {
  const { bot } = props;
  const client = useTabHostClient();
  const remove = useBotDeleteMutation(client);
  const closeBotTab = useBotTabsStore((s) => s.closeBotTab);
  const [open, setOpen] = useState(false);
  return (
    <section
      className="flex flex-col gap-2"
      aria-label="Delete"
      data-testid="bot-settings-delete"
    >
      <span className="text-ui-sm font-medium text-foreground">Delete</span>
      <p className="text-ui-xs text-muted-foreground">
        Stops the bot and removes it. Its conversations stay readable in
        History.
      </p>
      <div>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={remove.isPending}
          onClick={() => setOpen(true)}
        >
          Delete bot
        </Button>
      </div>
      <ConfirmDestructiveDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${bot.title}?`}
        description="The bot stops and is removed. This cannot be undone."
        cascadeSummary={null}
        actionLabel="Delete bot"
        isPending={remove.isPending}
        blockedReason={null}
        onConfirm={() =>
          remove.mutate(
            { botId: bot.botId },
            {
              onSuccess: () => {
                setOpen(false);
                closeBotTab(bot.botId);
              },
            },
          )
        }
      >
        <BotSettingsRefusal
          message={remove.error === null ? null : remove.error.message}
        />
      </ConfirmDestructiveDialog>
    </section>
  );
}
