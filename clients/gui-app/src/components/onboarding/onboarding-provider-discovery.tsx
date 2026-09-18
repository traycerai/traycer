import { useId, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type {
  ProviderPlugin,
  ProviderSkill,
} from "@traycer/protocol/host/provider-native-schemas";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useProvidersSkillsList } from "@/hooks/providers/use-providers-skills-list-query";
import { useProvidersPluginsList } from "@/hooks/providers/use-providers-plugins-list-query";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import type {
  SkillsListData,
  PluginsListData,
} from "@/hooks/providers/native-response-map";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";

type SkillsQuery = UseQueryResult<SkillsListData, HostRpcError>;
type PluginsQuery = UseQueryResult<PluginsListData, HostRpcError>;

export function OnboardingProviderPrefetch() {
  const providers = useProvidersList({ enabled: true, subscribed: true });
  return providers.data?.providers.map((state) => (
    <OnboardingProviderDiscovery
      key={state.providerId}
      state={state}
      visible={false}
      presentation="popover"
    />
  ));
}

/**
 * How the discoveries are offered.
 *
 * `popover` is the card board's trailing control: a summary that opens the full
 * list. `text` is the phone row's, where the summary joins the status on the
 * row's one secondary line and there is nothing to open - a 28pt chevron is
 * both under the touch floor and a second target inside a row that is already
 * one control (see `ProviderList`'s phone shape). The lists are not lost; they
 * are in Settings, where a phone can read them on a full-height surface.
 */
export type OnboardingDiscoveryPresentation = "popover" | "text";

export function OnboardingProviderDiscovery(props: {
  readonly state: ProviderCliState;
  readonly visible: boolean;
  readonly presentation: OnboardingDiscoveryPresentation;
}) {
  const { state } = props;
  const available =
    state.enabled || state.candidates.some((candidate) => candidate.available);
  const canListSkills =
    available &&
    (state.nativeCapabilities.skills?.actionScopes.list.includes("global") ??
      false);
  const canListPlugins =
    available &&
    (state.nativeCapabilities.plugins?.actionScopes.list.includes("global") ??
      false);
  // These are the Settings queries: mounting before the provider step warms
  // its existing host-scoped cache, without creating another fetch path.
  const skills = useProvidersSkillsList({
    providerId: state.providerId,
    scope: "global",
    workspaceRoot: null,
    enabled: canListSkills,
  });
  const plugins = useProvidersPluginsList({
    providerId: state.providerId,
    scope: "global",
    workspaceRoot: null,
    enabled: canListPlugins,
  });
  if (!props.visible || (!canListSkills && !canListPlugins)) return null;
  if (props.presentation === "text") {
    return (
      <DiscoveryCounts
        skills={canListSkills ? skills : null}
        plugins={canListPlugins ? plugins : null}
      />
    );
  }
  return (
    <DiscoveryPopover
      providerId={state.providerId}
      skills={canListSkills ? skills : null}
      plugins={canListPlugins ? plugins : null}
    />
  );
}

/**
 * The counts as plain text, appended to a phone row's status line.
 *
 * Silent while either list is in flight and silent when both settle empty: the
 * row's first job is its status, and " · 0 skills" is noise that pushes the
 * line towards an ellipsis for no information. The popover shape says
 * "Finding your setup…" instead because it IS the trailing control and has to
 * be pressable before it has an answer.
 */
function DiscoveryCounts(props: {
  readonly skills: SkillsQuery | null;
  readonly plugins: PluginsQuery | null;
}) {
  const { skills, plugins } = props;
  if (skills?.isPending === true || plugins?.isPending === true) return null;
  const summary = discoverySummary({
    skills: skills?.data?.skills.filter((skill) => !skill.conflict),
    plugins: plugins?.data?.plugins.filter((plugin) => plugin.enabled),
    compact: true,
  });
  if (summary === "") return null;
  return (
    <span data-testid="onboarding-provider-discovery-counts">
      {` · ${summary}`}
    </span>
  );
}

/**
 * Everything the popover shows, read off the two queries in one place.
 *
 * The lists it hands back are the ones each section renders: skills minus the
 * conflicted ones, and ALL plugins, because that section names its own enabled
 * count and still lists the disabled ones. Only the summary counts enabled.
 */
function discoveryViewModel(
  skills: SkillsQuery | null,
  plugins: PluginsQuery | null,
): {
  readonly readySkills: readonly ProviderSkill[] | undefined;
  readonly allPlugins: readonly ProviderPlugin[] | undefined;
  readonly pending: boolean;
  readonly summary: string;
} {
  const readySkills = skills?.data?.skills.filter((skill) => !skill.conflict);
  const allPlugins = plugins?.data?.plugins;
  const failed = Boolean(skills?.isError || plugins?.isError);
  return {
    readySkills,
    allPlugins,
    pending: Boolean(skills?.isPending || plugins?.isPending),
    summary:
      discoverySummary({
        skills: readySkills,
        plugins: allPlugins?.filter((plugin) => plugin.enabled),
        compact: false,
      }) || (failed ? "Discovery unavailable" : "Finding your setup…"),
  };
}

function DiscoveryPopover(props: {
  readonly providerId: ProviderCliState["providerId"];
  readonly skills: SkillsQuery | null;
  readonly plugins: PluginsQuery | null;
}) {
  const { providerId, skills, plugins } = props;
  const providerName = providerDisplayName(providerId);
  const [open, setOpen] = useState(false);
  const [pointerMotion, setPointerMotion] = useState(false);
  const insets = useSafeAreaCollisionPadding();
  const descriptionId = useId();
  const { readySkills, allPlugins, pending, summary } = discoveryViewModel(
    skills,
    plugins,
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onPointerDown={() => setPointerMotion(true)}
          onKeyDown={() => setPointerMotion(false)}
          className="onboarding-discovery-trigger -mx-1.5 flex min-h-7 items-center gap-2 rounded-md px-1.5 text-left text-ui-xs tabular-nums text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label={`Discoveries for ${providerName}`}
          aria-describedby={descriptionId}
        >
          {/* One trailing slot, never two. While either list is still in
              flight the summary would read a HALF answer ("1 skill", with the
              plugins query unresolved) and the spinner sat straight after it,
              which renders as a stray glyph tacked onto the count. Pending
              says so and nothing else; settled shows the counts and the
              chevron. */}
          <span
            id={descriptionId}
            className="min-w-0 flex-1 truncate tabular-nums"
          >
            {pending ? "Finding your setup…" : summary}
          </span>
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            {pending ? (
              <MutedAgentSpinner />
            ) : (
              <ChevronRight aria-hidden="true" className="size-3.5" />
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="center"
        sideOffset={10}
        hideWhenDetached
        collisionPadding={{
          top: Math.max(insets.top, 16),
          right: Math.max(insets.right, 16),
          bottom: Math.max(insets.bottom, 16),
          left: Math.max(insets.left, 16),
        }}
        data-motion={pointerMotion}
        data-visible={open}
        onKeyDownCapture={() => setPointerMotion(false)}
        layout="panel"
        className="onboarding-discovery-popover w-[min(20rem,var(--radix-popover-content-available-width))] max-h-[var(--radix-popover-content-available-height)] ring-0"
        aria-label={`${providerName} skills and plugins`}
      >
        <div className="flex shrink-0 items-center gap-2.5 px-4 pb-2 pt-3">
          <HarnessIcon
            harnessId={providerIdToGuiHarnessId(providerId)}
            className="size-5 shrink-0"
          />
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
            {providerName}
          </h3>
          <button
            type="button"
            aria-label="Close discoveries"
            onClick={() => setOpen(false)}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/6 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <X aria-hidden className="size-3.5" strokeWidth={1.5} />
          </button>
        </div>
        <div
          role="region"
          aria-label="Discovered skills and plugins"
          className="onboarding-discovery-list min-h-0 max-h-[min(40vh,18rem)] space-y-4 overflow-y-auto overscroll-contain px-4 pb-4 pt-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
        >
          {pending ? (
            <p
              role="status"
              className="flex items-center gap-2 text-muted-foreground"
            >
              <MutedAgentSpinner />
              Finding skills and plugins…
            </p>
          ) : null}
          <DiscoveredSkills skills={readySkills} />
          <DiscoveredPlugins plugins={allPlugins} />
          <DiscoveryRetryNotice skills={skills} plugins={plugins} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The popover's footer when a list failed, with a retry that refetches only
 * the list that actually failed.
 *
 * Its own component so the popover does not carry this branch and the two
 * error reads inside the handler; it renders nothing while both lists are fine.
 */
function DiscoveryRetryNotice(props: {
  readonly skills: SkillsQuery | null;
  readonly plugins: PluginsQuery | null;
}) {
  const { skills, plugins } = props;
  if (skills?.isError !== true && plugins?.isError !== true) return null;
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <p className="text-muted-foreground">
        Some discoveries couldn’t be loaded.
      </p>
      <button
        type="button"
        className="shrink-0 rounded underline underline-offset-4 focus-visible:outline-2"
        onClick={() => {
          if (skills?.isError === true) void skills.refetch();
          if (plugins?.isError === true) void plugins.refetch();
        }}
      >
        Try again
      </button>
    </div>
  );
}

/**
 * "24 skills · 1 plugin enabled", or "" when neither list has answered.
 *
 * `compact` drops the word "enabled" for the phone row, which has one line for
 * the whole provider and where the plugin count is the only number that could
 * have meant anything else - the switch beside it already carries the
 * provider's own on/off, so "enabled" reads as a second claim about that.
 * The empty-string fallback is the CALLER's to name: the popover trigger has to
 * say something because it is a control, and the row's text has the option of
 * saying nothing at all.
 */
function discoverySummary(input: {
  readonly skills: readonly ProviderSkill[] | undefined;
  readonly plugins: readonly ProviderPlugin[] | undefined;
  readonly compact: boolean;
}): string {
  const { skills, plugins, compact } = input;
  return [
    skills === undefined
      ? null
      : `${skills.length} ${skills.length === 1 ? "skill" : "skills"}`,
    plugins === undefined
      ? null
      : `${plugins.length} ${plugins.length === 1 ? "plugin" : "plugins"}${compact ? "" : " enabled"}`,
  ]
    .filter((label) => label !== null)
    .join(" · ");
}

function DiscoveredSkills(props: {
  readonly skills: readonly ProviderSkill[] | undefined;
}) {
  const { skills } = props;
  if (skills === undefined) return null;
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-medium tabular-nums text-muted-foreground">
        Skills · {skills.length}
      </h4>
      {skills.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {skills.map((skill) => (
            <li
              key={skill.path}
              className="max-w-full rounded-md bg-foreground/5 px-2 py-1 text-xs leading-5"
            >
              <p className="break-words">{skill.name}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function DiscoveredPlugins(props: {
  readonly plugins: readonly ProviderPlugin[] | undefined;
}) {
  const { plugins } = props;
  if (plugins === undefined) return null;
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-medium tabular-nums text-muted-foreground">
        Plugins · {plugins.filter((plugin) => plugin.enabled).length} enabled
      </h4>
      {plugins.length > 0 ? (
        <ul className="space-y-0.5">
          {plugins.map((plugin) => (
            <li
              key={plugin.id}
              className="flex items-center gap-2 py-1 leading-5"
            >
              <span className="min-w-0 flex-1 break-words">
                {plugin.displayName ?? plugin.name}
              </span>
              {!plugin.enabled ? (
                <span className="shrink-0 rounded-md bg-foreground/5 px-1.5 text-[0.6875rem] text-muted-foreground">
                  Disabled
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
