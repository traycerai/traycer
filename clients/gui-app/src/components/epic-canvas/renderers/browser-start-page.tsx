import { useId } from "react";
import { AppWindow, RadioTower } from "lucide-react";
import {
  useHostClientForHostId,
  useHostDirectoryEntryForHostId,
} from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";

interface BrowserStartPageProps {
  readonly epicId: string;
  readonly hostId: string;
  readonly browserRunsOnHost: boolean;
  readonly onNavigate: (url: string) => void;
}

export function BrowserStartPage(props: BrowserStartPageProps) {
  const headingId = useId();
  const client = useHostClientForHostId(props.hostId);
  const hostEntry = useHostDirectoryEntryForHostId(props.hostId);
  const localServersReachable =
    client !== null && (props.browserRunsOnHost || hostEntry?.kind === "local");
  const query = useHostQuery({
    client,
    method: "resources.listLocalServers",
    params: { epicId: props.epicId },
    cacheKeyIdentity: undefined,
    options: {
      enabled: localServersReachable,
      poll: true,
      retry: false,
    },
  });
  const servers =
    localServersReachable && !query.isError ? (query.data?.servers ?? []) : [];

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <section
        aria-labelledby={headingId}
        className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10"
      >
        <div className="mb-5 flex items-center gap-2 text-muted-foreground">
          <RadioTower className="size-5" aria-hidden />
          <h2 id={headingId} className="text-ui-lg font-medium text-foreground">
            Local servers
          </h2>
        </div>
        {servers.length > 0 ? (
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {servers.map((server) => {
              const address = `localhost:${server.port}`;
              // ponytail: treat tracked TCP listeners as HTTP until non-HTTP
              // entries justify a host-side protocol probe.
              const url = `http://${address}`;
              return (
                <li key={server.port}>
                  <button
                    type="button"
                    className="flex min-h-16 w-full items-center gap-4 px-4 py-3 text-left outline-none transition-colors hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-label={`Open ${server.processName} at ${address} (running)`}
                    onClick={() => props.onNavigate(url)}
                  >
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                      <AppWindow
                        className="size-5 text-muted-foreground"
                        aria-hidden
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui-base font-medium">
                        {server.processName}
                      </span>
                      <span className="block truncate font-mono text-ui-sm text-muted-foreground">
                        {address}
                      </span>
                    </span>
                    <span
                      className="size-2.5 shrink-0 rounded-full bg-emerald-500 ring-4 ring-emerald-500/10"
                      aria-hidden
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div
            className="rounded-md border border-dashed border-border px-5 py-8 text-center text-ui-sm text-muted-foreground"
            role="status"
          >
            {startPageStatus(
              localServersReachable,
              query.isPending,
              query.isError,
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function startPageStatus(
  localServersReachable: boolean,
  pending: boolean,
  failed: boolean,
): string {
  if (!localServersReachable) {
    return "Local server shortcuts aren’t available for this browser. Enter a URL above.";
  }
  if (pending) return "Looking for local servers…";
  if (failed) return "Unable to find local servers. Enter a URL above.";
  return "No local servers detected. Start one in this epic or enter a URL above.";
}
