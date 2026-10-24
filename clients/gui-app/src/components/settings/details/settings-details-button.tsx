import "@/components/settings/details/environment-details-providers";
import { useMemo, useState, type ReactNode } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { DetailsDrawer } from "@/components/settings/details/details-drawer";
import { getDetailsProvider } from "@/lib/settings-details-entry";
import { useDetailsRecovery } from "@/components/settings/details/use-details-recovery";
import { serializeDetailsExport } from "@/components/settings/details/details-export";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostClient } from "@/lib/host";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { resolvePoolTierHostClient } from "@/lib/host/binding-host-client";
import { saveBlobToDisk } from "@/lib/files/save-blob-to-disk";
import { settingsDetailsQueryKeys } from "@/lib/query-keys/settings-details-query-keys";
import type { DetailsSubject } from "@/lib/settings-details-entry";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";

/** Mounted only while open: no previous reader's evidence is rendered on open. */
function DetailsSession(props: {
  readonly subject: DetailsSubject;
  readonly title: string;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const surfaceClient = useHostClient();
  const client = useMemo(
    () => resolvePoolTierHostClient(surfaceClient),
    [surfaceClient],
  );
  const hostId = useReactiveHostReadiness(client).hostId;
  const queryClient = useQueryClient();
  const runner = useRunnerHostOrNull();
  const recovery = useDetailsRecovery();
  const viewerUserId = useCloudChatViewerId();
  const [selected, setSelected] = useState<{
    readonly subject: DetailsSubject;
    readonly title: string;
  } | null>(null);
  const subject = selected?.subject ?? props.subject;
  const title = selected?.title ?? props.title;
  const load = async () => {
    const provider = getDetailsProvider(subject.kind);
    if (provider === null)
      throw new Error("Details are unavailable. Update Traycer and try again.");
    return provider(subject, { client, hostId, queryClient });
  };
  const entry = useQuery(
    queryOptions({
      queryKey: settingsDetailsQueryKeys.entry(hostId, subject, viewerUserId),
      queryFn: load,
      staleTime: 0,
      gcTime: 0,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
      enabled: viewerUserId.length > 0,
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
  const error = entry.error ?? exportDiagnostics.error;
  return (
    <DetailsDrawer
      entry={entry.isFetching ? null : (entry.data ?? null)}
      title={title}
      open
      onOpenChange={props.onOpenChange}
      loading={entry.isPending || entry.isFetching}
      error={error === null ? null : error.message}
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

/** The common entry point, also used by notification and sandbox surfaces. */
export function SettingsDetailsDialog(props: {
  readonly subject: DetailsSubject;
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  return props.open ? (
    <DetailsSession
      subject={props.subject}
      title={props.title}
      onOpenChange={props.onOpenChange}
    />
  ) : null;
}

export function SettingsDetailsButton(props: {
  readonly subject: DetailsSubject;
  readonly title: string;
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
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
