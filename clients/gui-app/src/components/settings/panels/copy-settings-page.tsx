import { useState, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  type CopySettingsCategory,
  type CopySettingsCategoryPreview,
  type CopySettingsSource,
} from "@traycer/protocol/host/provider-profile-config-schemas";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { AccentDot } from "@/components/providers/accent-dot";
import { profileDisplayLabel } from "@/components/providers/provider-profile-model";
import { useCopySettingsSupported } from "@/hooks/providers/use-copy-settings-supported";
import type { HostRpcRegistry } from "@/lib/host";
import type { CopySettingsDraft } from "@/lib/query-keys/providers-query-keys";
import { useProvidersPreviewCopySettings } from "@/hooks/providers/use-providers-preview-copy-settings-query";
import { useProvidersApplyCopySettings } from "@/hooks/providers/use-providers-apply-copy-settings-mutation";
import { cn } from "@/lib/utils";

type CopySettingsStep = "select" | "review" | "results";

type ApplyOutcome =
  | { readonly kind: "copied" }
  | { readonly kind: "failed"; readonly reason: string };

const DEFAULT_ACCOUNT_RADIO_VALUE = "default-account";

interface CopySettingsCategoryConfig {
  readonly id: CopySettingsCategory;
  readonly label: string;
  readonly note: string | null;
}

// Plan §7's six whole categories (D13) - never entry-level, never a
// seventh. Order is the page's fixed presentation order everywhere a
// category list renders (select and review).
const COPY_SETTINGS_CATEGORIES: readonly CopySettingsCategoryConfig[] = [
  { id: "cliArgs", label: "CLI & arguments", note: null },
  { id: "env", label: "Environment", note: "includes secret values" },
  { id: "mcp", label: "MCP servers", note: "includes secret values" },
  { id: "skills", label: "Skills", note: null },
  { id: "plugins", label: "Plugins", note: null },
  {
    id: "endpoint",
    label: "Endpoint",
    note: "Base URL, credential kind and default model. The credential itself is never copied.",
  },
];

const CATEGORY_LABEL_BY_ID: ReadonlyMap<CopySettingsCategory, string> = new Map(
  COPY_SETTINGS_CATEGORIES.map((entry) => [entry.id, entry.label]),
);

function profileRowRadioValue(profile: ProviderProfile): string {
  return profile.kind === "ambient"
    ? DEFAULT_ACCOUNT_RADIO_VALUE
    : profile.profileId;
}

function radioValueToCommitId(value: string): string | null {
  return value === DEFAULT_ACCOUNT_RADIO_VALUE ? null : value;
}

function sourceFromCommitId(commitId: string | null): CopySettingsSource {
  return commitId === null
    ? { kind: "defaultAccount" }
    : { kind: "profile", profileId: commitId };
}

export interface CopySettingsPageProps {
  readonly state: ProviderCliState;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  /** The switcher's current selection (D25) - preselected as the source. */
  readonly initialSourceProfileId: string | null;
  /** Exits back to the tab rail. No confirmation before apply (D13: no
   *  secret opt-in, so there is nothing an exit would discard silently). */
  readonly onClose: () => void;
}

/**
 * D13's Copy settings flow: select → review → apply, rendered inside the
 * Providers panel body in place of the tab rail while open (D25's addressed
 * surface already carries host/provider/profile scope, so this is local
 * `useState` step machine, not a router route). Self-gates on
 * {@link useCopySettingsSupported} so an older host's manifest hides it even
 * if a stale caller still mounts it.
 */
export function CopySettingsPage(props: CopySettingsPageProps): ReactNode {
  const { state, client, hostId, initialSourceProfileId, onClose } = props;
  const supported = useCopySettingsSupported(hostId);
  const [step, setStep] = useState<CopySettingsStep>("select");
  const [sourceCommitId, setSourceCommitId] = useState<string | null>(
    initialSourceProfileId,
  );
  const [targetIds, setTargetIds] = useState<ReadonlySet<string>>(new Set());
  const [categories, setCategories] = useState<
    ReadonlySet<CopySettingsCategory>
  >(new Set(COPY_SETTINGS_CATEGORIES.map((entry) => entry.id)));
  const [draft, setDraft] = useState<CopySettingsDraft | null>(null);
  const [results, setResults] = useState<ReadonlyMap<string, ApplyOutcome>>(
    new Map(),
  );

  const applyMutation = useProvidersApplyCopySettings(client);

  if (!supported) return null;

  const managedProfiles = state.profiles.filter(
    (profile) => profile.kind !== "ambient",
  );
  const targetCandidates = managedProfiles.filter(
    (profile) => profile.profileId !== sourceCommitId,
  );
  const resolvedTargetIds = targetCandidates
    .map((profile) => profile.profileId)
    .filter((profileId) => targetIds.has(profileId));
  const canReview = resolvedTargetIds.length > 0 && categories.size > 0;

  const toggleTarget = (profileId: string, checked: boolean): void => {
    setTargetIds((current) => {
      const next = new Set(current);
      if (checked) next.add(profileId);
      else next.delete(profileId);
      return next;
    });
  };

  const toggleCategory = (
    category: CopySettingsCategory,
    checked: boolean,
  ): void => {
    setCategories((current) => {
      const next = new Set(current);
      if (checked) next.add(category);
      else next.delete(category);
      return next;
    });
  };

  const goToReview = (): void => {
    if (!canReview) return;
    setDraft({
      providerId: state.providerId,
      source: sourceFromCommitId(sourceCommitId),
      targets: resolvedTargetIds,
      categories: [...categories],
    });
    setStep("review");
  };

  const runApply = (targets: readonly string[]): void => {
    if (draft === null) return;
    applyMutation.mutate(
      { ...draft, targets: [...targets] },
      {
        onSuccess: (response) => {
          setResults((current) => {
            const next = new Map(current);
            for (const result of response.results) {
              next.set(
                result.profileId,
                result.outcome.kind === "copied"
                  ? { kind: "copied" }
                  : { kind: "failed", reason: result.outcome.reason },
              );
            }
            return next;
          });
          setStep("results");
        },
      },
    );
  };

  const failedTargetIds = [...results.entries()]
    .filter(([, outcome]) => outcome.kind === "failed")
    .map(([profileId]) => profileId);

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {step !== "select" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setStep(step === "results" ? "review" : "select")}
            >
              <ChevronLeft data-icon="inline-start" />
              Back
            </Button>
          ) : null}
          <span className="text-ui-sm font-medium text-foreground">
            Copy settings
          </span>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Exit
        </Button>
      </div>

      {step === "select" ? (
        <CopySettingsSelectStep
          allProfiles={state.profiles}
          sourceCommitId={sourceCommitId}
          onSourceChange={setSourceCommitId}
          targetCandidates={targetCandidates}
          targetIds={targetIds}
          onToggleTarget={toggleTarget}
          categories={categories}
          onToggleCategory={toggleCategory}
          canReview={canReview}
          onNext={goToReview}
        />
      ) : null}

      {step === "review" && draft !== null ? (
        <CopySettingsReviewStep
          client={client}
          draft={draft}
          applyPending={applyMutation.isPending}
          onApply={() => runApply(draft.targets)}
        />
      ) : null}

      {step === "results" ? (
        <CopySettingsResultsStep
          allProfiles={state.profiles}
          results={results}
          failedTargetIds={failedTargetIds}
          retryPending={applyMutation.isPending}
          onRetryFailed={() => runApply(failedTargetIds)}
        />
      ) : null}
    </div>
  );
}

function CopySettingsSelectStep(props: {
  readonly allProfiles: readonly ProviderProfile[];
  readonly sourceCommitId: string | null;
  readonly onSourceChange: (commitId: string | null) => void;
  readonly targetCandidates: readonly ProviderProfile[];
  readonly targetIds: ReadonlySet<string>;
  readonly onToggleTarget: (profileId: string, checked: boolean) => void;
  readonly categories: ReadonlySet<CopySettingsCategory>;
  readonly onToggleCategory: (
    category: CopySettingsCategory,
    checked: boolean,
  ) => void;
  readonly canReview: boolean;
  readonly onNext: () => void;
}): ReactNode {
  const {
    allProfiles,
    sourceCommitId,
    onSourceChange,
    targetCandidates,
    targetIds,
    onToggleTarget,
    categories,
    onToggleCategory,
    canReview,
    onNext,
  } = props;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <fieldset className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 p-3">
          <legend className="text-ui-xs font-medium tracking-wide text-muted-foreground uppercase">
            Copy from
          </legend>
          <RadioGroup
            value={
              sourceCommitId === null
                ? DEFAULT_ACCOUNT_RADIO_VALUE
                : sourceCommitId
            }
            onValueChange={(value) =>
              onSourceChange(radioValueToCommitId(value))
            }
            className="gap-1"
          >
            {allProfiles.map((profile) => {
              const value = profileRowRadioValue(profile);
              return (
                <Label
                  key={value}
                  className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 font-normal"
                >
                  <RadioGroupItem value={value} />
                  <AccentDot
                    profileId={profile.profileId}
                    accentColor={profile.accentColor}
                    label={null}
                    variant="inline"
                    size="default"
                    className={undefined}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {profileDisplayLabel(profile)}
                  </span>
                </Label>
              );
            })}
          </RadioGroup>
        </fieldset>

        <fieldset className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 p-3">
          <legend className="text-ui-xs font-medium tracking-wide text-muted-foreground uppercase">
            Copy to
          </legend>
          {targetCandidates.length === 0 ? (
            <p className="text-ui-xs text-muted-foreground">
              No other profiles to copy to.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {targetCandidates.map((profile) => (
                <Label
                  key={profile.profileId}
                  className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 font-normal"
                >
                  <Checkbox
                    checked={targetIds.has(profile.profileId)}
                    onCheckedChange={(checked) =>
                      onToggleTarget(profile.profileId, checked === true)
                    }
                  />
                  <AccentDot
                    profileId={profile.profileId}
                    accentColor={profile.accentColor}
                    label={null}
                    variant="inline"
                    size="default"
                    className={undefined}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {profileDisplayLabel(profile)}
                  </span>
                </Label>
              ))}
            </div>
          )}
        </fieldset>
      </div>

      <fieldset className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 p-3">
        <legend className="text-ui-xs font-medium tracking-wide text-muted-foreground uppercase">
          What to copy
        </legend>
        <div className="flex flex-col gap-2">
          {COPY_SETTINGS_CATEGORIES.map((category) => (
            <Label
              key={category.id}
              className="flex min-w-0 flex-col items-start gap-0.5 rounded-md px-1.5 py-1 font-normal"
            >
              <span className="flex items-center gap-2">
                <Checkbox
                  checked={categories.has(category.id)}
                  onCheckedChange={(checked) =>
                    onToggleCategory(category.id, checked === true)
                  }
                />
                {category.label}
              </span>
              {category.note !== null ? (
                <span className="pl-6 text-ui-xs text-muted-foreground">
                  {category.note}
                </span>
              ) : null}
            </Label>
          ))}
        </div>
      </fieldset>

      <div className="flex justify-end">
        <Button type="button" disabled={!canReview} onClick={onNext}>
          Review
        </Button>
      </div>
    </div>
  );
}

function CopySettingsReviewStep(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly draft: CopySettingsDraft;
  readonly applyPending: boolean;
  readonly onApply: () => void;
}): ReactNode {
  const { client, draft, applyPending, onApply } = props;
  const query = useProvidersPreviewCopySettings(client, draft);

  if (query.isError) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-ui-xs text-destructive">
        <span>Couldn&apos;t load the review.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (query.data === undefined) {
    return (
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
        Loading review…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {query.data.targets.map((target) => (
        <section
          key={target.profileId}
          className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
        >
          <span className="text-ui-sm font-medium text-foreground">
            {target.label}
          </span>
          {target.categories.map((category) => (
            <CopySettingsCategoryReview
              key={category.category}
              targetLabel={target.label}
              category={category}
            />
          ))}
        </section>
      ))}
      <div className="flex justify-end">
        <Button type="button" disabled={applyPending} onClick={onApply}>
          {applyPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Copy to {draft.targets.length}{" "}
          {draft.targets.length === 1 ? "profile" : "profiles"}
        </Button>
      </div>
    </div>
  );
}

function CopySettingsCategoryReview(props: {
  readonly targetLabel: string;
  readonly category: CopySettingsCategoryPreview;
}): ReactNode {
  const { targetLabel, category } = props;
  const label =
    CATEGORY_LABEL_BY_ID.get(category.category) ?? category.category;
  const hasChanges =
    category.adds.length > 0 ||
    category.changes.length > 0 ||
    category.removals.length > 0;
  // D13 scopes the "already Linked" line to the Linked→Linked case, which
  // only Skills and Plugins have. `noop` is truthful for every scalar
  // category too (an unchanged Environment, Endpoint, CLI & args or MCP), and
  // rendering the Linked wording there told the user those categories have a
  // Linked/Own axis they do not have. The generic "No changes" line below
  // covers them.
  const showLinkedNoop =
    category.noop &&
    (category.category === "skills" || category.category === "plugins");
  return (
    <div className="flex flex-col gap-1 border-t border-border/40 pt-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2 text-ui-xs">
        <span className="font-medium text-foreground">{label}</span>
        {category.carriesSecretValues ? (
          <span className="text-muted-foreground">includes secret values</span>
        ) : null}
      </div>
      {hasChanges ? (
        <span className="text-ui-xs text-muted-foreground">
          {category.adds.length} added · {category.changes.length} changed
        </span>
      ) : null}
      {category.removals.length > 0 ? (
        <ul className="flex flex-col gap-0.5 pl-4 text-ui-xs text-muted-foreground">
          {category.removals.map((name) => (
            <li key={name}>Removed: {name}</li>
          ))}
        </ul>
      ) : null}
      {category.ownershipFlip === "linkedToOwn" ? (
        <span className="text-ui-xs text-muted-foreground">
          {label}: Linked → Own for {targetLabel}
        </span>
      ) : null}
      {showLinkedNoop ? (
        <span className="text-ui-xs text-muted-foreground">
          {label}: already Linked — no change
        </span>
      ) : null}
      {!hasChanges && category.ownershipFlip === "none" && !showLinkedNoop ? (
        <span className="text-ui-xs text-muted-foreground">No changes</span>
      ) : null}
    </div>
  );
}

function CopySettingsResultsStep(props: {
  readonly allProfiles: readonly ProviderProfile[];
  readonly results: ReadonlyMap<string, ApplyOutcome>;
  readonly failedTargetIds: readonly string[];
  readonly retryPending: boolean;
  readonly onRetryFailed: () => void;
}): ReactNode {
  const { allProfiles, results, failedTargetIds, retryPending, onRetryFailed } =
    props;
  const labelFor = (profileId: string): string =>
    allProfiles.find((profile) => profile.profileId === profileId)?.label ??
    profileId;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        {[...results.entries()].map(([profileId, outcome]) => (
          <div
            key={profileId}
            className={cn(
              "flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-ui-sm",
              outcome.kind === "copied"
                ? "border-border/60"
                : "border-destructive/30 bg-destructive/10",
            )}
          >
            <span className="min-w-0 truncate">{labelFor(profileId)}</span>
            <span
              className={cn(
                "shrink-0 text-ui-xs",
                outcome.kind === "copied"
                  ? "text-muted-foreground"
                  : "text-destructive",
              )}
            >
              {outcome.kind === "copied"
                ? "Copied"
                : `Failed: ${outcome.reason}`}
            </span>
          </div>
        ))}
      </div>
      {failedTargetIds.length > 0 ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={retryPending}
            onClick={onRetryFailed}
          >
            {retryPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Retry failed
          </Button>
        </div>
      ) : null}
    </div>
  );
}
