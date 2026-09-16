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
    />
  ));
}

export function OnboardingProviderDiscovery(props: {
  readonly state: ProviderCliState;
  readonly visible: boolean;
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
  return (
    <DiscoveryPopover
      providerId={state.providerId}
      skills={canListSkills ? skills : null}
      plugins={canListPlugins ? plugins : null}
    />
  );
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
  const readySkills = skills?.data?.skills.filter((skill) => !skill.conflict);
  const allPlugins = plugins?.data?.plugins;
  const enabledPlugins = allPlugins?.filter((plugin) => plugin.enabled);
  const pending = Boolean(skills?.isPending || plugins?.isPending);
  const failed = Boolean(skills?.isError || plugins?.isError);
  const summary = discoverySummary(readySkills, enabledPlugins, failed);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onPointerDown={() => setPointerMotion(true)}
          onKeyDown={() => setPointerMotion(false)}
          className="onboarding-discovery-trigger flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label={`Discoveries for ${providerName}`}
          aria-describedby={descriptionId}
        >
          <span id={descriptionId} className="tabular-nums">
            {summary}
          </span>
          {pending ? (
            <MutedAgentSpinner />
          ) : (
            <ChevronRight aria-hidden="true" className="ml-auto size-3.5" />
          )}
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
        className="onboarding-discovery-popover w-[min(20rem,var(--radix-popover-content-available-width))] max-h-[var(--radix-popover-content-available-height)] gap-0 overflow-hidden rounded-2xl p-0 ring-0"
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
          {failed ? (
            <div className="flex items-center justify-between gap-3 text-xs">
              <p className="text-muted-foreground">
                Some discoveries couldn’t be loaded.
              </p>
              <button
                type="button"
                className="shrink-0 rounded underline underline-offset-4 focus-visible:outline-2"
                onClick={() => {
                  if (skills?.isError) void skills.refetch();
                  if (plugins?.isError) void plugins.refetch();
                }}
              >
                Try again
              </button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function discoverySummary(
  skills: readonly ProviderSkill[] | undefined,
  plugins: readonly ProviderPlugin[] | undefined,
  failed: boolean,
): string {
  const counts = [
    skills === undefined
      ? null
      : `${skills.length} ${skills.length === 1 ? "skill" : "skills"}`,
    plugins === undefined
      ? null
      : `${plugins.length} ${plugins.length === 1 ? "plugin" : "plugins"} enabled`,
  ]
    .filter((label) => label !== null)
    .join(" · ");
  return counts || (failed ? "Discovery unavailable" : "Finding your setup…");
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
