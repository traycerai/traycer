import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Play, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type {
  FallbackPolicy,
  FallbackRungKind,
  TierCandidatePreview,
  TierConflict,
  TierGroup,
  TierPreviewBlockedTuple,
} from "@traycer/protocol/host/fallback-policy";
import {
  guiHarnessIdSchema,
  type GuiHarnessId,
} from "@traycer/protocol/host/agent/shared";
import { isProfileEnabled } from "@traycer/protocol/host/provider-schemas";
import { useHostClient } from "@/lib/host";
import { cn } from "@/lib/utils";
import {
  providerCliIdForHarness,
  sortGuiHarnessesByProviderOrder,
} from "@/lib/provider-ordering";
import { resolveSeededProfileId } from "@/lib/composer/resolve-seeded-profile-id";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import {
  useGuiHarnessModelsWarmup,
  useGuiHarnessesQuery,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useFallbackPolicyTestTierGroupsQuery } from "@/hooks/providers/use-fallback-policy-preview-tier-groups-query";
import {
  selectGlobalLastRunSettings,
  useComposerRunSettingsStore,
} from "@/stores/composer/composer-run-settings-store";
import {
  selectLastProfileByHarness,
  useComposerHarnessMemoryStore,
} from "@/stores/composer/composer-harness-memory-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  PERMISSION_OPTIONS,
  composerOffersPermissionMode,
  normalizePermissionMode,
  type PermissionMode,
} from "@/components/home/data/landing-options";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import {
  TERMINAL_ACCOUNT_LABEL,
  buildFallbackProfileLabels,
} from "@/components/chat/fallback/fallback-identity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FallbackCatalogOptions } from "@/components/settings/panels/fallback/fallback-catalog-options";
import type { FallbackSettingsProfileLabel } from "@/components/settings/panels/fallback/fallback-profile-labels";
import { harnessLabel } from "@/components/settings/panels/fallback/fallback-harness-label";
import {
  anyProviderModelLabel,
  isAnyModelPattern,
  isModelPattern,
  joinWithAnd,
  tierDisplayName,
} from "@/components/settings/panels/fallback/fallback-model-patterns";
import { FallbackPatternGlyph } from "@/components/settings/panels/fallback/fallback-pattern-glyph";
import { registerSettingsEscapeConsumer } from "@/components/settings/settings-escape-consumers";
import {
  TEST_FAILURE_KINDS,
  TEST_FAILURE_KIND_LABELS,
  TEST_STEP_LABELS,
  blockedModelLabel,
  testNextSteps,
  testPreviewForTier,
  testRouting,
  testRows,
  testableTierNames,
  type TestFailureKind,
  type TestMatchLine,
  type TestNextSteps,
  type TestRouting,
  type TestRow,
  type TestRowAnswer,
  type TestSkip,
  type TestSkipTone,
  type TestTierClaim,
} from "@/components/settings/panels/fallback/fallback-test-model";

/**
 * "Test a model" in the Equivalent models header (wireframe 1): a disclosure
 * button for the inline panel below it, never a dialog - the tiers it tests
 * stay on screen beside the answer.
 *
 * `aria-expanded` is the open state and `aria-controls` names the panel only
 * while it exists, since a reference to an element that is not rendered is a
 * promise with nothing behind it.
 */
export function FallbackTestModelButton(props: {
  /** False draws nothing: the host does not read rows as patterns (`get` below 1.1). */
  readonly offered: boolean;
  readonly open: boolean;
  readonly panelId: string;
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
  readonly onToggle: () => void;
}): ReactNode {
  const { offered, open, panelId, buttonRef, onToggle } = props;
  if (!offered) return null;
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="outline"
      size="sm"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      onClick={onToggle}
      data-testid="fallback-test-model-button"
    >
      <Play aria-hidden />
      Test a model
    </Button>
  );
}

export interface FallbackTestModelPanelProps {
  /** The panel's element id, which the button's `aria-controls` names. */
  readonly id: string;
  /** The DRAFT policy: its tiers as edited, blank rows included, its default tier and its steps. */
  readonly policy: FallbackPolicy;
  readonly catalog: FallbackCatalogOptions;
  /** The editor's own `findTierConflicts` over the draft. */
  readonly conflicts: readonly TierConflict[];
  readonly labelFor: FallbackSettingsProfileLabel;
  /**
   * The negotiated `previewTierGroups` line is 1.1 or later, so the host can
   * run the walk for a blocked tuple (`useFallbackPolicyPatternLines().
   * blankPreviewRows`, which is exactly that bit). Never inferred from a
   * response: the 1.0 → 1.1 upgrade synthesises `matches`.
   */
  readonly simulates: boolean;
  /**
   * The editor's non-blocked preview, for the older-host fallback: what each
   * row of the routed tier matches first, with nothing simulated.
   */
  readonly unsimulatedPreview: readonly TierCandidatePreview[] | null;
  /** Escape or ✕: the parent closes the panel and returns focus to the button. */
  readonly onClose: () => void;
  /** The editor's go-to-row, for the conflict footer's "fix". */
  readonly onGoToRow: (tierIndex: number, candidateIndex: number) => void;
}

/**
 * The user's picks, each `null` until made. A pick is dropped, not kept, when
 * it stops being on offer (a harness switch, a catalog that changed), which is
 * what lets every control's value be DERIVED in render - a pick if it is still
 * valid, else the default - rather than synced into state by an effect.
 *
 * `profile` wraps its id because `null` is itself a choice (the Terminal
 * account) and must be distinguishable from "not picked".
 */
interface TestPicks {
  readonly harnessId: GuiHarnessId | null;
  readonly model: string | null;
  readonly profile: { readonly profileId: string | null } | null;
  readonly permissionMode: PermissionMode | null;
  readonly kind: TestFailureKind;
}

const NO_PICKS: TestPicks = {
  harnessId: null,
  model: null,
  profile: null,
  permissionMode: null,
  // Wireframe 4's example, and the one failure kind the walk treats
  // differently - the sibling rule - so it is the one worth seeing first.
  kind: "rate_limit",
};

/** The Account select's stand-in for the Terminal account's `null`. */
const TERMINAL_ACCOUNT_VALUE = "__terminal-account__";

const NO_ACCOUNTS: readonly TestAccountOption[] = [];

/**
 * A dry run of routing for one hypothetical blocked chat (spec §Wireframe 4).
 *
 * The pickers build the run tuple the walk needs - provider, model, account,
 * permission mode, failure kind; agent mode and fast mode are carried from
 * the user's defaults - and the verdict reads the DRAFT: the tier comes from
 * the protocol's router with the editor's cached catalog (the readable-catalog
 * answer), and each row's matches from the host running the live walk as if
 * that tuple had just failed. On a host whose `previewTierGroups` line is
 * below 1.1 the walk cannot be asked for, so the panel shows the tier verdict
 * and each row's first match from the editor's own preview, and says so.
 *
 * Keyboard: Escape anywhere in the panel closes it (unless a picker's own
 * list took the key first), as does ✕; the parent returns focus to the
 * button. The verdict region is `aria-live="polite"`, mounted with the panel
 * so a changed answer is announced.
 */
export function FallbackTestModelPanel(
  props: FallbackTestModelPanelProps,
): ReactNode {
  const {
    id,
    policy,
    catalog,
    conflicts,
    labelFor,
    simulates,
    unsimulatedPreview,
    onClose,
    onGoToRow,
  } = props;
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const [picks, setPicks] = useState<TestPicks>(NO_PICKS);
  // Escape closes the panel, by two routes because Settings has two
  // presentations. As a MODAL, Settings' dialog takes Escape on the document
  // in the capture phase and would close the whole modal before anything in
  // here saw the key, so while the keyboard is in the panel the overlay's
  // Escape seam closes the panel instead (`settings-escape-consumers.ts`). As
  // the Settings TAB there is no dialog, and a listener on the panel does it.
  // A key already handled is someone else's: the modal seam, which has closed
  // the panel itself, or a picker's list (portalled, so it rarely reaches
  // here at all, and Radix marks the Escape that dismisses it).
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    panel.addEventListener("keydown", closeOnEscape);
    const unregister = registerSettingsEscapeConsumer(() => {
      if (!panel.contains(document.activeElement)) return false;
      onClose();
      return true;
    });
    return () => {
      panel.removeEventListener("keydown", closeOnEscape);
      unregister();
    };
  }, [onClose]);
  const tuple = useBlockedTuple(policy.tierGroups, picks);
  const groups = policy.tierGroups;

  const routing =
    tuple.blocked === null
      ? null
      : testRouting({
          groups,
          defaultTierGroupId: policy.defaultTierGroupId,
          harnessId: tuple.blocked.harnessId,
          model: tuple.blocked.model,
          catalog: tuple.models,
          conflicts,
        });
  const nextSteps = testNextSteps(policy, picks.kind);
  const walks =
    routing !== null &&
    routing.kind !== "no-tier" &&
    nextSteps.kind === "after-tier";
  const namesTestable = testableTierNames(groups);
  // Asked only when there is a tier to walk: a model that routes nowhere, or a
  // failure whose steps skip the tier, is answered by the client alone, and a
  // walk for it would come back empty.
  const request =
    simulates && walks && namesTestable && tuple.blocked !== null
      ? {
          groups,
          defaultTierGroupId: policy.defaultTierGroupId,
          blocked: tuple.blocked,
        }
      : null;
  const query = useFallbackPolicyTestTierGroupsQuery(request);

  return (
    <section
      ref={panelRef}
      id={id}
      aria-labelledby={titleId}
      className="mt-3 flex w-full min-w-0 flex-col gap-3 rounded-lg border border-border/60 px-4 py-3"
      data-testid="fallback-test-model-panel"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id={titleId} className="text-ui-sm font-semibold">
          Test a model
        </h3>
        <Button
          type="button"
          variant="muted"
          size="icon-xs"
          aria-label="Close Test a model"
          onClick={onClose}
          data-testid="fallback-test-model-close"
        >
          <X aria-hidden />
        </Button>
      </div>
      <TestPickers
        tuple={tuple}
        kind={picks.kind}
        onPicks={(update) => {
          setPicks((previous) => update(previous));
        }}
      />
      {/* Mounted with the panel and never swapped out: only its CONTENT
          changes, which is what a polite live region needs to announce a new
          verdict (see `PreviewFooterStatus` in the editor). */}
      <div
        aria-live="polite"
        aria-busy={query.isFetching}
        className="flex min-w-0 flex-col gap-2.5 border-l-2 border-primary/60 pl-3.5"
        data-testid="fallback-test-model-verdict"
      >
        <TestVerdict
          tuple={tuple}
          routing={routing}
          nextSteps={nextSteps}
          kind={picks.kind}
          rows={{
            groups,
            catalog,
            labelFor,
            simulates,
            namesTestable,
            simulated: query.data?.candidates ?? null,
            unsimulated: unsimulatedPreview,
            // `request` stands for "a walk was asked for": without one there
            // is nothing pending and nothing to have failed.
            pending:
              request !== null && query.data === undefined && !query.isError,
            failed: request !== null && query.isError,
            onRetry: () => {
              void query.refetch();
            },
            onGoToRow,
          }}
        />
      </div>
    </section>
  );
}

/** One harness the Provider picker offers, with what the other pickers need from it. */
interface TestHarnessOption {
  readonly id: GuiHarnessId;
  readonly supportedPermissionModes: readonly PermissionMode[];
}

/** One account the Account picker offers; `profileId: null` is the Terminal account. */
interface TestAccountOption {
  readonly profileId: string | null;
  readonly label: string;
}

/** Everything the pickers show and the request sends, derived from the picks. */
interface BlockedTupleState {
  readonly harnesses: readonly TestHarnessOption[] | null;
  readonly harnessId: GuiHarnessId | null;
  /** The blocked harness's catalog, `null` while it has not answered. */
  readonly models:
    | readonly { readonly slug: string; readonly label: string }[]
    | null;
  /** The catalog read failed, so `models` is not merely still loading. */
  readonly modelsFailed: boolean;
  readonly model: string | null;
  readonly accounts: readonly TestAccountOption[];
  readonly profileId: string | null;
  readonly permissionModes: readonly PermissionMode[];
  readonly permissionMode: PermissionMode;
  /** The whole tuple, or `null` until a provider and a model are known. */
  readonly blocked: TierPreviewBlockedTuple | null;
  readonly kind: TestFailureKind;
}

/**
 * The run tuple the pickers describe: each control's pick while it is still on
 * offer, else its default.
 *
 * Defaults, all scoped to the panel's host (`useAddressableHostId`, which
 * beneath Settings is the scoped host):
 *  - provider and model: the model the user last started a chat with on this
 *    host, while its provider is available and its catalog lists the model;
 *    else the first available provider the draft's rows name, and that
 *    provider's first model;
 *  - account: that provider's last-used account, checked against its live
 *    accounts (`resolveSeededProfileId`, the fork dialog's rule);
 *  - permission mode: the user's default, clamped to what the provider
 *    honours; agent mode `regular` and the default service tier, as the
 *    new-conversation modal seeds them.
 */
function useBlockedTuple(
  groups: readonly TierGroup[],
  picks: TestPicks,
): BlockedTupleState {
  const hostId = useAddressableHostId();
  const harnesses = useTestHarnessOptions();
  const lastRun = useComposerRunSettingsStore((state) =>
    selectGlobalLastRunSettings(state, hostId),
  );
  const defaultPermission = useSettingsStore(
    (state) => state.defaultPermission,
  );
  const defaultServiceTier = useSettingsStore(
    (state) => state.defaultServiceTier,
  );
  const harness = pickHarness(harnesses, groups, picks, lastRun);
  const harnessId = harness === null ? null : harness.id;
  const catalog = useTestModelCatalog(harnessId);
  const model = pickModel(catalog.models, harnessId, picks, lastRun);
  const account = useTestAccount(hostId, harnessId, picks.profile);
  const permission = testPermission(
    harness,
    picks.permissionMode,
    defaultPermission,
  );
  const blocked: TierPreviewBlockedTuple | null =
    harnessId === null || model === null
      ? null
      : {
          harnessId,
          model,
          profileId: account.profileId,
          permissionMode: permission.permissionMode,
          agentMode: "regular",
          serviceTier:
            defaultServiceTier.trim() === "" ? null : defaultServiceTier,
          kind: picks.kind,
        };
  return {
    harnesses,
    harnessId,
    models: catalog.models,
    modelsFailed: catalog.failed,
    model,
    accounts: account.accounts,
    profileId: account.profileId,
    permissionModes: permission.permissionModes,
    permissionMode: permission.permissionMode,
    blocked,
    kind: picks.kind,
  };
}

/**
 * The Provider picker's options: the host's available, enabled GUI harnesses
 * in the app's provider order, or `null` until the host has listed them. An
 * unavailable harness has no catalog to test against, and the model read is
 * gated on availability like every other targeted one.
 */
function useTestHarnessOptions(): readonly TestHarnessOption[] | null {
  const harnessesQuery = useGuiHarnessesQuery({
    enabled: true,
    subscribed: true,
  });
  const available = harnessesQuery.data?.harnesses;
  return useMemo(() => {
    if (available === undefined) return null;
    return sortGuiHarnessesByProviderOrder(
      available.filter((harness) => harness.available && harness.enabled),
    ).map((harness) => ({
      id: harness.id,
      supportedPermissionModes: harness.supportedPermissionModes,
    }));
  }, [available]);
}

/**
 * The tested provider's catalog through the same `agent.gui.listModels` slot
 * the editor's cells read, cache-only, for exactly that one provider - which
 * may be one no row names.
 */
function useTestModelCatalog(harnessId: GuiHarnessId | null): {
  readonly models: BlockedTupleState["models"];
  readonly failed: boolean;
} {
  const client = useHostClient();
  const modelQueries = useGuiHarnessModelsWarmup(client, harnessId, {
    enabled: true,
    subscribed: true,
  });
  const modelQuery = modelQueries.at(0);
  if (modelQuery === undefined) return { models: null, failed: false };
  return {
    models: modelQuery.data === undefined ? null : modelQuery.data.models,
    failed: modelQuery.isError,
  };
}

/**
 * The Account picker's options and value. The options are the provider's
 * enabled accounts, named as the chat cards name them; the value is the pick
 * while it is still listed, else the provider's last-used account checked
 * against its live accounts (`resolveSeededProfileId`, the fork dialog's
 * rule). A harness with no provider CLI (Traycer) has no accounts and runs on
 * `null`.
 */
function useTestAccount(
  hostId: string | null,
  harnessId: GuiHarnessId | null,
  picked: TestPicks["profile"],
): {
  readonly accounts: readonly TestAccountOption[];
  readonly profileId: string | null;
} {
  const providers = useProvidersList({ enabled: true, subscribed: true });
  const lastProfiles = useComposerHarnessMemoryStore(
    useShallow((state) => selectLastProfileByHarness(state, hostId)),
  );
  const providerId =
    harnessId === null ? null : providerCliIdForHarness(harnessId);
  const providersData = providers.data;
  const profiles = useMemo(() => {
    if (providerId === null || providersData === undefined) return undefined;
    return providersData.providers
      .find((entry) => entry.providerId === providerId)
      ?.profiles.filter(isProfileEnabled);
  }, [providerId, providersData]);
  const accounts = useMemo<readonly TestAccountOption[]>(() => {
    if (profiles === undefined || providersData === undefined) {
      return NO_ACCOUNTS;
    }
    // The chat cards' own labels, duplicate-name disambiguation included, so
    // an account is named here the way every fallback surface names it.
    const labels = buildFallbackProfileLabels(providersData.providers);
    return profiles.map((profile) =>
      profile.kind === "ambient"
        ? { profileId: null, label: TERMINAL_ACCOUNT_LABEL }
        : {
            profileId: profile.profileId,
            label: labels.get(profile.profileId) ?? profile.label,
          },
    );
  }, [profiles, providersData]);
  if (harnessId === null || providerId === null) {
    return { accounts: NO_ACCOUNTS, profileId: null };
  }
  if (
    picked !== null &&
    accounts.some((account) => account.profileId === picked.profileId)
  ) {
    return { accounts, profileId: picked.profileId };
  }
  return {
    accounts,
    profileId: resolveSeededProfileId(
      lastProfiles[harnessId] ?? null,
      profiles,
      providersData !== undefined,
    ),
  };
}

/**
 * The Permission mode picker's options and value: the modes the provider
 * honours, and the pick while it is one of them, else the user's default
 * clamped to them (`normalizePermissionMode`, the composer's own clamp).
 *
 * `null` for the host's auto-mode line, both times: the tuple travels only on
 * `previewTierGroups`@1.1, which is younger than `auto`, and below that line
 * nothing is sent at all.
 */
function testPermission(
  harness: TestHarnessOption | null,
  picked: PermissionMode | null,
  defaultPermission: PermissionMode,
): {
  readonly permissionModes: readonly PermissionMode[];
  readonly permissionMode: PermissionMode;
} {
  const supported = harness === null ? null : harness.supportedPermissionModes;
  const permissionModes = PERMISSION_OPTIONS.flatMap((option) =>
    composerOffersPermissionMode(supported, option.id, null) ? [option.id] : [],
  );
  const permissionMode =
    picked !== null && permissionModes.includes(picked)
      ? picked
      : normalizePermissionMode(defaultPermission, supported, null);
  return { permissionModes, permissionMode };
}

function pickHarness(
  harnesses: readonly TestHarnessOption[] | null,
  groups: readonly TierGroup[],
  picks: TestPicks,
  lastRun: { readonly harnessId: GuiHarnessId } | null,
): TestHarnessOption | null {
  if (harnesses === null || harnesses.length === 0) return null;
  const find = (harnessId: string): TestHarnessOption | null =>
    harnesses.find((harness) => harness.id === harnessId) ?? null;
  if (picks.harnessId !== null) {
    const picked = find(picks.harnessId);
    if (picked !== null) return picked;
  }
  if (lastRun !== null) {
    const remembered = find(lastRun.harnessId);
    if (remembered !== null) return remembered;
  }
  for (const group of groups) {
    for (const candidate of group.candidates) {
      const named = find(candidate.harnessId);
      if (named !== null) return named;
    }
  }
  return harnesses[0];
}

function pickModel(
  models: readonly { readonly slug: string }[] | null,
  harnessId: GuiHarnessId | null,
  picks: TestPicks,
  lastRun: { readonly harnessId: GuiHarnessId; readonly model: string } | null,
): string | null {
  if (models === null || models.length === 0) return null;
  const listed = (slug: string): boolean =>
    models.some((model) => model.slug === slug);
  if (picks.model !== null && listed(picks.model)) return picks.model;
  if (
    lastRun !== null &&
    lastRun.harnessId === harnessId &&
    listed(lastRun.model)
  ) {
    return lastRun.model;
  }
  return models[0].slug;
}

/**
 * "If <provider> <model> is blocked by <failure> …", then the account and the
 * permission mode the hypothetical chat runs with. One sentence that wraps,
 * so it stacks at narrow width with no layout of its own.
 */
function TestPickers(props: {
  readonly tuple: BlockedTupleState;
  readonly kind: TestFailureKind;
  readonly onPicks: (update: (previous: TestPicks) => TestPicks) => void;
}): ReactNode {
  const { tuple, kind, onPicks } = props;
  const accountLabelId = useId();
  const permissionLabelId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-ui-sm">
        <span>If</span>
        {/* `""` rather than `undefined` for "nothing to show": Radix reads it
            as no value and draws the placeholder, and the Select stays
            controlled across the catalog landing. */}
        <Select
          value={tuple.harnessId ?? ""}
          disabled={tuple.harnesses === null || tuple.harnesses.length === 0}
          onValueChange={(next) => {
            const parsed = guiHarnessIdSchema.safeParse(next);
            if (!parsed.success) return;
            // The model, account and mode picks belong to the old provider's
            // catalog and accounts, so a new provider starts from its own
            // defaults.
            onPicks((previous) => ({
              ...previous,
              harnessId: parsed.data,
              model: null,
              profile: null,
              permissionMode: null,
            }));
          }}
        >
          <SelectTrigger
            className="max-w-full min-w-0"
            aria-label="Provider"
            data-testid="fallback-test-model-provider"
          >
            <SelectValue placeholder="No providers available" />
          </SelectTrigger>
          <SelectContent>
            {(tuple.harnesses ?? []).map((harness) => (
              <SelectItem key={harness.id} value={harness.id}>
                <HarnessIcon harnessId={harness.id} />
                {harnessLabel(harness.id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={tuple.model ?? ""}
          disabled={tuple.models === null || tuple.models.length === 0}
          onValueChange={(next) => {
            onPicks((previous) => ({ ...previous, model: next }));
          }}
        >
          <SelectTrigger
            className="max-w-full min-w-0"
            aria-label="Model"
            data-testid="fallback-test-model-model"
          >
            <SelectValue
              placeholder={
                tuple.harnessId !== null && tuple.models === null
                  ? "Loading models…"
                  : "No models to choose from"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {(tuple.models ?? []).map((model) => (
              <SelectItem key={model.slug} value={model.slug}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>is blocked by</span>
        <Select
          value={kind}
          onValueChange={(next) => {
            const chosen = TEST_FAILURE_KINDS.find((entry) => entry === next);
            if (chosen === undefined) return;
            onPicks((previous) => ({ ...previous, kind: chosen }));
          }}
        >
          <SelectTrigger
            className="max-w-full min-w-0"
            aria-label="Failure"
            data-testid="fallback-test-model-kind"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TEST_FAILURE_KINDS.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {TEST_FAILURE_KIND_LABELS[entry]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span aria-hidden>…</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-ui-xs text-muted-foreground">
        {/* Only a provider with accounts to choose between gets the control;
            one with none (Traycer) runs on no account and sends `null`. */}
        {tuple.accounts.length === 0 ? null : (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span id={accountLabelId}>Account</span>
            <Select
              value={tuple.profileId ?? TERMINAL_ACCOUNT_VALUE}
              onValueChange={(next) => {
                const profileId = next === TERMINAL_ACCOUNT_VALUE ? null : next;
                onPicks((previous) => ({
                  ...previous,
                  profile: { profileId },
                }));
              }}
            >
              <SelectTrigger
                size="sm"
                className="max-w-full min-w-0"
                aria-labelledby={accountLabelId}
                data-testid="fallback-test-model-account"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tuple.accounts.map((account) => (
                  <SelectItem
                    key={account.profileId ?? TERMINAL_ACCOUNT_VALUE}
                    value={account.profileId ?? TERMINAL_ACCOUNT_VALUE}
                  >
                    {account.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
        )}
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span id={permissionLabelId}>Permission mode</span>
          <Select
            value={tuple.permissionMode}
            onValueChange={(next) => {
              const chosen = tuple.permissionModes.find(
                (mode) => mode === next,
              );
              if (chosen === undefined) return;
              onPicks((previous) => ({ ...previous, permissionMode: chosen }));
            }}
          >
            <SelectTrigger
              size="sm"
              className="max-w-full min-w-0"
              aria-labelledby={permissionLabelId}
              data-testid="fallback-test-model-permission"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERMISSION_OPTIONS.filter((option) =>
                tuple.permissionModes.includes(option.id),
              ).map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </span>
      </div>
    </div>
  );
}

/** Why there is no tuple to test yet - the catalogs still loading, or nothing to pick. */
function incompleteTupleText(tuple: BlockedTupleState): string {
  if (tuple.harnesses === null) return "Loading providers…";
  if (tuple.harnessId === null) {
    return "No provider is available on this host to test.";
  }
  if (tuple.models === null) {
    return tuple.modelsFailed
      ? "Couldn't load this provider's models."
      : "Loading this provider's models…";
  }
  return "This provider lists no models to test.";
}

/**
 * The answer, or why there is none yet. The states that name no tier - a tuple
 * still loading, steps that never reach the equivalent-model step, a model
 * that routes nowhere - are one line each; a routed model gets the full
 * verdict ({@link RoutedVerdict}).
 */
function TestVerdict(props: {
  readonly tuple: BlockedTupleState;
  readonly routing: TestRouting | null;
  readonly nextSteps: TestNextSteps;
  readonly kind: TestFailureKind;
  readonly rows: RoutedRowsInput;
}): ReactNode {
  const { tuple, routing, nextSteps, kind, rows } = props;
  if (tuple.blocked === null || routing === null) {
    return (
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="fallback-test-model-incomplete"
      >
        {incompleteTupleText(tuple)}
      </p>
    );
  }
  const blocked = {
    harnessId: tuple.blocked.harnessId,
    label: blockedModelLabel(tuple.blocked.model, tuple.models),
  };
  const failure = kind === "rate_limit" ? "rate limits" : "this kind of error";
  if (nextSteps.kind === "fallback-off") {
    return (
      <p className="text-ui-sm" data-testid="fallback-test-model-steps-off">
        Your steps are turned off for {failure}, so Traycer doesn&apos;t try
        another model.
      </p>
    );
  }
  if (nextSteps.kind === "tier-off") {
    return (
      <p className="text-ui-sm" data-testid="fallback-test-model-steps-off">
        The equivalent-model step is off for {failure}, so Traycer goes straight
        to <StepChain steps={nextSteps.steps} />.
      </p>
    );
  }
  if (routing.kind === "no-tier") {
    return (
      <p
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm"
        data-testid="fallback-test-model-footer-no-tier"
      >
        <span className="text-muted-foreground">
          {routing.defaultTierGroupId === null
            ? "Not in any tier, default set to None:"
            : "Not in any tier, and the default tier doesn't exist:"}
        </span>
        <BlockedModel blocked={blocked} />
        <span className="text-muted-foreground">
          <span aria-hidden>→ </span>no equivalent-model step; goes straight to{" "}
          <b className="font-medium text-foreground">
            {TEST_STEP_LABELS[nextSteps.steps[0]]}
          </b>
        </span>
      </p>
    );
  }
  return (
    <RoutedVerdict
      routing={routing}
      steps={nextSteps.steps}
      blocked={blocked}
      rows={rows}
    />
  );
}

/** A routing that names a tier - the two kinds the full verdict draws. */
type RoutedTestRouting = Exclude<TestRouting, { readonly kind: "no-tier" }>;

/** The blocked model as the verdict names it. */
interface BlockedModelView {
  readonly harnessId: GuiHarnessId;
  readonly label: string;
}

/** What the full verdict needs to draw the routed tier's rows. */
interface RoutedRowsInput {
  readonly groups: readonly TierGroup[];
  readonly catalog: FallbackCatalogOptions;
  readonly labelFor: FallbackSettingsProfileLabel;
  readonly simulates: boolean;
  readonly namesTestable: boolean;
  /** The host's walk for the blocked tuple, or `null` until it answers. */
  readonly simulated: readonly TierCandidatePreview[] | null;
  /** The editor's non-blocked preview, for the older-host fallback. */
  readonly unsimulated: readonly TierCandidatePreview[] | null;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly onRetry: () => void;
  readonly onGoToRow: (tierIndex: number, candidateIndex: number) => void;
}

/**
 * The verdict in the order wireframe 4 draws it: which tier and why, every row
 * of that tier with each match in try order, what happens if none work, and
 * the footer for the two states the header alone would hide - a model in no
 * tier that went to the default, and a model in two.
 */
function RoutedVerdict(props: {
  readonly routing: RoutedTestRouting;
  readonly steps: readonly FallbackRungKind[];
  readonly blocked: BlockedModelView;
  readonly rows: RoutedRowsInput;
}): ReactNode {
  const { routing, steps, blocked, rows } = props;
  const { groups, simulates } = rows;
  const tierIndex = routing.tier.tierIndex;
  const tierName = tierDisplayName(routing.tier.tierId, tierIndex);
  const preview = testPreviewForTier(
    simulates ? rows.simulated : rows.unsimulated,
    groups,
    tierIndex,
  );
  const testRowsList = testRows({
    tier: groups[tierIndex],
    preview,
    simulated: simulates,
    catalog: rows.catalog,
    labelFor: rows.labelFor,
  });
  return (
    <>
      <VerdictHeader routing={routing} tierName={tierName} blocked={blocked} />
      {simulates ? null : (
        <p
          className="text-ui-xs text-muted-foreground"
          data-testid="fallback-test-model-unsimulated"
        >
          This host can&apos;t simulate the walk; showing what your tiers say.
        </p>
      )}
      {simulates && !rows.namesTestable ? (
        <p className="text-ui-xs text-muted-foreground">
          Give every tier its own name to see what each row would try.
        </p>
      ) : null}
      <TestRowsView
        rows={testRowsList}
        pending={rows.pending}
        failed={rows.failed}
        onRetry={rows.onRetry}
      />
      <p
        className="text-ui-xs text-muted-foreground"
        data-testid="fallback-test-model-then"
      >
        If none of these work: <StepChain steps={steps} /> (your fallback steps)
      </p>
      <VerdictFooter
        routing={routing}
        tierName={tierName}
        blocked={blocked}
        onGoToRow={rows.onGoToRow}
      />
    </>
  );
}

/** "Traycer uses the <tier> tier · <model> is in it through <pattern> (row n)". */
function VerdictHeader(props: {
  readonly routing: RoutedTestRouting;
  readonly tierName: string;
  readonly blocked: BlockedModelView;
}): ReactNode {
  const { routing, tierName, blocked } = props;
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm"
      data-testid="fallback-test-model-header"
    >
      <span>Traycer uses the</span>
      <TierPill name={tierName} />
      <span>tier</span>
      {routing.kind === "own-tier" ? (
        <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
          <span>· {blocked.label} is in it through</span>
          <RowValue value={routing.rowValue} harnessId={blocked.harnessId} />
          <span>(row {routing.candidateIndex + 1})</span>
        </span>
      ) : null}
    </p>
  );
}

/**
 * The default-tier footer for a model no row reaches, and the conflict footer
 * for a model two tiers claim; nothing for a model in exactly one tier.
 */
function VerdictFooter(props: {
  readonly routing: RoutedTestRouting;
  readonly tierName: string;
  readonly blocked: BlockedModelView;
  readonly onGoToRow: (tierIndex: number, candidateIndex: number) => void;
}): ReactNode {
  const { routing, tierName, blocked, onGoToRow } = props;
  if (routing.kind === "default-tier") {
    return (
      <p
        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border/60 px-3 py-2 text-ui-xs"
        data-testid="fallback-test-model-footer-default"
      >
        <span className="text-muted-foreground">Not in any tier:</span>
        <BlockedModel blocked={blocked} />
        <span className="text-muted-foreground">
          <span aria-hidden>→ </span>no row matches it{" "}
          <span aria-hidden>→ </span>goes to your default tier
        </span>
        <TierPill name={tierName} />
      </p>
    );
  }
  if (routing.conflict === null) return null;
  return (
    <ConflictFooter
      claims={routing.conflict}
      blocked={blocked}
      onGoToRow={onGoToRow}
    />
  );
}

function TestRowsView(props: {
  readonly rows: readonly TestRow[];
  readonly pending: boolean;
  readonly failed: boolean;
  readonly onRetry: () => void;
}): ReactNode {
  const { rows, pending, failed, onRetry } = props;
  if (rows.length === 0) {
    return (
      <p className="text-ui-xs text-muted-foreground">
        This tier has no rows yet, so there is nothing to switch to.
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col">
      {pending ? (
        <p className="flex items-center gap-2 pb-1 text-ui-xs text-muted-foreground">
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant="orbit"
          />
          Checking what Traycer would try…
        </p>
      ) : null}
      {failed ? (
        <p
          className="flex flex-wrap items-center gap-2 pb-1 text-ui-xs text-muted-foreground"
          data-testid="fallback-test-model-failed"
        >
          Couldn&apos;t run the test.
          <Button
            size="inline-xs"
            type="button"
            variant="link"
            onClick={onRetry}
          >
            Try again
          </Button>
        </p>
      ) : null}
      <ol className="flex min-w-0 flex-col" aria-label="Rows in try order">
        {rows.map((row) => (
          <TestRowView key={row.candidateIndex} row={row} />
        ))}
      </ol>
    </div>
  );
}

function TestRowView(props: { readonly row: TestRow }): ReactNode {
  const { row } = props;
  const answer = row.answer;
  return (
    <li
      className="flex min-w-0 flex-col border-t border-dashed border-border/60 py-1.5"
      data-testid="fallback-test-model-row"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-ui-xs text-muted-foreground">
        <span
          aria-hidden
          className="grid size-5.5 shrink-0 place-items-center rounded-md bg-foreground/5 font-semibold tabular-nums"
        >
          {row.candidateIndex + 1}
        </span>
        <span className="sr-only">Row {row.candidateIndex + 1}: </span>
        {row.value === "" ? (
          <span>blank row</span>
        ) : (
          <RowValue value={row.value} harnessId={row.harnessId} />
        )}
        <span>· {row.effortLabel}</span>
        {row.account === null ? null : <span>· {row.account}</span>}
      </div>
      <TestRowAnswerView answer={answer} harnessId={row.harnessId} />
    </li>
  );
}

/** What a row would try: nothing said (unanswered), one skip, or each match. */
function TestRowAnswerView(props: {
  readonly answer: TestRowAnswer;
  readonly harnessId: string;
}): ReactNode {
  const { answer, harnessId } = props;
  if (answer.kind === "unanswered") return null;
  if (answer.kind === "skipped") {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2 py-1 pl-7.5">
        <SkipPill skip={answer.skip} />
      </div>
    );
  }
  return (
    <>
      {answer.lines.map((line) => (
        <TestMatchLineView key={line.model} line={line} harnessId={harnessId} />
      ))}
      {answer.more === 0 ? null : (
        <span className="py-1 pl-7.5 text-ui-xs text-muted-foreground">
          {answer.more} more
        </span>
      )}
    </>
  );
}

function TestMatchLineView(props: {
  readonly line: TestMatchLine;
  readonly harnessId: string;
}): ReactNode {
  const { line, harnessId } = props;
  return (
    <div
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 py-1 pl-7.5 text-ui-sm"
      data-testid="fallback-test-model-match"
      data-status={line.status}
    >
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5",
          line.status === "switches" && "font-semibold",
          line.status === "skipped" && "text-muted-foreground",
        )}
      >
        <ProviderMark harnessId={harnessId} />
        <span className="truncate">{line.label}</span>
      </span>
      <MatchPill line={line} />
    </div>
  );
}

function MatchPill(props: { readonly line: TestMatchLine }): ReactNode {
  const { line } = props;
  if (line.skip !== null) return <SkipPill skip={line.skip} />;
  if (line.status === "switches") {
    return (
      <Badge variant="success" className="rounded-full">
        switches here
      </Badge>
    );
  }
  if (line.status === "then") {
    return (
      <Badge variant="muted" className="rounded-full">
        then
      </Badge>
    );
  }
  return null;
}

/** Each skip tone's Badge: the quiet tag for neutral, the status roles otherwise. */
const SKIP_PILL_VARIANT: Readonly<
  Record<TestSkipTone, "muted" | "warning" | "destructive">
> = {
  neutral: "muted",
  warning: "warning",
  destructive: "destructive",
};

/**
 * A skip's pill. Colour never carries meaning alone: every pill carries its
 * reason as words, and the tone only sorts them - neutral for the walk working
 * as designed, amber for the world, red for a row the user has to fix.
 */
function SkipPill(props: { readonly skip: TestSkip }): ReactNode {
  const { skip } = props;
  return (
    <Badge
      variant={SKIP_PILL_VARIANT[skip.tone]}
      className="rounded-full"
      data-testid="fallback-test-model-skip"
      data-tone={skip.tone}
    >
      {skip.text}
    </Badge>
  );
}

/**
 * "In two tiers: GPT-5.6-Terra → matched in frontier and standard → frontier
 * handles it until you fix the conflict [fix]". Red because it is the user's
 * to fix; the pill puts the keyboard on the handling tier's row - the row the
 * header names, whose conflict block offers both ways out.
 */
function ConflictFooter(props: {
  readonly claims: readonly TestTierClaim[];
  readonly blocked: BlockedModelView;
  readonly onGoToRow: (tierIndex: number, candidateIndex: number) => void;
}): ReactNode {
  const { claims, blocked, onGoToRow } = props;
  const handler = claims[0];
  const handlerName = tierDisplayName(handler.tierId, handler.tierIndex);
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-destructive/30 px-3 py-2 text-ui-xs"
      data-testid="fallback-test-model-footer-conflict"
    >
      <span className="text-muted-foreground">In two tiers:</span>
      <BlockedModel blocked={blocked} />
      <span className="text-muted-foreground">
        <span aria-hidden>→ </span>matched in{" "}
        {joinWithAnd(
          claims.map((claim) => tierDisplayName(claim.tierId, claim.tierIndex)),
        )}{" "}
        <span aria-hidden>→</span>
      </span>
      <TierPill name={handlerName} />
      <span className="text-muted-foreground">
        handles it until you fix the conflict
      </span>
      <Button
        type="button"
        variant="destructive"
        size="xs"
        className="rounded-full"
        aria-label={`Fix: go to the ${handlerName} row`}
        onClick={() => {
          onGoToRow(handler.tierIndex, handler.candidateIndex);
        }}
        data-testid="fallback-test-model-fix"
      >
        fix
      </Button>
    </p>
  );
}

function StepChain(props: {
  readonly steps: readonly FallbackRungKind[];
}): ReactNode {
  return (
    <>
      {props.steps.map((step, at) => (
        <span key={step}>
          {at === 0 ? null : <span aria-hidden> → </span>}
          {at === 0 ? null : <span className="sr-only">, then </span>}
          <b className="font-medium text-foreground">
            {TEST_STEP_LABELS[step]}
          </b>
        </span>
      ))}
    </>
  );
}

/** The tier name in the accent the editor's pattern glyph wears (`primary`). */
function TierPill(props: { readonly name: string }): ReactNode {
  return (
    <span
      className="inline-flex h-5 items-center rounded-full bg-primary/15 px-2 text-ui-xs font-medium text-primary"
      data-testid="fallback-test-model-tier"
    >
      {props.name}
    </span>
  );
}

/**
 * A row's value the way the editor's Model cell draws it: the `*` badge for a
 * pattern, mono either way - except a bare `*`, which the cell names in words
 * ("Any Codex model", `anyProviderModelLabel`), since the lone star says
 * nothing on its own.
 */
function RowValue(props: {
  readonly value: string;
  readonly harnessId: string;
}): ReactNode {
  const { value, harnessId } = props;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {isModelPattern(value) ? <FallbackPatternGlyph tone="accent" /> : null}
      {isAnyModelPattern(value) ? (
        <span className="truncate text-foreground">
          {anyProviderModelLabel(harnessLabel(harnessId))}
        </span>
      ) : (
        <code className="truncate font-mono text-ui-xs text-foreground">
          {value}
        </code>
      )}
    </span>
  );
}

function BlockedModel(props: {
  readonly blocked: BlockedModelView;
}): ReactNode {
  const { blocked } = props;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <HarnessIcon harnessId={blocked.harnessId} />
      <span className="sr-only">{harnessLabel(blocked.harnessId)} </span>
      <span className="truncate font-medium">{blocked.label}</span>
    </span>
  );
}

/** The row's provider, as an icon with its name for assistive technology. */
function ProviderMark(props: { readonly harnessId: string }): ReactNode {
  const parsed = guiHarnessIdSchema.safeParse(props.harnessId);
  return (
    <>
      {parsed.success ? <HarnessIcon harnessId={parsed.data} /> : null}
      <span className="sr-only">{harnessLabel(props.harnessId)}: </span>
    </>
  );
}
