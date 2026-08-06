import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  HostGlyph,
  HostPresenceDot,
} from "@/components/settings/host-scope/host-glyph";
import { formatPlatform } from "@/components/settings/host-scope/host-scope-model";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useAddHostDialogStore } from "@/stores/settings/add-host-dialog-store";
import { cn } from "@/lib/utils";

const INSTALL_COMMAND = "curl -fsSL traycer.ai/install | sh";
const WINDOWS_COMMAND = "irm traycer.ai/install.ps1 | iex";
const LOGIN_COMMAND = "traycer login";

/**
 * Adding a host, as something you WATCH happen.
 *
 * The old dialog printed a curl command beside a static paragraph that read
 * "Waiting for a new host to come online…" — a sentence that always rendered
 * and was never true, because nothing was watching. The registry already polls
 * every ~15s and this dialog already knows which hosts existed when it
 * opened, so the wait can be real: run the command on the other computer, and
 * the moment it registers, the dialog resolves into that host's identity.
 *
 * That is the one moment worth animating in this whole surface. It is also the
 * product's core promise (one account, many hosts) rendered literally.
 */
export function AddHostDialog(): ReactNode {
  const open = useAddHostDialogStore((s) => s.open);
  const closeDialog = useAddHostDialogStore((s) => s.closeDialog);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
    >
      <DialogContent
        className="w-[min(92vw,34rem)]"
        data-testid="add-host-dialog"
      >
        {open ? <AddHostDialogBody /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddHostDialogBody(): ReactNode {
  const scope = useHostScope();
  const knownHostIds = useAddHostDialogStore((s) => s.knownHostIds);
  const closeDialog = useAddHostDialogStore((s) => s.closeDialog);
  const [platform, setPlatform] = useState<"unix" | "windows">("unix");

  // The arrival: a host that was NOT there when this dialog opened AND has
  // actually finished enrolling.
  //
  // Diffing against the open-time snapshot is what distinguishes a new host
  // from one already registered — but the diff alone was not enough. The list
  // is a UNION of the runtime directory and the cloud registry, so a row can
  // appear in it while being only half real: a pre-existing registry host whose
  // list simply resolved after the dialog opened, or a directory row nothing
  // can dial yet. Both used to trip the success banner, telling the user their
  // new host was "ready to run agents" when nothing had connected.
  //
  // `registered && connectable` is the claim the banner actually makes: the
  // account knows it, and this client has a route to it.
  const arrived = useMemo(() => {
    const known = new Set(knownHostIds);
    return (
      scope.hosts.find(
        (host) =>
          !known.has(host.hostId) && host.registered && host.connectable,
      ) ?? null
    );
  }, [scope.hosts, knownHostIds]);

  if (arrived !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{arrived.name} is connected</DialogTitle>
          <DialogDescription>
            It registered itself and is ready to run agents.
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3"
          data-testid="add-host-arrived"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
            <HostGlyph host={arrived} className="size-4.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui-sm font-medium">
              {arrived.name}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground">
              <HostPresenceDot
                tone={arrived.health.tone}
                animate={arrived.health.live}
                className={undefined}
              />
              <span className="truncate">
                {[arrived.health.label, formatPlatform(arrived.platform)]
                  .filter((p): p is string => p !== null && p.length > 0)
                  .join(" · ")}
              </span>
            </span>
          </span>
          <Check className="size-4 shrink-0 text-emerald-500" aria-hidden />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={closeDialog}>
            Close
          </Button>
          <Button
            type="button"
            onClick={() => {
              scope.setHostId(arrived.hostId);
              closeDialog();
            }}
            data-testid="add-host-manage-arrived"
          >
            Set up {arrived.name}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add host</DialogTitle>
        <DialogDescription>
          Run these on the computer you want to reach. Traycer can&apos;t
          install itself onto another computer, so this part happens over there —
          this window will notice the moment it connects.
        </DialogDescription>
      </DialogHeader>

      <div className="flex gap-1" role="tablist" aria-label="Install platform">
        <PlatformTab
          label="macOS / Linux"
          selected={platform === "unix"}
          onSelect={() => setPlatform("unix")}
        />
        <PlatformTab
          label="Windows"
          selected={platform === "windows"}
          onSelect={() => setPlatform("windows")}
        />
      </div>

      <ol className="flex flex-col gap-3 text-ui-sm">
        <li className="flex flex-col gap-2">
          <span>Install the host, which registers it as a service:</span>
          <CommandBlock
            command={platform === "unix" ? INSTALL_COMMAND : WINDOWS_COMMAND}
          />
        </li>
        <li className="flex flex-col gap-2">
          <span>Sign in on that computer:</span>
          <CommandBlock command={LOGIN_COMMAND} />
        </li>
        <li>Approve the login in the browser that opens.</li>
      </ol>

      <p
        className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-ui-xs text-muted-foreground"
        data-testid="add-host-waiting"
      >
        <AgentSpinningDots
          testId={undefined}
          variant="orbit"
          className="text-muted-foreground"
        />
        Watching for a new host…
      </p>
    </>
  );
}

function PlatformTab(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.selected}
      onClick={props.onSelect}
      className={cn(
        "rounded-md px-2.5 py-1 text-ui-xs transition-colors",
        props.selected
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50",
      )}
    >
      {props.label}
    </button>
  );
}

function CommandBlock(props: { readonly command: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-code-xs text-foreground">
        {props.command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="size-7 shrink-0 p-0"
        aria-label={`Copy: ${props.command}`}
        onClick={() => {
          void navigator.clipboard.writeText(props.command);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? (
          <Check className="size-3.5 text-emerald-500" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
    </div>
  );
}
