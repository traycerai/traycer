import {
  LayoutUsageContext,
  EMPTY_USAGE,
  useLayoutUsage,
} from "@/components/layout-editor/inspector/use-layout-usage";
import { use, type ReactNode } from "react";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { HostRuntimeContext, useHostBinding } from "@/lib/host";
import { isWindowedRateLimitProvider } from "@/lib/rate-limits/rate-limit-window-catalog";
import { useWatchHostScope } from "@/hooks/host-scope/use-watch-host-scope";
import { useRateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import {
  useStatusBarRateLimitSegments,
  useStatusBarWindowedProviders,
  type StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

export interface ProviderLimitWindows {
  readonly windows: ReadonlyArray<StatusBarRateLimitWindow>;
  readonly drawnKeys: ReadonlyArray<string>;
}

const NO_WINDOWS: ProviderLimitWindows = { windows: [], drawnKeys: [] };

/** One passive read for a whole editor: lists, examples and provider picks share it. */
export function LayoutUsageProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const { scope, hasExplicitPick } = useWatchHostScope();
  const scopedBinding = useScopedHostBinding(scope);
  const ambientBinding = useHostBinding();
  const hostName = scope.host?.name ?? "the watched host";
  return (
    <HostRuntimeContext.Provider value={scopedBinding ?? ambientBinding}>
      {hasExplicitPick && !isHostScopeUsable(scope.status) ? (
        <LayoutUsageContext value={{ ...EMPTY_USAGE, hostName }}>
          {props.children}
        </LayoutUsageContext>
      ) : (
        <ReadLayoutUsage hostId={scope.hostId} hostName={hostName}>
          {props.children}
        </ReadLayoutUsage>
      )}
    </HostRuntimeContext.Provider>
  );
}

function ReadLayoutUsage(props: {
  readonly hostId: string | null;
  readonly hostName: string;
  readonly children: ReactNode;
}): ReactNode {
  const providers = useStatusBarWindowedProviders();
  const profileSelection = useRateLimitProfileSelection(props.hostId);
  const { cluster } = useStatusBarRateLimitSegments({
    providers,
    profileSelection,
    mode: "passive",
    editing: true,
    // The Choose picker lists what the provider really reports.
    sample: false,
  });
  return (
    <LayoutUsageContext
      value={{
        providerIds: providers.map((provider) => provider.providerId),
        cluster,
        hostName: props.hostName,
      }}
    >
      {props.children}
    </LayoutUsageContext>
  );
}

interface ProviderLimitWindowsReaderProps {
  readonly providerId: RateLimitProviderId;
  readonly children: (limits: ProviderLimitWindows) => ReactNode;
}

/** Standalone provider controls resolve a scope; controls in an editor reuse its read. */
export function ProviderLimitWindowsReader(
  props: ProviderLimitWindowsReaderProps,
): ReactNode {
  const usage = use(LayoutUsageContext);
  if (!isWindowedRateLimitProvider(props.providerId))
    return props.children(NO_WINDOWS);
  if (usage === null) {
    return (
      <LayoutUsageProvider>
        <ProviderLimitWindowsReader {...props} />
      </LayoutUsageProvider>
    );
  }
  if (usage.cluster.kind !== "segments") return props.children(NO_WINDOWS);
  const windows = new Map<string, StatusBarRateLimitWindow>();
  const drawn = new Set<string>();
  for (const segment of usage.cluster.segments) {
    if (segment.providerId !== props.providerId) continue;
    for (const window of segment.windows) {
      if (!windows.has(window.windowKey)) windows.set(window.windowKey, window);
    }
    for (const window of segment.shown) drawn.add(window.windowKey);
  }
  return props.children({
    windows: [...windows.values()],
    drawnKeys: [...drawn],
  });
}

export function NoLayoutUsageProviders(): ReactNode {
  const { hostName } = useLayoutUsage();
  return (
    <p className="text-ui-xs text-muted-foreground">
      No providers on {hostName} report usage limits.
    </p>
  );
}
