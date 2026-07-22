import {
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { Button } from "@/components/ui/button";
import {
  HostReadinessControllerContext,
  isHostDialable,
  projectDefaultHostReadiness,
  resolveSurfaceReadiness,
  useHostReadinessController,
  useSurfaceReadiness,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type HostReadinessScope,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import {
  HostProvisioningController,
  type HostProvisioningLifecycle,
} from "@/components/local-host-gate";
import { LocalHostLoadingContent } from "@/components/local-host-loading";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { describeHostCompatibilityError, useHostBinding } from "@/lib/host";
import {
  useHostCompatibility,
  type HostCompatibility,
} from "@/lib/host/compatibility-state";
import { useRunnerRequestHostRespawn } from "@/hooks/runner/use-runner-request-host-respawn-mutation";
import { useRunnerHost } from "@/providers/use-runner-host";
import { requestAppQuit } from "@/lib/desktop-app-lifecycle";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { useAuthStore } from "@/stores/auth/auth-store";

/** A single signed-in owner for host reachability and lifecycle state. */
export function HostReadinessControllerProvider(props: {
  readonly onConfigureShell: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const runnerHost = useRunnerHost();
  const authStatus = useAuthStore((state) => state.status);
  // The single readiness owner also owns the slow-host respawn mutation, so all
  // default-host slots share one request/pending lock (see the presentation's
  // requestRespawn/respawnPending).
  const respawn = useRunnerRequestHostRespawn();
  const client = binding?.hostClient ?? null;
  const readiness = useReactiveHostReadiness(client);
  const directoryEntries = useHostDirectoryEntries(
    binding === null ? null : binding.directory,
  );
  const activeEntry = directoryEntries.find(
    (entry) => entry.hostId === readiness.hostId,
  );
  const defaultHostDialable = isHostDialable(activeEntry);
  const selectedEntry =
    binding === null ? null : binding.hostClient.getActiveHost();
  const targetEntry = selectedEntry ?? activeEntry;
  const localTarget = targetEntry?.kind !== "remote";
  const compatibility = useHostCompatibility();
  const canProvision =
    authStatus === "signed-in" && runnerHost.hasLocalHost && localTarget;

  return (
    <HostProvisioningController
      enabled={canProvision}
      isReady={defaultHostDialable}
    >
      {(lifecycle) => (
        <HostReadinessControllerContents
          authStatus={authStatus}
          activeHostId={readiness.hostId}
          requestContextUserId={readiness.requestContextUserId}
          directoryEntries={directoryEntries}
          hasLocalHost={runnerHost.hasLocalHost}
          hasMobileNoHost={
            binding !== null && binding.directory.getCardinality() === "zero"
          }
          lifecycle={lifecycle}
          compatibility={compatibility}
          localTarget={localTarget}
          onConfigureShell={props.onConfigureShell}
          onRequestRespawn={respawn.mutate}
          respawnPending={respawn.isPending}
        >
          {props.children}
        </HostReadinessControllerContents>
      )}
    </HostProvisioningController>
  );
}

function HostReadinessControllerContents(props: {
  readonly authStatus: string;
  readonly activeHostId: string | null;
  readonly requestContextUserId: string | null;
  readonly directoryEntries: ReadonlyArray<HostDirectoryEntry>;
  readonly hasLocalHost: boolean;
  readonly hasMobileNoHost: boolean;
  readonly lifecycle: HostProvisioningLifecycle;
  readonly compatibility: HostCompatibility;
  readonly localTarget: boolean;
  readonly onConfigureShell: () => void;
  readonly onRequestRespawn: () => void;
  readonly respawnPending: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const defaultHostPresentation = useMemo(
    () =>
      presentationFromLifecycle({
        lifecycle: props.lifecycle,
        compatibility: props.compatibility,
        localTarget: props.localTarget,
        configureShell: props.onConfigureShell,
        requestRespawn: props.onRequestRespawn,
        respawnPending: props.respawnPending,
      }),
    [
      props.compatibility,
      props.lifecycle,
      props.localTarget,
      props.onConfigureShell,
      props.onRequestRespawn,
      props.respawnPending,
    ],
  );
  const controller = useMemo<HostReadinessController>(() => {
    return {
      readinessFor: (scope, tabHostId) => {
        const readiness = resolveSurfaceReadiness({
          scope,
          tabHostId,
          authStatus: props.authStatus,
          activeHostId: props.activeHostId,
          requestContextUserId: props.requestContextUserId,
          directoryEntries: props.directoryEntries,
          hasLocalHost: props.hasLocalHost,
          hasMobileNoHost: props.hasMobileNoHost,
        });
        return scope === "default-host"
          ? projectDefaultHostReadiness({
              readiness,
              presentation: defaultHostPresentation,
            })
          : readiness;
      },
      defaultHostPresentation,
    };
  }, [defaultHostPresentation, props]);

  return (
    <HostReadinessControllerContext.Provider value={controller}>
      {props.children}
    </HostReadinessControllerContext.Provider>
  );
}

function presentationFromLifecycle(args: {
  readonly lifecycle: HostProvisioningLifecycle;
  readonly compatibility: HostCompatibility;
  readonly localTarget: boolean;
  readonly configureShell: () => void;
  readonly requestRespawn: () => void;
  readonly respawnPending: boolean;
}): DefaultHostReadinessPresentation {
  return {
    localTarget: args.localTarget,
    localHostState: args.lifecycle.localHostState,
    stage: args.lifecycle.slowStartStage,
    progress: args.lifecycle.provisioning.progress,
    provisioningError: args.lifecycle.provisioning.error,
    provisioning: args.lifecycle.provisioning.isProvisioning,
    removed: args.lifecycle.provisioning.removed,
    hostBusy: args.lifecycle.provisioning.hostBusy,
    canManageHost:
      args.localTarget && args.lifecycle.provisioning.canManageHost,
    retryProvisioning: args.lifecycle.provisioning.retry,
    forceProvisioning: args.lifecycle.provisioning.force,
    reinstall: args.lifecycle.provisioning.reinstall,
    configureShell: args.configureShell,
    requestRespawn: args.requestRespawn,
    respawnPending: args.respawnPending,
    compatibility: compatibilityPresentation(args.compatibility),
  };
}

function compatibilityPresentation(
  compatibility: HostCompatibility,
): DefaultHostReadinessPresentation["compatibility"] {
  if ("error" in compatibility && compatibility.status === "failed") {
    return {
      status: "failed",
      errorMessage: compatibility.error.message,
      retrying: compatibility.retrying,
      retry: compatibility.retry,
    };
  }
  if ("error" in compatibility) {
    return {
      status: "incompatible",
      errorMessage: describeHostCompatibilityError(compatibility.error),
      retrying: false,
      retry: compatibility.retry,
    };
  }
  if (compatibility.status === "checking") {
    return {
      status: "checking",
      errorMessage: null,
      retrying: false,
      retry: compatibility.retry,
    };
  }
  return {
    status: "compatible",
    errorMessage: null,
    retrying: false,
    retry: compatibility.retry,
  };
}

export function SurfaceReadinessBoundary(props: {
  readonly scope: HostReadinessScope;
  readonly tabHostId: string | null;
  readonly children: ReactNode;
}): ReactNode {
  const readiness = useSurfaceReadiness(props.scope, props.tabHostId);
  if (readiness.kind === "ready") return props.children;
  return <SurfaceReadinessFallback readiness={readiness} scope={props.scope} />;
}

export function HostScopeReady(props: {
  readonly scope: Exclude<HostReadinessScope, "none">;
  readonly children: ReactNode;
}): ReactNode {
  const readiness = useSurfaceReadiness(props.scope, null);
  return readiness.kind === "ready" ? props.children : null;
}

function SurfaceReadinessFallback(props: {
  readonly readiness: Exclude<SurfaceReadiness, { readonly kind: "ready" }>;
  readonly scope: HostReadinessScope;
}): ReactNode {
  const controller = useHostReadinessController();
  const presentation = controller.defaultHostPresentation;
  if (
    props.readiness.kind === "unavailable-host" &&
    props.scope === "default-host" &&
    presentation.localTarget &&
    presentation.localHostState === "unavailable" &&
    presentation.stage === "slow"
  ) {
    return <SlowHostFallback presentation={presentation} />;
  }
  return (
    <FallbackFrame
      fallback={fallbackContent(props.readiness, presentation)}
      testId={`surface-readiness-${props.readiness.kind}`}
      messageTestId={
        props.readiness.kind === "mobile-no-host" ? "mobile-no-host" : null
      }
    />
  );
}

function SlowHostFallback(props: {
  readonly presentation: DefaultHostReadinessPresentation;
}): ReactNode {
  // Respawn is owned once by the readiness controller, so two default-host slots
  // share one pending lock and a click issues exactly one request.
  return (
    <FallbackFrame
      fallback={{
        message: null,
        detail: null,
        body: (
          <LocalHostLoadingContent
            stage="slow"
            progress={props.presentation.progress}
            onConfigureShell={props.presentation.configureShell}
            onRetry={props.presentation.requestRespawn}
            retryPending={props.presentation.respawnPending}
          />
        ),
        footer: null,
        actions: [],
      }}
      testId="surface-readiness-unavailable-host"
      messageTestId={null}
    />
  );
}

function FallbackFrame(props: {
  readonly fallback: ReadinessFallback;
  readonly testId: string;
  readonly messageTestId: string | null;
}): ReactNode {
  const hasActionsRow =
    props.fallback.actions.length > 0 || props.fallback.footer !== null;
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background p-6 text-foreground"
      data-testid={props.testId}
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center text-ui-sm">
        {props.fallback.message === null ? null : (
          <p
            data-testid={props.messageTestId}
            className="text-muted-foreground"
          >
            {props.fallback.message}
          </p>
        )}
        {props.fallback.detail === null ? null : (
          <p className="text-ui-xs text-muted-foreground">
            {props.fallback.detail}
          </p>
        )}
        {props.fallback.body}
        {hasActionsRow ? (
          <div className="flex flex-wrap justify-center gap-2">
            {props.fallback.actions.map((action) => (
              <Button
                key={action.testId}
                type="button"
                size="sm"
                variant={action.variant}
                disabled={action.disabled}
                onClick={action.onClick}
                data-testid={action.testId}
              >
                {action.label}
              </Button>
            ))}
            {props.fallback.footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface ReadinessFallbackAction {
  readonly label: string;
  readonly testId: string;
  readonly variant: "default" | "destructive" | "outline";
  readonly disabled: boolean;
  readonly onClick: () => void;
}

interface ReadinessFallback {
  readonly message: string | null;
  readonly detail: string | null;
  /** Rich slot content rendered between the message/detail text and the actions row. */
  readonly body: ReactNode | null;
  /** Rich content rendered alongside the action buttons, in the same row. */
  readonly footer: ReactNode | null;
  readonly actions: ReadonlyArray<ReadinessFallbackAction>;
}

function fallbackContent(
  readiness: Exclude<SurfaceReadiness, { readonly kind: "ready" }>,
  presentation: DefaultHostReadinessPresentation,
): ReadinessFallback {
  switch (readiness.kind) {
    case "restoring-request-context":
      return {
        message: "Restoring authenticated session…",
        detail: null,
        body: null,
        footer: null,
        actions: [],
      };
    case "mobile-no-host":
      return {
        message:
          "No host connected. Connect a host from this device to get started.",
        detail: null,
        body: null,
        footer: null,
        actions: [],
      };
    case "unavailable-host":
      return unavailableFallback();
    case "loading-host":
    case "provisioning-host":
    case "compatibility-checking":
      return loadingFallback(readiness.kind, presentation);
    case "provisioning-error":
      return provisioningErrorFallback(presentation);
    case "removed-host":
      return {
        message: "Traycer was removed from this device.",
        detail:
          "Your chats and history are preserved. Reinstall to start the host again.",
        body: null,
        footer: null,
        actions: [
          {
            label: "Quit",
            testId: "local-host-removed-quit",
            variant: "destructive",
            disabled: false,
            onClick: () => {
              requestAppQuit();
            },
          },
          {
            label: "Reinstall",
            testId: "local-host-removed-reinstall",
            variant: "outline",
            disabled: false,
            onClick: presentation.reinstall,
          },
        ],
      };
    case "compatibility-error":
      return {
        message: `Could not verify host compatibility. ${presentation.compatibility.errorMessage ?? ""}`,
        detail: null,
        body: null,
        footer: hostStartupReportIssueAction(
          "Could not start Traycer Host",
          "Traycer Host could not start.",
        ),
        actions: [
          {
            label: "Retry",
            testId: "local-host-compatibility-retry",
            variant: "outline",
            disabled: presentation.compatibility.retrying,
            onClick: presentation.compatibility.retry,
          },
        ],
      };
    case "incompatible-host":
      return incompatibleFallback(presentation);
  }
}

/**
 * Standard "Report issue" affordance shown alongside the recovery actions
 * on the startup-failure fallbacks (provisioning-error, compatibility-error,
 * incompatible-host), matching the pre-consolidation gate cards.
 */
function hostStartupReportIssueAction(
  title: string,
  message: string,
): ReactNode {
  return (
    <ReportIssueAction
      context={createReportIssueContext({
        title,
        message,
        code: null,
        source: "Host startup",
      })}
      presentation="text"
      className={undefined}
    />
  );
}

function configureShellAction(
  presentation: DefaultHostReadinessPresentation,
): ReadinessFallbackAction {
  return {
    label: "Configure shell…",
    testId: "local-host-open-shell-settings",
    variant: "outline",
    disabled: false,
    onClick: presentation.configureShell,
  };
}

function loadingFallback(
  kind: "loading-host" | "provisioning-host" | "compatibility-checking",
  presentation: DefaultHostReadinessPresentation,
): ReadinessFallback {
  if (kind === "compatibility-checking") {
    return {
      message: "Checking Traycer Host compatibility…",
      detail: null,
      body: null,
      footer: null,
      actions: presentation.localTarget
        ? [configureShellAction(presentation)]
        : [],
    };
  }
  // `loading-host`/`provisioning-host` for a non-local target (a remote host
  // still resolving) get the plain message - the rich progress/log card
  // below is local-bootstrap specific and would be misleading here.
  if (!presentation.localTarget) {
    return {
      message: presentation.progress?.message ?? "Starting local Traycer Host…",
      detail: null,
      body: null,
      footer: null,
      actions: [],
    };
  }
  return {
    message: null,
    detail: null,
    body: (
      <LocalHostLoadingContent
        stage="loading"
        progress={presentation.progress}
        onConfigureShell={presentation.configureShell}
        onRetry={presentation.requestRespawn}
        retryPending={presentation.respawnPending}
      />
    ),
    footer: null,
    actions: [],
  };
}

function provisioningErrorFallback(
  presentation: DefaultHostReadinessPresentation,
): ReadinessFallback {
  return {
    message:
      presentation.provisioningError?.message ??
      "Could not start Traycer Host.",
    detail: null,
    body: null,
    footer: hostStartupReportIssueAction(
      "Could not start Traycer Host",
      "Traycer Host could not start.",
    ),
    actions: [
      {
        label: "Retry",
        testId: "local-host-provisioning-retry",
        variant: "outline",
        disabled: presentation.provisioning,
        onClick: presentation.retryProvisioning,
      },
    ],
  };
}

function incompatibleFallback(
  presentation: DefaultHostReadinessPresentation,
): ReadinessFallback {
  const footer = hostStartupReportIssueAction(
    "Host update required",
    "Traycer Host requires an update.",
  );
  if (!presentation.canManageHost) {
    return {
      message: "Host update required",
      detail: compatibilityDetail(presentation),
      body: null,
      footer,
      actions: [],
    };
  }
  if (presentation.hostBusy) {
    return {
      message: "Host update required",
      detail: compatibilityDetail(presentation),
      body: null,
      footer,
      actions: [
        {
          label: "Refresh",
          testId: "local-host-incompatible-busy-refresh",
          variant: "outline",
          disabled: false,
          onClick: presentation.retryProvisioning,
        },
        {
          label: "Force update host",
          testId: "local-host-incompatible-busy-force-update",
          variant: "destructive",
          disabled: false,
          onClick: presentation.forceProvisioning,
        },
      ],
    };
  }
  return {
    message: "Host update required",
    detail: compatibilityDetail(presentation),
    body: null,
    footer,
    actions: [
      {
        label: "Update host",
        testId: "local-host-incompatible-update",
        variant: "default",
        disabled: false,
        onClick: presentation.forceProvisioning,
      },
    ],
  };
}

function compatibilityDetail(
  presentation: DefaultHostReadinessPresentation,
): string | null {
  const details = [
    presentation.compatibility.errorMessage,
    presentation.provisioningError?.message ?? null,
  ].filter((detail): detail is string => detail !== null);
  return details.length === 0 ? null : details.join(" ");
}

function unavailableFallback(): ReadinessFallback {
  return {
    message: "This tab's host is unavailable.",
    detail: null,
    body: null,
    footer: null,
    actions: [],
  };
}

function useHostDirectoryEntries(
  directory: {
    readonly onChange: (
      listener: (
        entries: readonly HostDirectoryEntry[],
        localEntry: HostDirectoryEntry | null,
      ) => void,
    ) => { readonly dispose: () => void };
    readonly list: () => Promise<readonly HostDirectoryEntry[]>;
  } | null,
): ReadonlyArray<HostDirectoryEntry> {
  const entriesRef = useRef<ReadonlyArray<HostDirectoryEntry>>([]);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (directory === null) return () => undefined;
      let subscribed = true;
      const subscription = directory.onChange((entries) => {
        entriesRef.current = entries;
        onStoreChange();
      });
      void directory.list().then((entries) => {
        if (!subscribed) return;
        entriesRef.current = entries;
        onStoreChange();
      });
      return () => {
        subscribed = false;
        subscription.dispose();
      };
    },
    [directory],
  );
  const getSnapshot = useCallback(() => entriesRef.current, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
