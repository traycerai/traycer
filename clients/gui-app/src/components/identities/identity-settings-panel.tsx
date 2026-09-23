/**
 * The identity's settings: title, description, and the evolution pass (how
 * often it runs, in turns, and the harness + model that reviews). Saved as
 * the whole tuple through `agentIdentity.update`, which is the contract's
 * shape - there is no per-field write.
 *
 * The review model is chosen with the composer's own `HarnessModelPicker` over
 * a toolbar store wired the way the Settings auto-judge row wires it: the
 * store's commit goes into local form state, never into the composer's
 * harness memory, because a model pinned for evolution is not "the model I
 * last used" on that provider.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { AgentIdentityEvolutionSettings } from "@traycer/protocol/host/agent-identity/schemas";
import {
  guiHarnessIdSchema,
  type GuiHarnessId,
} from "@traycer/protocol/host/agent/shared";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import {
  DEFAULT_PERMISSION,
  type HarnessModelSelection,
  type ModelOption,
} from "@/components/home/data/landing-options";
import {
  useGuiHarnessModelsQueryForClient,
  useGuiHarnessesQueryForClient,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useIdentityUpdateForClient } from "@/hooks/identities/use-identity-mutations";
import { identityRefusalCopy } from "@/lib/identities/refusal-copy";
import { useOpenIdentityState } from "@/lib/identity-selectors";
import {
  createComposerToolbarStore,
  type ComposerToolbarStore,
  type ComposerToolbarValues,
} from "@/stores/composer/composer-toolbar-store";

export interface IdentitySettingsPanelProps {
  readonly identityId: string;
  readonly hostId: string;
}

const EMPTY_MODELS: ReadonlyArray<ModelOption> = [];
const UNSET_REVIEW_HARNESS: GuiHarnessId = "traycer";

/**
 * A stored harness id this build has no adapter for (a newer host) reads as
 * unset: the picker cannot present it, and saving would otherwise send back
 * a provider the user never saw.
 */
function knownHarnessId(id: string | null): GuiHarnessId | null {
  if (id === null) return null;
  const parsed = guiHarnessIdSchema.safeParse(id);
  return parsed.success ? parsed.data : null;
}

interface ReviewSelection {
  readonly harnessId: GuiHarnessId | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}

function reviewSelectionOf(
  evolution: AgentIdentityEvolutionSettings,
): ReviewSelection {
  return {
    harnessId: knownHarnessId(evolution.reviewHarnessId),
    model: evolution.reviewModel,
    reasoningEffort: evolution.reviewReasoningEffort,
  };
}

function seedValuesOf(selection: ReviewSelection): ComposerToolbarValues {
  const picked: HarnessModelSelection =
    selection.harnessId === null
      ? { harnessId: UNSET_REVIEW_HARNESS, modelSlug: "", profileId: null }
      : {
          harnessId: selection.harnessId,
          modelSlug: selection.model ?? "",
          profileId: null,
        };
  return {
    permission: DEFAULT_PERMISSION,
    selection: picked,
    reasoning: selection.reasoningEffort ?? "",
    serviceTier: "",
  };
}

function seedKeyOf(selection: ReviewSelection): string {
  return [
    selection.harnessId ?? "",
    selection.model ?? "",
    selection.reasoningEffort ?? "",
  ].join("\u0000");
}

/**
 * A toolbar store for the review-model picker. Deliberately NOT
 * `useComposerToolbarStore`, for the reason the auto-judge row gives: that
 * hook writes every commit into the composer's harness memory.
 */
function useReviewToolbarStore(input: {
  readonly hostId: string;
  readonly stored: ReviewSelection;
  readonly onCommit: (selection: ReviewSelection) => void;
}): ComposerToolbarStore {
  const { hostId, stored, onCommit } = input;
  const client = useTabHostClient();
  const harnessesQuery = useGuiHarnessesQueryForClient(client, {
    enabled: true,
    subscribed: true,
  });
  const harnesses = harnessesQuery.data?.harnesses;
  const seedKey = seedKeyOf(stored);
  const seedValues = useMemo(() => seedValuesOf(stored), [stored]);
  const [store] = useState(() =>
    createComposerToolbarStore({
      seedKey,
      values: seedValues,
      onSettingsChange: null,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      hostId,
    }),
  );
  const write = useCallback(
    (settings: ChatRunSettings) =>
      onCommit({
        harnessId: settings.harnessId,
        model: settings.model,
        reasoningEffort:
          settings.reasoningEffort === null ||
          settings.reasoningEffort.length === 0
            ? null
            : settings.reasoningEffort,
      }),
    [onCommit],
  );
  useEffect(() => {
    store.getState().setOnSettingsChange(write);
  }, [store, write]);
  useLayoutEffect(() => {
    store.getState().applySeed(seedKey, seedValues);
  }, [store, seedKey, seedValues]);

  const harnessId = useStore(store, (s) => s.selection.harnessId);
  const modelsQuery = useGuiHarnessModelsQueryForClient(
    client,
    harnessId,
    null,
    {
      enabled: true,
      subscribed: true,
    },
  );
  const models = modelsQuery.data?.models;
  const modelsLoaded = modelsQuery.data !== undefined;
  useEffect(() => {
    store.getState().setCatalog({
      hostId,
      harnesses,
      modelsHarnessId: harnessId,
      models: models ?? EMPTY_MODELS,
      modelsLoaded,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
    });
  }, [store, hostId, harnesses, harnessId, models, modelsLoaded]);
  return store;
}

export function IdentitySettingsPanel(
  props: IdentitySettingsPanelProps,
): ReactNode {
  const identity = useOpenIdentityState((state) => state.identity);
  if (identity === null) {
    return (
      <div
        className="flex items-center justify-center p-4 text-ui-xs text-muted-foreground"
        data-testid="identity-settings-loading"
      >
        <MutedAgentSpinner />
      </div>
    );
  }
  return (
    <IdentitySettingsForm
      key={props.identityId}
      identityId={props.identityId}
      hostId={props.hostId}
      title={identity.title}
      description={identity.description}
      evolution={identity.evolution}
    />
  );
}

function IdentitySettingsForm(props: {
  readonly identityId: string;
  readonly hostId: string;
  readonly title: string;
  readonly description: string | null;
  readonly evolution: AgentIdentityEvolutionSettings;
}): ReactNode {
  const { identityId, hostId, evolution } = props;
  const client = useTabHostClient();
  const update = useIdentityUpdateForClient(client);
  const [title, setTitle] = useState(props.title);
  const [description, setDescription] = useState(props.description ?? "");
  const [intervalTurns, setIntervalTurns] = useState(
    String(evolution.intervalTurns),
  );
  const stored = useMemo(() => reviewSelectionOf(evolution), [evolution]);
  const [review, setReview] = useState<ReviewSelection>(stored);
  const [notice, setNotice] = useState<string | null>(null);
  const store = useReviewToolbarStore({ hostId, stored, onCommit: setReview });

  const parsedInterval = Number.parseInt(intervalTurns, 10);
  const intervalValid = Number.isInteger(parsedInterval) && parsedInterval >= 0;
  const trimmedTitle = title.trim();
  const canSave = intervalValid && trimmedTitle.length > 0 && !update.isPending;

  const save = () => {
    if (!canSave) return;
    setNotice(null);
    update.mutate(
      {
        identityId,
        title: trimmedTitle,
        description:
          description.trim().length === 0 ? null : description.trim(),
        evolution: {
          intervalTurns: parsedInterval,
          reviewHarnessId: review.harnessId,
          reviewModel: review.harnessId === null ? null : review.model,
          reviewReasoningEffort:
            review.harnessId === null ? null : review.reasoningEffort,
        },
      },
      {
        onSuccess: (response) => {
          if (response.kind === "refused") {
            setNotice(identityRefusalCopy(response.reason));
          }
        },
      },
    );
  };

  return (
    <form
      className="flex flex-col gap-4 p-3"
      data-testid="identity-settings-panel"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="identity-title">Name</Label>
        <Input
          id="identity-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          data-testid="identity-settings-title"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="identity-description">Description</Label>
        <Textarea
          id="identity-description"
          value={description}
          rows={3}
          onChange={(event) => setDescription(event.target.value)}
          data-testid="identity-settings-description"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="identity-interval">Evolve every</Label>
        <div className="flex items-center gap-2">
          <Input
            id="identity-interval"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={intervalTurns}
            onChange={(event) => setIntervalTurns(event.target.value)}
            aria-invalid={!intervalValid}
            data-testid="identity-settings-interval"
          />
          <span className="shrink-0 text-ui-xs text-muted-foreground">
            turns
          </span>
        </div>
        <p className="text-ui-xs text-muted-foreground">
          0 turns off evolution for this identity.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Review model</Label>
        <HarnessModelPicker
          store={store}
          withServiceTier={false}
          withReasoning
          tuiOnly={false}
          lockedHarnessId={null}
          disabled={update.isPending}
          registerActivation={false}
          createProfileHostId={hostId}
          runTargetHostId={hostId}
          terminalLoginSurface={null}
          labelDisplay="responsive"
          profileAdmission={null}
        />
        {review.harnessId === null ? (
          <p className="text-ui-xs text-muted-foreground">
            Using the host&apos;s default review model.
          </p>
        ) : null}
      </div>
      {notice !== null ? (
        <p
          role="alert"
          data-testid="identity-settings-notice"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-ui-xs text-destructive-foreground"
        >
          {notice}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={!canSave}
          data-testid="identity-settings-save"
        >
          Save
        </Button>
        {update.isPending ? <MutedAgentSpinner /> : null}
      </div>
    </form>
  );
}
