/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Judge).
 * Update that file whenever this settings surface changes.
 */
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { CircleDot, Sparkle } from "lucide-react";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type {
  AutoJudgeGetResponse,
  AutoJudgeSelection,
} from "@traycer/protocol/host/auto-mode/contracts";
import { effectiveJudgeReasoningEffort } from "@traycer/protocol/host/agent/gui/reasoning-effort-order";
import { SettingsGroup } from "@/components/settings/settings-group";
import { Badge } from "@/components/ui/badge";
import {
  ChoiceTile,
  ChoiceTileDescription,
  ChoiceTileFooter,
  ChoiceTileTitle,
} from "@/components/ui/choice-tile";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  HarnessModelPicker,
  type HarnessModelPickerEmbedding,
} from "@/components/home/pickers/harness-model-picker";
import {
  profileAccentDotInput,
  profileDisplayLabel,
} from "@/components/providers/provider-profile-model";
import {
  useAutoJudgeQuery,
  useAutoJudgeVerdict,
} from "@/hooks/auto-mode/use-auto-judge-query";
import { useAutoJudgeSetMutation } from "@/hooks/auto-mode/use-auto-judge-set-mutation";
import { autoJudgeModelLabel } from "@/hooks/auto-mode/use-auto-judge-billing";
import {
  useHostMethodSchemaVersion,
  useHostSupportsMethod,
} from "@/hooks/host/use-host-supports-method";
import {
  useGuiHarnessModelsQuery,
  useGuiHarnessesQuery,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { PERMISSIONS } from "@/components/settings/panels/permissions-settings.definitions";
import {
  judgeWarningCause,
  offeredJudgeProfileIds,
} from "@/components/settings/panels/auto-judge-selection";
import {
  AutoModeHostGate,
  AutoModeUnsupportedLine,
} from "@/components/settings/panels/permissions/auto-mode-host-gate";
import { BuiltInReviewerPointer } from "@/components/settings/panels/permissions/built-in-reviewer-pointer";
import {
  JUDGE_MODEL_FACE_SELECTOR,
  JudgeModelFace,
  type JudgeFace,
} from "@/components/settings/panels/permissions/judge-model-face";
import {
  AutomaticStatus,
  DroppedSwitchLine,
  JudgeSavingLine,
  JudgeWarning,
  PendingSwitchLine,
  PickedStatus,
} from "@/components/settings/panels/permissions/judge-status-lines";
import {
  judgeCauseShortLabel,
  judgeFaceDimmed,
  judgeFaceInert,
  judgePickAccount,
  judgePickerDisabled,
  judgeSeedSelection,
  judgeSelectionMarked,
  judgeStoreSelection,
  judgeTileOpensPicker,
  judgeTileState,
  shownJudgePick,
  type JudgeDraft,
  type JudgeTileState,
} from "@/components/settings/panels/permissions/judge-tile-state";
import {
  useJudgeToolbarStore,
  type JudgeToolbarStore,
} from "@/components/settings/panels/permissions/use-judge-toolbar-store";
import {
  autoJudgeGetKnowsReasoningEffort,
  autoJudgeSetStoresReasoningEffort,
} from "@/lib/auto-mode/auto-judge-billing";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

const PREDATES_AUTO_MODE =
  "This machine's host predates Auto mode. Update it to choose a judge and write a policy.";

/** A typed harness id for the models query while no pick is shown. */
const IDLE_MODELS_HARNESS_ID = providerIdToGuiHarnessId("traycer");

/** The radio values of the two tiles; `""` checks neither (still loading). */
const AUTOMATIC = "automatic";
const PICK = "pick";

const ARROW_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

/**
 * Settings ▸ Permissions ▸ Judge: which model checks commands in Auto mode on
 * this machine - Automatic, or a model you pick - and a pointer to any
 * provider set to review its own, whose switch lives on Providers ▸
 * {provider} ▸ Permissions.
 */
export function JudgeTab(): ReactNode {
  return (
    <AutoModeHostGate
      method="autoJudge.get"
      unsupported={
        <AutoModeUnsupportedLine>{PREDATES_AUTO_MODE}</AutoModeUnsupportedLine>
      }
    >
      {(hostId) => (
        <div className="flex flex-col gap-5">
          <SettingsGroup
            group={PERMISSIONS.definitions.autoModeJudge}
            showTitle
            tone="default"
            dataTestId={undefined}
            fill={false}
          >
            <AutoJudgeCard hostId={hostId} />
          </SettingsGroup>
          <BuiltInReviewerPointer hostId={hostId} />
        </div>
      )}
    </AutoModeHostGate>
  );
}

/** What the tiles present, and the one way to change it. */
interface JudgePick {
  /** The latest pick, until its write settles. */
  readonly draft: JudgeDraft | null;
  /** The selection on screen: the latest pick, else the stored record. */
  readonly displayed: AutoJudgeSelection | null;
  readonly request: (selection: AutoJudgeSelection | null) => void;
}

/**
 * The judge the tiles present, and the write behind it.
 *
 * **Nothing is disabled while a write is in flight.** The mutation's
 * host-scoped queue orders two picks; what an old disable was standing in for
 * is that the tiles must not RESEED from the record while a write is pending,
 * and they do not - they present the latest pick (`draft`) until its write
 * settles, whatever earlier writes do. A refused write clears the draft, which
 * is the rollback: the tiles fall back to the record the host holds, and the
 * mutation's own toast says the change was not saved.
 */
function useJudgePick(stored: AutoJudgeSelection | null): JudgePick {
  const mutateJudge = useAutoJudgeSetMutation().mutate;
  const [draft, setDraft] = useState<JudgeDraft | null>(null);
  const lastDraftId = useRef(0);
  const request = useCallback(
    (selection: AutoJudgeSelection | null) => {
      // The contract refuses an empty model, and nothing here should ask.
      if (selection !== null && selection.model.length === 0) return;
      lastDraftId.current += 1;
      const id = lastDraftId.current;
      // A switch to Automatic records the pick it clears - what the tiles
      // present right now, which can be a pick still saving - so the second
      // tile keeps it on show, dimmed, until the host's own `lastSelection`
      // takes over.
      setDraft((current) => ({
        id,
        selection,
        clearing: selection === null ? presentedPick(current, stored) : null,
      }));
      const settle = (): void => {
        setDraft((current) => (current?.id === id ? null : current));
      };
      // Per-call callbacks fire only for the latest `mutate`, which is the
      // only draft whose settlement may clear the tiles.
      mutateJudge({ selection }, { onSuccess: settle, onError: settle });
    },
    [mutateJudge, stored],
  );
  return {
    draft,
    displayed: presentedPick(draft, stored),
    request,
  };
}

/** The selection the tiles present: the latest pick, else the stored one. */
function presentedPick(
  draft: JudgeDraft | null,
  stored: AutoJudgeSelection | null,
): AutoJudgeSelection | null {
  return draft === null ? stored : draft.selection;
}

/**
 * The catalog of the pick the second tile shows, for its label and for
 * whether a last pick can run. Read while the provider is available only:
 * a provider that cannot run is reported before its model is, and a read
 * would start its server for nothing.
 */
function useShownPickModels(
  shown: AutoJudgeSelection | null,
  harnesses: ReadonlyArray<GuiHarnessOption> | undefined,
): ReadonlyArray<GuiAgentModelOption> | undefined {
  const row =
    shown === null
      ? undefined
      : harnesses?.find((candidate) => candidate.id === shown.harnessId);
  const available = row?.available === true;
  const models = useGuiHarnessModelsQuery(
    row?.id ?? IDLE_MODELS_HARNESS_ID,
    null,
    { enabled: available, subscribed: available },
  ).data?.models;
  return row === undefined ? undefined : models;
}

/**
 * Re-reads this machine's judge whenever the window gains focus, even while
 * the cached answer is fresh, so an open tab follows a change made in another
 * window or on another device. The window's own `focus` event, not TanStack's
 * focus manager: that one follows `visibilitychange`, which never fires when
 * focus moves between two visible windows.
 *
 * A plain refetch, never an invalidation: the verdict reader withholds an
 * invalidated answer, and this one is only being re-asked - its line stays up
 * until the new answer replaces it. A pick made on this card still wins until
 * its save settles: the tiles present the draft over the record, and the save
 * cancels any read in flight before it writes its echo.
 *
 * Scoped to this tab. The composer's readers keep re-reading on mount only.
 */
function useRefetchOnWindowFocus(refetch: () => Promise<unknown>): void {
  const onFocus = useEffectEvent(() => {
    void refetch();
  });
  useEffect(() => {
    const listener = (): void => {
      onFocus();
    };
    window.addEventListener("focus", listener);
    return () => {
      window.removeEventListener("focus", listener);
    };
  }, []);
}

/**
 * The Auto mode judge card: a lead line, the lines about what could not be
 * read, and the two tiles.
 */
function AutoJudgeCard(props: { readonly hostId: string | null }): ReactNode {
  // Two readers of one record. The SELECTION is shown whatever its age - the
  // picker hands off to it - while the VERDICT (`effective`, `blocked`) is
  // withheld from the moment it is invalidated until a re-read lands. That is
  // the composer's rule, so Settings and the composer never name different
  // accounts.
  const query = useAutoJudgeQuery();
  const verdict = useAutoJudgeVerdict();
  useRefetchOnWindowFocus(query.refetch);
  const canWrite = useHostSupportsMethod(props.hostId, "autoJudge.set");
  // Two gates on two lines, as the composer draws them: the picker's effort
  // FOOTER writes through `set`, so it needs a `set` line that stores the
  // effort; every LABEL that names one (the face, the "Now:" line) reports
  // what `get`'s host runs, so it needs a `get` line whose host applies one.
  const storesEffort = autoJudgeSetStoresReasoningEffort(
    useHostMethodSchemaVersion(props.hostId, "autoJudge.set"),
  );
  const hostRunsEffort = autoJudgeGetKnowsReasoningEffort(
    useHostMethodSchemaVersion(props.hostId, "autoJudge.get"),
  );
  const harnessesQuery = useGuiHarnessesQuery({
    enabled: true,
    subscribed: true,
  });
  const harnesses = harnessesQuery.data?.harnesses;
  const providersQuery = useProvidersList({ enabled: true, subscribed: true });
  const providers = providersQuery.data?.providers;
  const record = query.data;
  const pick = useJudgePick(record?.selection ?? null);
  const shownModels = useShownPickModels(
    shownJudgePick(record, pick.draft),
    harnesses,
  );
  const state = judgeTileState({
    record,
    draft: pick.draft,
    canWrite,
    catalogsAnswered:
      (harnesses !== undefined || harnessesQuery.isError) &&
      (providers !== undefined || providersQuery.isError),
    harnesses,
    providers,
    shownModels,
  });
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-muted-foreground">
        {PERMISSIONS.definitions.autoModeJudge.description}
        <Badge variant="muted" size="xs">
          This machine
        </Badge>
      </p>
      {query.isError ? (
        <p className="text-ui-sm font-medium text-warning-foreground">
          Couldn&apos;t read this machine&apos;s judge. Reopen Settings to try
          again.
        </p>
      ) : null}
      {/* Every finding about a pick past the host's own verdict waits on the
          catalog; an errored query refetches on its next mount. */}
      {harnesses === undefined && harnessesQuery.isError ? (
        <p
          className="text-ui-sm font-medium text-warning-foreground"
          data-testid="auto-judge-providers-error"
        >
          Couldn&apos;t load this machine&apos;s providers. Reopen Settings to
          try again.
        </p>
      ) : null}
      {canWrite ? null : (
        <p className="text-ui-sm font-medium text-warning-foreground">
          This machine&apos;s host can&apos;t change the judge. Update it to
          pick a different one.
        </p>
      )}
      <JudgeTiles
        hostId={props.hostId}
        state={state}
        record={record}
        verdict={verdict}
        pick={pick}
        harnesses={harnesses}
        providers={providers}
        shownModels={shownModels}
        storesEffort={storesEffort}
        hostRunsEffort={hostRunsEffort}
      />
    </div>
  );
}

interface JudgeTilesProps {
  readonly hostId: string | null;
  readonly state: JudgeTileState;
  readonly record: AutoJudgeGetResponse | undefined;
  /** The CURRENT record, or `undefined` while its verdict is withheld. */
  readonly verdict: AutoJudgeGetResponse | undefined;
  readonly pick: JudgePick;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
  readonly shownModels: ReadonlyArray<GuiAgentModelOption> | undefined;
  /** The host's `autoJudge.set` stores an effort: the picker draws its footer. */
  readonly storesEffort: boolean;
  /** The host's `autoJudge.get` runs one: the face and "Now:" line name it. */
  readonly hostRunsEffort: boolean;
}

/**
 * The two tiles, one radio group: "✦ Automatic" and "◎ A model you pick".
 *
 * Each tile's radio is the control, labelled by its title and described by
 * its description; the tile body is a pointer convenience that does what
 * choosing the tile does. The picker's face is a sibling of the radio, never
 * inside it.
 */
function JudgeTiles(props: JudgeTilesProps): ReactNode {
  const { state, pick } = props;
  const picker = useJudgePicker(props);
  const arrowKeyHeld = useArrowKeyHeld();
  const opensPicker = judgeTileOpensPicker(state);
  const inert = state.row === "loading" || state.readOnly;

  // A choice that changes the outcome ends a provider switch still waiting
  // for its models: the latest click wins, and that switch must not land
  // after it. Choosing Automatic ends one even when Automatic is already on
  // - it is an explicit "Automatic", whichever part of the tile it lands on
  // (the radio's own click, below, covers the checked circle and Space).
  const chooseAutomatic = (): void => {
    picker.toolbar.dropPending();
    if (pick.displayed !== null) pick.request(null);
  };
  // What choosing the second tile does in each row: nothing when it is
  // already chosen, bring the last pick back when it can run, and open the
  // picker when there is none or it cannot. In Picked, a switch still
  // waiting is itself this tile's choice (flow 1: it lands even if the panel
  // closed meanwhile), and clicking the tile again is not a new one, so it
  // survives; so it does opening the picker. Any tile choice clears the line
  // a dropped switch left behind.
  const choosePick = (): void => {
    picker.toolbar.clearDroppedSwitch();
    if (state.row === "last-runs" && state.shown !== null) {
      picker.toolbar.dropPending();
      pick.request(state.shown);
    } else if (opensPicker) {
      picker.open();
    }
  };

  return (
    <div className="@container">
      <RadioGroup
        aria-label="Auto mode judge"
        className="@lg:grid-cols-2"
        value={radioValue(state)}
        disabled={inert}
        // Pointer clicks on a radio, Space, and an arrow arriving on it. An
        // arrow onto "A model you pick" brings the last pick back when it can
        // run; where it cannot, it only moves focus - Space or Enter opens
        // the picker (below), and an arrow never does.
        onValueChange={(next) => {
          if (next === AUTOMATIC) chooseAutomatic();
          else if (next === PICK && state.row === "last-runs") choosePick();
        }}
      >
        <ChoiceTile
          data-testid="auto-judge-tile-automatic"
          onClick={(event) => {
            if (inert || tileClickHitControl(event, false)) return;
            chooseAutomatic();
          }}
        >
          <AutomaticTileContent
            {...props}
            // Radix answers a click on an already-checked radio with no
            // `onValueChange`, and the tile hands radio clicks to the radio,
            // so the checked circle (and Space, a native click) would reach
            // neither.
            onRadioClick={() => {
              picker.toolbar.dropPending();
            }}
          />
        </ChoiceTile>
        <ChoiceTile
          data-testid="auto-judge-tile-pick"
          onPointerDown={() => {
            picker.noteOpenAtPointerDown();
          }}
          onClick={(event) => {
            if (inert || tileClickHitControl(event, picker.face.inert)) return;
            // A click on the tile while its picker is open is the outside
            // click that closed it, not a request to open it again.
            if (picker.wasOpenAtPointerDown()) return;
            choosePick();
          }}
        >
          <PickTileContent
            {...props}
            picker={picker}
            onRadioClick={(event) => {
              // A pointer click on the radio opens the picker where choosing
              // the tile does; the click an arrow key synthesizes (Radix
              // checks the radio it lands on) must not. A real click is a
              // tile choice even on the checked radio, which Radix answers
              // with no `onValueChange`.
              if (arrowKeyHeld.current) return;
              picker.toolbar.clearDroppedSwitch();
              if (!opensPicker) return;
              event.preventDefault();
              picker.open();
            }}
            onRadioKeyDown={(event) => {
              if (!opensPicker) return;
              if (event.key !== " " && event.key !== "Enter") return;
              event.preventDefault();
              picker.open();
            }}
          />
        </ChoiceTile>
      </RadioGroup>
    </div>
  );
}

/** The checked tile, from what is displayed; neither while loading. */
function radioValue(state: JudgeTileState): string {
  if (state.row === "loading") return "";
  return state.row === "picked" ? PICK : AUTOMATIC;
}

/**
 * Whether a click on a tile belongs to a control inside it rather than to the
 * tile: the radio (it answers through `onValueChange`), a link, or an enabled
 * face (it opens the picker itself). A click that did not start inside the
 * tile's own DOM is one from the picker's panel, which is portaled away but
 * still bubbles through React to the tile. An INERT face is not a control -
 * its click is the tile's, which is how a click on the dimmed chip restores
 * the last pick.
 */
function tileClickHitControl(
  event: MouseEvent<HTMLDivElement>,
  faceInert: boolean,
): boolean {
  const { target } = event;
  if (!(target instanceof Element)) return true;
  if (!event.currentTarget.contains(target)) return true;
  const control = target.closest("button, a, input, textarea, select");
  if (control === null) return false;
  return !(faceInert && control.matches(JUDGE_MODEL_FACE_SELECTOR));
}

/**
 * Whether an arrow key is down right now. Radix checks the radio an arrow key
 * moves focus onto by clicking it while the key is held, and this is the same
 * signal it reads, so the two agree on which clicks an arrow made.
 */
function useArrowKeyHeld(): RefObject<boolean> {
  const held = useRef(false);
  useEffect(() => {
    const down = (event: globalThis.KeyboardEvent): void => {
      if (ARROW_KEYS.has(event.key)) held.current = true;
    };
    const up = (): void => {
      held.current = false;
    };
    document.addEventListener("keydown", down, { capture: true });
    document.addEventListener("keyup", up, { capture: true });
    return () => {
      document.removeEventListener("keydown", down, { capture: true });
      document.removeEventListener("keyup", up, { capture: true });
    };
  }, []);
  return held;
}

function AutomaticTileContent(
  props: JudgeTilesProps & { readonly onRadioClick: () => void },
): ReactNode {
  const radioId = useId();
  const titleId = useId();
  const descriptionId = useId();
  return (
    <>
      <RadioGroupItem
        value={AUTOMATIC}
        id={radioId}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={props.onRadioClick}
      />
      <ChoiceTileTitle id={titleId}>
        <Sparkle aria-hidden className="text-primary" />
        Automatic
        <Badge variant="outline" size="xs">
          Recommended
        </Badge>
      </ChoiceTileTitle>
      <ChoiceTileDescription id={descriptionId}>
        Traycer&apos;s recommended model, or the conversation&apos;s own when
        Traycer can&apos;t answer.
      </ChoiceTileDescription>
      <ChoiceTileFooter aria-live="polite">
        <AutomaticFoot {...props} />
      </ChoiceTileFooter>
    </>
  );
}

/**
 * The first tile's status line, shown only while Automatic is selected: the
 * spinner alone while the switch to it saves, then what Automatic resolves
 * to, once the host's verdict about Automatic is current.
 */
function AutomaticFoot(props: JudgeTilesProps): ReactNode {
  const { state, verdict } = props;
  if (state.row === "loading" || state.row === "picked") return null;
  if (props.pick.draft !== null) return <JudgeSavingLine />;
  if (verdict === undefined || verdict.selection !== null) return null;
  return (
    <AutomaticStatus
      record={verdict}
      harnesses={props.harnesses}
      copilotEnabled={
        props.providers?.some(
          (provider) => provider.providerId === "copilot" && provider.enabled,
        ) ?? false
      }
      hostRunsEffort={props.hostRunsEffort}
    />
  );
}

function PickTileContent(
  props: JudgeTilesProps & {
    readonly picker: JudgePicker;
    readonly onRadioClick: (event: MouseEvent<HTMLButtonElement>) => void;
    readonly onRadioKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  },
): ReactNode {
  const { state, picker } = props;
  const radioId = useId();
  const titleId = useId();
  const descriptionId = useId();
  return (
    <>
      <RadioGroupItem
        value={PICK}
        id={radioId}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={props.onRadioClick}
        onKeyDown={props.onRadioKeyDown}
      />
      <ChoiceTileTitle id={titleId}>
        <CircleDot aria-hidden className="text-muted-foreground" />A model you
        pick
      </ChoiceTileTitle>
      <ChoiceTileDescription id={descriptionId}>
        Always the model you choose, billed to that provider. If it can&apos;t
        answer, Auto mode asks you.
      </ChoiceTileDescription>
      {state.row === "loading" ? null : (
        <HarnessModelPicker
          store={picker.toolbar.store}
          // No Fast setting to carry. The effort footer is the judge's Effort
          // control: drawn only on a host whose `autoJudge.set` stores one,
          // seeded with the level the host runs (the stored effort, else the
          // model's lowest), and every change in it saves at once.
          withServiceTier={false}
          withReasoning={props.storesEffort}
          tuiOnly={false}
          lockedHarnessId={null}
          disabled={judgePickerDisabled(state)}
          // Not the composer's toggle target: the model-picker shortcut and
          // the palette's "Change model…" belong to the chat behind Settings.
          registerActivation={false}
          // The machine Settings is scoped to, for the catalog and for
          // "Create new profile", whose flow mounts outside Settings' binding.
          // `null` only while Settings follows the effective host, where the
          // two are the same machine.
          createProfileHostId={props.hostId}
          runTargetHostId={props.hostId}
          // No terminal to open a provider's setup session into from Settings;
          // the panel shows the steps without the button.
          terminalLoginSurface={null}
          labelDisplay="model-only"
          profileAdmission={null}
          embedding={picker.embedding}
        />
      )}
      <ChoiceTileFooter aria-live="polite">
        <PickFoot {...props} toolbar={picker.toolbar} />
      </ChoiceTileFooter>
    </>
  );
}

/**
 * The second tile's status line. A provider switch waiting for its models,
 * or the line one dropped for having none left behind, reports here whichever
 * tile is selected, because that pick belongs to this tile. Otherwise only
 * while a picked model is selected: the spinner alone while it saves, then
 * what is wrong with the stored pick or, when nothing is, who it bills - each
 * once the host's verdict is current.
 */
function PickFoot(
  props: JudgeTilesProps & { readonly toolbar: JudgeToolbarStore },
): ReactNode {
  const pending = props.toolbar.pendingSwitch;
  if (pending !== null) {
    return <PendingSwitchLine pending={pending} harnesses={props.harnesses} />;
  }
  // A switch dropped for having no models, or failing to load them, still
  // says so above whatever the tile now describes.
  const dropped = props.toolbar.droppedSwitch;
  return (
    <>
      {dropped === null ? null : (
        <DroppedSwitchLine dropped={dropped} harnesses={props.harnesses} />
      )}
      <PickStatus {...props} />
    </>
  );
}

/**
 * The stored pick's own line, while it is selected: the spinner alone while
 * it saves, then what is wrong with it or, when nothing is, who it bills.
 */
function PickStatus(props: JudgeTilesProps): ReactNode {
  const { verdict } = props;
  const openProvider = useOpenJudgeProvider();
  if (props.state.row !== "picked") return null;
  if (props.pick.draft !== null) return <JudgeSavingLine />;
  const stored = verdict?.selection ?? null;
  if (verdict === undefined || stored === null) return null;
  // With no pick in flight, the shown pick IS the stored one, so its catalog
  // is the stored provider's.
  const cause = judgeWarningCause({
    stored,
    blocked: verdict.blocked ?? null,
    harnesses: props.harnesses,
    offeredModels: props.shownModels,
    offeredProfileIds: offeredJudgeProfileIds(
      props.providers,
      stored.harnessId,
    ),
  });
  if (cause !== null) {
    return (
      <JudgeWarning
        cause={cause}
        stored={stored}
        harnesses={props.harnesses}
        onOpenProvider={openProvider}
      />
    );
  }
  return (
    <PickedStatus
      selection={stored}
      harnesses={props.harnesses}
      providers={props.providers}
    />
  );
}

/** The judge's picker: its store, its face, and the embedding that joins them. */
interface JudgePicker {
  readonly toolbar: JudgeToolbarStore;
  readonly face: JudgeFace;
  readonly embedding: HarnessModelPickerEmbedding;
  /** Opens the picker, as a click on its face would. */
  readonly open: () => void;
  /** Records, on the tile's pointerdown, whether the picker was open. */
  readonly noteOpenAtPointerDown: () => void;
  /** Reads (and clears) what the last pointerdown recorded. */
  readonly wasOpenAtPointerDown: () => boolean;
}

function useJudgePicker(props: JudgeTilesProps): JudgePicker {
  const { state, harnesses } = props;
  // The picker reports its open state to nobody; its face reads it off the
  // trigger's `aria-expanded` and hands it here.
  const [pickerOpen, setPickerOpen] = useState(false);
  const selectionMarked = judgeSelectionMarked(state);
  const toolbar = useJudgeToolbarStore({
    seedRow: state.row,
    seed: judgeSeedSelection({
      state,
      effective: props.record?.effective,
      harnesses,
    }),
    // The shown pick's own effort; an unpicked seed has none.
    seedReasoning: state.shown?.reasoningEffort ?? "",
    // Marked is exactly "the seed is the pick on show".
    seedIsPick: selectionMarked,
    storesEffort: props.storesEffort,
    pickerOpen,
    harnesses,
    onPick: props.pick.request,
  });

  const settleOnClose = useEffectEvent(() => {
    toolbar.settleOnClose();
  });
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !pickerOpen) settleOnClose();
    wasOpen.current = pickerOpen;
  }, [pickerOpen]);
  const openAtPointerDown = useRef(false);

  const face = useStableFace(
    judgeFace({
      state,
      models: props.shownModels,
      providers: props.providers,
      hostRunsEffort: props.hostRunsEffort,
    }),
  );
  const openRef = useRef<(() => void) | null>(null);
  const { providerSwitchModel } = toolbar;
  const embedding = useMemo<HarnessModelPickerEmbedding>(
    () => ({
      trigger: <JudgeModelFace face={face} onExpandedChange={setPickerOpen} />,
      providerSwitchModel,
      selectionMarked,
      openRef,
    }),
    [face, providerSwitchModel, selectionMarked],
  );
  return {
    toolbar,
    face,
    embedding,
    open: () => {
      openRef.current?.();
    },
    noteOpenAtPointerDown: () => {
      openAtPointerDown.current = pickerOpen;
    },
    wasOpenAtPointerDown: () => {
      const openThen = openAtPointerDown.current;
      openAtPointerDown.current = false;
      return openThen;
    },
  };
}

/**
 * What the second tile's face shows in a tile state: the pick, or the last
 * pick dimmed - with its blocker when it cannot run - or "Choose a model".
 * The provider icon, the model's catalog label (else its slug), the effort
 * the host runs it at when the model advertises one and the host applies it
 * (the stored effort while the model still offers it, else its lowest -
 * `effectiveJudgeReasoningEffort`, the host's own rule), and the account when
 * that provider has more than one here.
 */
function judgeFace(input: {
  readonly state: JudgeTileState;
  readonly models: ReadonlyArray<GuiAgentModelOption> | undefined;
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
  readonly hostRunsEffort: boolean;
}): JudgeFace {
  const { state } = input;
  const dimmed = judgeFaceDimmed(state);
  const inert = judgeFaceInert(state);
  const { shown } = state;
  if (shown === null) {
    return {
      selection: null,
      label: "Choose a model",
      accentDot: null,
      dimmed,
      inert,
    };
  }
  const account = judgePickAccount(input.providers, shown);
  const blocker =
    state.lastCause === null ? null : judgeCauseShortLabel(state.lastCause);
  const effort =
    input.hostRunsEffort && input.models !== undefined
      ? (effectiveJudgeReasoningEffort(
          input.models,
          shown.model,
          shown.reasoningEffort,
        )?.label ?? null)
      : null;
  const label = [
    autoJudgeModelLabel(input.models, shown.model) ?? shown.model,
    effort,
    account === null ? null : profileDisplayLabel(account),
    blocker,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return {
    // A harness id this build does not know has no icon; its face is text.
    selection: judgeStoreSelection(shown),
    label,
    accentDot: account === null ? null : profileAccentDotInput(account),
    dimmed,
    inert,
  };
}

/**
 * The face, kept by identity while nothing on it changed, so the embedding
 * the memoized picker reads is stable across renders.
 */
function useStableFace(face: JudgeFace): JudgeFace {
  const [held, setHeld] = useState(face);
  // Plain data built by one function, so its serialization is its identity.
  if (JSON.stringify(held) === JSON.stringify(face)) return held;
  setHeld(face);
  return face;
}

/** Providers ▸ {provider}, where a provider that cannot judge is fixed. */
function useOpenJudgeProvider(): (row: GuiHarnessOption) => void {
  const { openSettings } = useSystemTabModalActions();
  return (row) => {
    useProvidersFocusStore.getState().setFocusHarnessId(row.id);
    openSettings({
      section: "providers",
      resetToGeneral: false,
      tab: null,
      draft: null,
      // Settings is already scoped to this machine.
      hostId: null,
    });
  };
}
