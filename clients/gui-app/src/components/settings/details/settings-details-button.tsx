import "@/components/settings/details/environment-details-providers";
import {
  beginEnvironmentCloudOperation,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
import { useState, type ReactNode } from "react";
import {
  queryOptions,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DetailsDrawer,
  type DetailsTab,
} from "@/components/settings/details/details-drawer";
import { getDetailsProvider } from "@/lib/settings-details-entry";
import { useDetailsRecovery } from "@/components/settings/details/use-details-recovery";
import { useSecretRemovalRetry } from "@/components/settings/details/use-secret-removal-retry";
import { serializeDetailsExport } from "@/components/settings/details/details-export";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostClient } from "@/lib/host";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { saveBlobToDisk } from "@/lib/files/save-blob-to-disk";
import { settingsDetailsQueryKeys } from "@/lib/query-keys/settings-details-query-keys";
import type { DetailsSubject } from "@/lib/settings-details-entry";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";

const DETAILS_LOAD_FAILED = "Couldn't load details.";

interface DetailsSelection {
  readonly subject: DetailsSubject;
  readonly title: string;
}

function resolveDetailsSelection(
  rootSubject: DetailsSubject | null,
  rootTitle: string,
  selection: DetailsSelection | null,
): {
  readonly selected: DetailsSelection | null;
  readonly subject: DetailsSubject | null;
  readonly title: string;
} {
  const selected = rootSubject === null ? null : selection;
  return {
    selected,
    subject: selected?.subject ?? rootSubject,
    title: selected?.title ?? rootTitle,
  };
}

/** Keep the controls mounted while their diagnostics subject is being read. */
function DetailsSession(props: {
  readonly subject: DetailsSubject | null;
  readonly title: string;
  readonly controls: ReactNode;
  readonly currentStatus: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialTab: DetailsTab;
}): ReactNode {
  const client = useHostClient();
  const hostId = useReactiveHostReadiness(client).hostId;
  const environmentCloud = useEnvironmentCloud();
  const queryClient = useQueryClient();
  const runner = useRunnerHostOrNull();
  const recovery = useDetailsRecovery();
  const itemRetry = useSecretRemovalRetry();
  const viewerUserId = useCloudChatViewerId();
  const [selection, setSelected] = useState<DetailsSelection | null>(null);
  const { selected, subject, title } = resolveDetailsSelection(
    props.subject,
    props.title,
    selection,
  );
  const load = async (target: DetailsSubject) => {
    const provider = getDetailsProvider(target.kind);
    if (provider === null)
      throw new Error("Details are unavailable. Update Traycer and try again.");
    return provider(target, {
      environmentCloud: beginEnvironmentCloudOperation(environmentCloud),
      queryClient,
    });
  };
  const entry = useQuery(
    queryOptions({
      queryKey: settingsDetailsQueryKeys.entry(hostId, subject, viewerUserId),
      queryFn: subject === null ? skipToken : () => load(subject),
      staleTime: 0,
      gcTime: 0,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
      enabled: subject !== null && viewerUserId.length > 0,
    }),
  );
  const exportDiagnostics = useMutation({
    mutationKey: settingsDetailsQueryKeys.export(subject),
    mutationFn: async () => {
      if (entry.data === undefined) return;
      const exported = await entry.data.exportDiagnostics();
      if (
        (useAuthStore.getState().contextMetadata?.userId ?? "") !== viewerUserId
      ) {
        throw new Error("Sign in again to save diagnostics.");
      }
      await saveBlobToDisk(
        new Blob([serializeDetailsExport(exported)], {
          type: "application/json",
        }),
        "traycer-settings-diagnostics.json",
        runner?.fileSave ?? null,
      );
    },
  });
  // A failed read says so in one line; a failed export keeps its own words.
  let error: string | null = exportDiagnostics.error?.message ?? null;
  if (entry.error !== null) error = DETAILS_LOAD_FAILED;
  const loading = entry.isPending || entry.isFetching;
  return (
    <DetailsDrawer
      entry={entry.isFetching ? null : (entry.data ?? null)}
      hasSubject={subject !== null}
      title={title}
      open
      onOpenChange={props.onOpenChange}
      loading={subject === null ? false : loading}
      error={subject === null ? null : error}
      exportPending={exportDiagnostics.isPending}
      recoveryPending={recovery.pending}
      onExport={() => exportDiagnostics.mutate()}
      onRetry={() => {
        exportDiagnostics.reset();
        void entry.refetch();
      }}
      onRecover={recovery.recover}
      onSubjectSelect={(nextSubject, nextTitle) => {
        exportDiagnostics.reset();
        setSelected({ subject: nextSubject, title: nextTitle });
      }}
      itemRetry={itemRetry}
      currentStatus={props.currentStatus}
      // The controls act on the subject it opened for, not a selected item.
      controls={selected === null ? props.controls : null}
      initialTab={props.initialTab}
      onBack={
        selected === null
          ? null
          : () => {
              exportDiagnostics.reset();
              setSelected(null);
            }
      }
    />
  );
}

/**
 * The common entry point, also used by notification and sandbox surfaces.
 * A null subject keeps local status and controls; diagnostics need the subject.
 */
export function SettingsDetailsDialog(props: {
  readonly subject: DetailsSubject | null;
  readonly title: string;
  /** The subject's own actions, shown under its status; `null` for none. */
  readonly controls: ReactNode;
  readonly currentStatus: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The tab it opens on; Export diagnostics needs the subject's status. */
  readonly initialTab: DetailsTab;
}): ReactNode {
  if (!props.open) return null;
  return (
    <DetailsSession
      subject={props.subject}
      title={props.title}
      currentStatus={props.currentStatus}
      controls={props.controls}
      onOpenChange={props.onOpenChange}
      initialTab={props.initialTab}
    />
  );
}

export function SettingsDetailsButton(props: {
  readonly subject: DetailsSubject | null;
  readonly title: string;
  readonly controls: ReactNode;
  readonly currentStatus: string | null;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
      >
        Details
      </Button>
      <SettingsDetailsDialog
        subject={props.subject}
        title={props.title}
        currentStatus={props.currentStatus}
        controls={props.controls}
        open={open}
        onOpenChange={setOpen}
        initialTab="status"
      />
    </>
  );
}
