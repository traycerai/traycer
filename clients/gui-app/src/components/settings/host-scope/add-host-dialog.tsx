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
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const INSTALL_COMMAND = "curl -fsSL traycer.ai/install | sh";
const WINDOWS_COMMAND = "irm traycer.ai/install.ps1 | iex";
const LOGIN_COMMAND = "traycer login";
/**
 * Tolerance when comparing a registry `createdAt` (server clock) against the
 * dialog's open time (client clock) — see the enrollment-beat-the-baseline
 * arm of the arrival check.
 */
const ENROLLED_DURING_OPEN_SLACK_MS = 2 * 60_000;

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

  // The arrival: a host that was NOT in the last COMPLETE picture of the
  // account and has finished enrolling.
  //
  // Two rules, each carrying a false claim this dialog used to make:
  //
  // "Complete picture", not "open-time snapshot". The union is only whole
  // when both source lists have answered cleanly, and the click that opened
  // this dialog can land while one of them is failed or still in flight. A
  // snapshot taken then is missing every host the absent list would have
  // contributed, so a later successful retry made those PRE-EXISTING hosts
  // look new, and the banner named one of them as the machine that just
  // connected. The baseline therefore waits for the first clean read after
  // opening (`null` until then — the watcher keeps watching, claiming
  // nothing); the body remounts per open, so it resets with the dialog.
  //
  // `registered`, not `registered && connectable`. Requiring a dialable route
  // stranded exactly the users the plan gate applies to: a free-plan account
  // enrolling a remote machine sees it register, stay `connectable: false`
  // forever by design — and this dialog spun on "Watching for a new host…"
  // over a host that was already in the account. Registration is the
  // enrollment claim; the route is a separate fact the banner copy states
  // honestly either way.
  //
  // And a third rule the first two conspire to need: enrollment can BEAT the
  // deferred baseline. Waiting for a clean read is what stops pre-existing
  // hosts from being announced, but a fast machine can finish enrolling
  // inside that same window and land in the baseline — swallowed forever by
  // set membership. The registry's `createdAt` breaks the tie: a baseline
  // host enrolled after this dialog opened is the arrival being watched for.
  const listsSettled = !scope.isLoading && !scope.listsFailed;
  const [baseline, setBaseline] = useState<readonly string[] | null>(() =>
    listsSettled ? knownHostIds : null,
  );
  const [openedAtMs] = useState(() => Date.now());
  // Filled during render, not in an effect — the documented "adjusting state
  // when data changes" shape: React re-renders before committing, and the
  // arrival check below never sees a settled list without a baseline.
  if (baseline === null && listsSettled) {
    setBaseline(scope.hosts.map((host) => host.hostId));
  }

  const arrived = useMemo(() => {
    if (baseline === null) return null;
    const known = new Set(baseline);
    const openSnapshot = new Set(knownHostIds);
    return (
      scope.hosts.find((host) => {
        // Present when this dialog opened means not an arrival, however the
        // rest resolves — the person watched it exist before running anything.
        if (!host.registered || openSnapshot.has(host.hostId)) return false;
        if (!known.has(host.hostId)) return true;
        // In the baseline, but only because enrollment BEAT the first clean
        // read: a dialog opened during a failed or in-flight list waits for
        // the retry, and a fast host can register inside that window. Set
        // membership cannot tell that host from a pre-existing one the retry
        // merely revealed — the registry's enrollment time can. The slack
        // absorbs modest client/server clock skew without readmitting
        // long-standing hosts.
        if (host.item === null) return false;
        const createdAtMs = Date.parse(host.item.createdAt);
        return (
          Number.isFinite(createdAtMs) &&
          createdAtMs >= openedAtMs - ENROLLED_DURING_OPEN_SLACK_MS
        );
      }) ?? null
    );
  }, [scope.hosts, baseline, knownHostIds, openedAtMs]);

  if (arrived !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {arrived.connectable
              ? `${arrived.name} is connected`
              : `${arrived.name} is registered`}
          </DialogTitle>
          <DialogDescription>
            {arrived.connectable
              ? "It registered itself and is ready to run agents."
              : "It's in your account. This window doesn't have a live connection to it, but you can manage it from Settings."}
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
          install itself onto another computer, so this part happens over there
          — this window will notice the moment it connects.
        </DialogDescription>
      </DialogHeader>

      {/* Radio semantics, not tabs: the two buttons pick one value of two,
          and nothing here is a tabpanel with `aria-controls` wiring or the
          arrow-key movement a real tablist owes its users. */}
      <div
        className="flex gap-1"
        role="radiogroup"
        aria-label="Install platform"
      >
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
      role="radio"
      aria-checked={props.selected}
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
  // The hook, not a hand-rolled writeText + timeout: it withholds the success
  // check when the write rejects (denied permission, insecure context) and
  // clears its reset timer on unmount, both of which the inline version got
  // wrong.
  const clipboard = useClipboardCopy({
    resetMs: 1600,
    onSuccess: null,
    onError: () => toast.error("Couldn't copy the command"),
  });
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
        onClick={() => clipboard.copy(props.command)}
      >
        {clipboard.copied ? (
          <Check className="size-3.5 text-emerald-500" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
    </div>
  );
}
