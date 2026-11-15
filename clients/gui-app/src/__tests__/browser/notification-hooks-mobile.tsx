import { createRoot } from "react-dom/client";
import { CloudNotificationHooksSection } from "@/components/settings/panels/cloud-notification-hooks-section";
import type { CloudNotificationHook } from "@traycer-clients/shared/environment/notification-hook-values";
import { TEAM_NOTIFICATION_HOOKS_COPY } from "@/components/settings/panels/cloud-notification-copy";
import { NotificationHooksSection } from "@/components/settings/panels/notification-hooks-section";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  queryOptions,
} from "@tanstack/react-query";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import type { HostScopedMutationContext } from "@/hooks/host/use-host-scoped-mutation";
import "@/lib/theme-applier";
import "@/index.css";

type NotificationStatus = ResponseOfMethod<
  HostRpcRegistry,
  "host.notificationHooks.status"
>;
type NotificationSaveResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.notificationHooks.save"
>;
type SaveCapture = {
  readonly cloud: EnvironmentCloud | null;
  readonly binding: HostRuntimeBinding<HostRpcRegistry> | null;
  readonly stream: StreamRuntimeBinding | null;
  readonly viewerId: string;
};

const buildHook: CloudNotificationHook = {
  id: "build-alerts",
  name: "Build alerts",
  enabled: true,
  severities: null,
  action: {
    type: "http",
    url: "https://hooks.example.test/build-alerts",
    headers: { authorization: "Bearer literal-value" },
  },
};

const computerStatus: NotificationStatus = {
  configPath: "/home/test/.traycer/notification-hooks.json",
  configError: null,
  hooks: [
    {
      id: buildHook.id,
      name: buildHook.name,
      enabled: buildHook.enabled,
      severities: buildHook.severities,
      action: buildHook.action,
      lastResult: null,
      localOnly: true,
    },
  ],
  configurationRevision: "rev-17",
  pendingRemovalNotices: [],
};

const computerStatusQuery = queryOptions<
  NotificationStatus,
  HostRpcError,
  NotificationStatus,
  string[]
>({
  queryKey: ["notification-hooks-mobile", "computer"],
  queryFn: () => Promise.resolve(computerStatus),
  staleTime: Infinity,
});

export function NotificationHooksMobileFixture() {
  const view = new URLSearchParams(window.location.search).get("view");
  const account = view === "account";
  const computer = view === "computer";
  const viewer = view === "team-viewer";
  const hooks = account ? [] : [buildHook];
  const query = useQuery({
    ...computerStatusQuery,
    initialData: computerStatus,
  });
  const testHook = useMutation<
    ResponseOfMethod<HostRpcRegistry, "host.notificationHooks.test">,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, "host.notificationHooks.test">,
    { readonly hostId: string | null }
  >({
    mutationFn: () =>
      Promise.reject(
        new Error("The mobile layout fixture does not send hook tests"),
      ),
  });
  const saveHooks = useMutation<
    NotificationSaveResponse,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, "host.notificationHooks.save">,
    HostScopedMutationContext<SaveCapture>
  >({
    mutationFn: () =>
      Promise.reject(
        new Error("The mobile layout fixture does not save hooks"),
      ),
  });
  let title: string = TEAM_NOTIFICATION_HOOKS_COPY.title;
  if (computer) title = "Computer notifications";
  else if (account) title = "Account notifications";

  return (
    <main className="box-border w-full max-w-[720px] space-y-3 p-3">
      <h1 className="text-ui-lg font-semibold">{title}</h1>
      {account || computer ? null : (
        <p className="text-ui-sm text-muted-foreground">
          {TEAM_NOTIFICATION_HOOKS_COPY.description("Acme")}
        </p>
      )}
      {computer ? (
        <NotificationHooksSection
          statusQuery={query}
          testHook={testHook}
          saveHooks={saveHooks}
        />
      ) : (
        <CloudNotificationHooksSection
          scope={account ? "account" : "team"}
          teamName={account ? null : "Acme"}
          snapshot={{ hooks, revision: 17 }}
          saving={false}
          error={null}
          refusedHookId={null}
          editorProblem={null}
          canEdit={!viewer}
          onSave={() => undefined}
          onClearProblem={() => undefined}
        />
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("notification fixture root is missing");
const queryClient = new QueryClient();
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <NotificationHooksMobileFixture />
  </QueryClientProvider>,
);
