import { useState } from "react";
import { Cloud, Plus, TriangleAlert } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostListItem,
  HostPresenceHealth,
} from "@traycer/protocol/host/host-status";
import type {
  HostVersionPolicyResult,
  UpdateHostVersionPolicyInput,
} from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { useUpdateHostVersionPolicy } from "@/hooks/auth/use-update-host-version-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useHostBinding } from "@/lib/host";
import { hasReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import { getViewerReachabilityCheck } from "@/lib/host/viewer-reachability-store";
import { cn } from "@/lib/utils";
import {
  deriveHostPresence,
  deriveUpdateAffordance,
  deriveUpdatePill,
  formatHostMeta,
  isValidHostVersion,
  type HostPresenceTone,
  type HostUpdateAffordanceView,
  type HostUpdatePillTone,
} from "@/components/settings/panels/my-hosts-model";

/**
 * My Hosts (Remote Host Support, Journey 2): the cross-device registry list
 * with honest live status. Status is a pure function of the host-status DTO +
 * the envelope's presence-health + two client-local signals — whether this
 * client holds a live E2E session to the host, and this client's own last
 * reachability check (see `my-hosts-model.ts`) — the list polls every ~15s
 * while visible and refetches on focus.
 */
export function MyHostsList() {
  const status = useAuthStore((s) => s.status);
  const query = useRegisteredHosts();
  // `useHostBinding` tolerates rendering outside a `<HostRuntimeProvider>`
  // (returns `null`) the same way `useRegisteredHosts` already does, so a
  // signed-out / unbound render never throws.
  const binding = useHostBinding();
  // `isPending` alone stays `true` for a disabled query; pair it with a live
  // fetch so the signed-out / unbound case shows its own state, not a spinner.
  const isLoading = query.isPending && query.fetchStatus !== "idle";

  return (
    <section
      className="flex flex-col gap-3 px-5 py-4"
      aria-label="My Hosts"
      data-testid="my-hosts"
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <h3 className="text-ui font-medium">My Hosts</h3>
          <p className="text-ui-xs text-muted-foreground">
            Every machine signed in to your account, with live status.
          </p>
        </div>
        <AddHostDialog />
      </header>
      <MyHostsBody
        signedIn={status === "signed-in"}
        isPending={isLoading}
        isError={query.isError}
        hosts={query.data?.hosts ?? null}
        presenceHealth={query.data?.presenceHealth ?? null}
        localHostId={binding?.directory.getLocalEntry()?.hostId ?? null}
        nowMs={query.dataUpdatedAt}
      />
    </section>
  );
}

interface MyHostsBodyProps {
  readonly signedIn: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly hosts: readonly HostListItem[] | null;
  readonly presenceHealth: HostPresenceHealth | null;
  /** This viewer's own local host id, or `null` on a local-less shell. */
  readonly localHostId: string | null;
  /** Reference "now" for relative last-seen — the query's last-fetch time. */
  readonly nowMs: number;
}

function MyHostsBody(props: MyHostsBodyProps) {
  const {
    signedIn,
    isPending,
    isError,
    hosts,
    presenceHealth,
    localHostId,
    nowMs,
  } = props;

  if (!signedIn) {
    return (
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="my-hosts-signed-out"
      >
        Sign in to see your hosts.
      </p>
    );
  }
  if (hosts === null && isPending) {
    return (
      <p
        className="flex items-center gap-2 text-ui-sm text-muted-foreground"
        data-testid="my-hosts-loading"
      >
        <AgentSpinningDots
          testId={undefined}
          variant="orbit"
          className="text-muted-foreground"
        />
        Loading hosts…
      </p>
    );
  }
  if (hosts === null && isError) {
    return (
      <p className="text-ui-sm text-destructive" data-testid="my-hosts-error">
        Couldn&apos;t load your hosts. Retrying…
      </p>
    );
  }
  const rows = hosts ?? [];
  if (rows.length === 0) {
    return (
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="my-hosts-empty"
      >
        No hosts yet. Add a host and it&apos;ll appear here automatically.
      </p>
    );
  }
  const health: HostPresenceHealth = presenceHealth ?? {
    status: "healthy",
    reason: null,
  };
  return (
    <div className="flex flex-col gap-2">
      {health.status === "degraded" ? <PresenceDegradedNotice /> : null}
      <ul className="flex flex-col gap-1.5" data-testid="my-hosts-list">
        {rows.map((host) => (
          <HostRow
            key={host.hostId}
            host={host}
            presenceHealth={health}
            isViewerLocalHost={host.hostId === localHostId}
            nowMs={nowMs}
          />
        ))}
      </ul>
    </div>
  );
}

function PresenceDegradedNotice() {
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-ui-xs text-amber-600 dark:text-amber-400"
      data-testid="my-hosts-presence-degraded"
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      <span>
        Live status is temporarily degraded — some hosts may read “status
        unknown”.
      </span>
    </div>
  );
}

interface HostRowProps {
  readonly host: HostListItem;
  readonly presenceHealth: HostPresenceHealth;
  readonly isViewerLocalHost: boolean;
  readonly nowMs: number;
}

function HostRow(props: HostRowProps) {
  const { host, presenceHealth, isViewerLocalHost, nowMs } = props;
  const presence = deriveHostPresence({
    status: host.status,
    presenceHealth,
    isViewerLocalHost,
    hasLiveSession: hasReadyRemoteSession(host.hostId),
    viewerCheck: getViewerReachabilityCheck(host.hostId),
    nowMs,
  });
  const updatePill = deriveUpdatePill(host.status.updateState);
  const updateAffordance = deriveUpdateAffordance(host.status);
  const updateMutation = useUpdateHostVersionPolicy(host.hostId);
  const meta = formatHostMeta(host, presence, nowMs);
  const name = host.displayName === null ? host.hostId : host.displayName;

  return (
    <li
      className="flex items-center gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-2.5"
      data-testid={`my-hosts-row-${host.hostId}`}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Cloud className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui-sm font-medium">{name}</span>
        {meta === null ? null : (
          <span className="truncate text-ui-xs text-muted-foreground">
            {meta}
          </span>
        )}
      </div>
      {presence.busy ? (
        <StatusPill tone="busy" label="agent running" showDot={false} />
      ) : null}
      {updatePill === null ? null : (
        <StatusPill
          tone={updatePillTone(updatePill.tone)}
          label={updatePill.label}
          showDot={false}
        />
      )}
      {updateAffordance.waitingForSessionsLabel === null ? null : (
        <StatusPill
          tone="update-warn"
          label={updateAffordance.waitingForSessionsLabel}
          showDot={false}
        />
      )}
      <StatusPill
        tone={presence.tone}
        label={presence.label}
        showDot={presence.showLiveDot}
      />
      <HostUpdateControls
        host={host}
        affordance={updateAffordance}
        mutation={updateMutation}
      />
    </li>
  );
}

type UpdateHostVersionPolicyMutation = UseMutationResult<
  HostVersionPolicyResult,
  Error,
  UpdateHostVersionPolicyInput
>;

interface HostUpdateControlsProps {
  readonly host: HostListItem;
  readonly affordance: HostUpdateAffordanceView;
  readonly mutation: UpdateHostVersionPolicyMutation;
}

/**
 * Update-management cluster for one host row (Architecture §13, T16): the
 * auto-update policy toggle, the "Update now" target-version popover, and —
 * only while the host is actually gated on open sessions — the "Apply now"
 * drain-gate force. All three share one mutation instance (`mutation`,
 * instantiated once per row in `HostRow`) so concurrent writes to the same
 * host naturally serialize instead of racing.
 */
function HostUpdateControls(props: HostUpdateControlsProps) {
  const { host, affordance, mutation } = props;
  const isAuto = host.updatePolicy === "auto";

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <TooltipWrapper
        label={isAuto ? "Auto-update on" : "Auto-update off"}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <Switch
          checked={isAuto}
          disabled={mutation.isPending}
          onCheckedChange={(checked) => {
            mutation.mutate({
              updatePolicy: checked ? "auto" : "manual",
              desiredVersion: undefined,
              force: undefined,
            });
          }}
          aria-label={isAuto ? "Turn off auto-update" : "Turn on auto-update"}
          data-testid={`my-hosts-auto-update-${host.hostId}`}
        />
      </TooltipWrapper>
      {affordance.applyNowLabel === null ? null : (
        <ApplyNowControl
          hostId={host.hostId}
          label={affordance.applyNowLabel}
          mutation={mutation}
        />
      )}
      {affordance.showUpdateNowInput ? (
        <UpdateNowControl hostId={host.hostId} mutation={mutation} />
      ) : null}
    </div>
  );
}

interface UpdateNowControlProps {
  readonly hostId: string;
  readonly mutation: UpdateHostVersionPolicyMutation;
}

/**
 * "Update now" (Architecture §13): a small popover collecting the target
 * version, validated client-side against the same dotted-numeric pattern
 * authn-v3's `PATCH /api/v3/hosts/:hostId` enforces server-side
 * (`isValidHostVersion`). There is no "latest release catalog" surfaced to
 * the client in v1, so the input is a plain text field rather than a version
 * picker.
 */
function UpdateNowControl(props: UpdateNowControlProps) {
  const { hostId, mutation } = props;
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState("");
  const trimmed = version.trim();
  const showInvalid = trimmed.length > 0 && !isValidHostVersion(trimmed);
  const canSubmit = trimmed.length > 0 && isValidHostVersion(trimmed);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setVersion("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={mutation.isPending}
          data-testid={`my-hosts-update-now-trigger-${hostId}`}
        >
          Update…
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(85vw,16rem)]"
        align="end"
        data-testid={`my-hosts-update-now-popover-${hostId}`}
      >
        <PopoverHeader>
          <PopoverTitle>Update to version</PopoverTitle>
          <PopoverDescription>
            Applied on the host&apos;s next check-in (~20s) — no live session
            required.
          </PopoverDescription>
        </PopoverHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) {
              return;
            }
            mutation.mutate(
              {
                updatePolicy: undefined,
                desiredVersion: trimmed,
                force: undefined,
              },
              {
                onSuccess: () => {
                  setOpen(false);
                  setVersion("");
                },
              },
            );
          }}
        >
          <Input
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            placeholder="1.4.2"
            aria-invalid={showInvalid}
            disabled={mutation.isPending}
            data-testid={`my-hosts-update-now-input-${hostId}`}
          />
          {showInvalid ? (
            <p className="text-ui-xs text-destructive">
              Use a dotted-numeric version, e.g. 1.4.2.
            </p>
          ) : null}
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit || mutation.isPending}
            data-testid={`my-hosts-update-now-submit-${hostId}`}
          >
            {mutation.isPending ? (
              <AgentSpinningDots
                testId={undefined}
                variant={undefined}
                className={undefined}
              />
            ) : null}
            Update now
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

interface ApplyNowControlProps {
  readonly hostId: string;
  readonly label: string;
  readonly mutation: UpdateHostVersionPolicyMutation;
}

/**
 * "Apply now — ends N sessions" (the drain-gate force, Architecture §13):
 * bypasses waiting for open sessions on the CURRENTLY pending update. This
 * is destructive (it ends N open terminal/agent sessions), so it always
 * requires an explicit confirmation via the same `ConfirmDestructiveDialog`
 * this codebase already uses for other disruptive host actions (e.g.
 * "Restart host" in `restart-host-confirm-dialog.tsx`) — never a casual
 * one-click.
 */
function ApplyNowControl(props: ApplyNowControlProps) {
  const { hostId, label, mutation } = props;
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={mutation.isPending}
        data-testid={`my-hosts-apply-now-trigger-${hostId}`}
      >
        {label}
      </Button>
      <ConfirmDestructiveDialog
        open={open}
        onOpenChange={setOpen}
        title="Apply the update now?"
        description="This ends every open terminal and agent session on this host so the update can apply immediately. Sessions can be reopened once the host is back."
        cascadeSummary={null}
        actionLabel="Apply now"
        isPending={mutation.isPending}
        onConfirm={() => {
          mutation.mutate(
            { updatePolicy: undefined, desiredVersion: undefined, force: true },
            { onSuccess: () => setOpen(false) },
          );
        }}
      />
    </>
  );
}

type PillTone =
  HostPresenceTone | "busy" | "update-info" | "update-warn" | "update-danger";

function updatePillTone(tone: HostUpdatePillTone): PillTone {
  if (tone === "info") return "update-info";
  if (tone === "warn") return "update-warn";
  return "update-danger";
}

interface StatusPillProps {
  readonly tone: PillTone;
  readonly label: string;
  readonly showDot: boolean;
}

function StatusPill(props: StatusPillProps) {
  const { tone, label, showDot } = props;
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 gap-1.5", PILL_CLASS[tone])}
    >
      {showDot ? (
        <span className={cn("size-1.5 rounded-full", DOT_CLASS[tone])} />
      ) : null}
      {label}
    </Badge>
  );
}

// Tone → text/border/background. Grey for anything without a live signal so a
// green dot never renders without a fresh lease behind it.
const PILL_CLASS: Record<PillTone, string> = {
  online:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "likely-reachable":
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "tunnel-down":
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "connection-issue":
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  offline: "border-border bg-muted/40 text-muted-foreground",
  unknown:
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "client-offline": "border-border bg-muted/40 text-muted-foreground",
  busy: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  "update-info":
    "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  "update-warn":
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "update-danger": "border-destructive/30 bg-destructive/10 text-destructive",
};

const DOT_CLASS: Record<PillTone, string> = {
  online: "bg-emerald-500",
  "likely-reachable": "bg-emerald-500",
  "tunnel-down": "bg-amber-500",
  "connection-issue": "bg-amber-500",
  offline: "bg-muted-foreground",
  unknown: "bg-amber-500",
  "client-offline": "bg-sky-500",
  busy: "bg-sky-500",
  "update-info": "bg-sky-500",
  "update-warn": "bg-amber-500",
  "update-danger": "bg-destructive",
};

/**
 * "Add host" affordance (Journey 1). The app can't reach onto a box it isn't
 * running on, so this is purely the enroll instructions: install the host
 * (which registers it as a service) and log in. The host auto-registers over
 * the authenticated session and appears in this list on the next ~15s poll.
 */
function AddHostDialog() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" data-testid="my-hosts-add">
          <Plus className="size-4" />
          Add host
        </Button>
      </DialogTrigger>
      <DialogContent
        className="w-[min(92vw,34rem)]"
        data-testid="my-hosts-add-dialog"
      >
        <DialogHeader>
          <DialogTitle>Add a host</DialogTitle>
          <DialogDescription>
            Run these on the machine you want to reach. It&apos;ll appear here
            automatically once it registers.
          </DialogDescription>
        </DialogHeader>
        <ol className="flex flex-col gap-3 text-ui-sm">
          <li className="flex flex-col gap-2">
            <span>
              Install the host (registers it as a service), then log in:
            </span>
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-code-xs text-foreground">
              curl -fsSL traycer.ai/install | sh{"\n"}traycer login
            </pre>
          </li>
          <li>Approve the login in the browser that opens.</li>
          <li>
            Done — the host registers itself and appears above. Updates stay
            your choice.
          </li>
        </ol>
        <p className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-ui-xs text-muted-foreground">
          <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
          Waiting for a new host to come online…
        </p>
      </DialogContent>
    </Dialog>
  );
}
