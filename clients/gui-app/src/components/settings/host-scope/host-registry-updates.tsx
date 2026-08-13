import { useState, type ReactNode } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type {
  HostVersionPolicyResult,
  UpdateHostVersionPolicyInput,
} from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useUpdateHostVersionPolicy } from "@/hooks/auth/use-update-host-version-mutation";
import {
  deriveUpdateAffordance,
  deriveUpdatePill,
  isValidHostVersion,
} from "@/components/settings/panels/my-hosts-model";

type UpdateHostVersionPolicyMutation = UseMutationResult<
  HostVersionPolicyResult,
  Error,
  UpdateHostVersionPolicyInput
>;

/**
 * The registry-backed half of a host's update story: the auto-update policy,
 * a target-version pin, and — only while the host is genuinely gated on open
 * sessions — the drain-gate force.
 *
 * These three used to live on a separate "My Hosts" list, one row per host.
 * That list was the reason host management had two homes, because a row that
 * can change a host's update policy is a lifecycle surface no matter what it
 * is called. They now render inside the Updates region of the ONE page about
 * that host, beside the local controller's own check-now/apply controls.
 *
 * Works without a live session on purpose: the policy is stored in the
 * account's host registry and the host reads it on its next check-in, which is
 * what keeps an offline host's Overview useful instead of blank.
 *
 * All controls share one mutation instance so concurrent writes to the same
 * host serialize rather than race.
 */
export function HostRegistryUpdates(props: {
  readonly item: HostListItem;
}): ReactNode {
  const { item } = props;
  const mutation = useUpdateHostVersionPolicy(item.hostId);
  const affordance = deriveUpdateAffordance(item.status);
  const pill = deriveUpdatePill(item.status.updateState);
  const isAuto = item.updatePolicy === "auto";

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/40 px-5 py-3">
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
          data-testid={`host-auto-update-${item.hostId}`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-ui-sm text-foreground">Auto-update</p>
          {/* ONE sentence, both vantages. This used to fork on `isLocalHost`,
              saying "Installs new versions when no sessions are running."
              locally — which was fiction. The pin is applied by the HOST's own
              update reconciler, on its own independent ~20s poll, reading the
              coordination snapshot its check-in populates
              (`update-reconciler.ts` — no locality branch anywhere in it). The
              local machine's CLI controller is a different mechanism entirely:
              it backs the MANUAL apply button, not this policy. The fork
              therefore described a path that does not exist, omitted the
              latency that does, and — because the two variants render the same
              component — made the Overview visibly differ for local and remote
              hosts on a page whose whole premise is that it does not. */}
          <p className="text-ui-xs text-muted-foreground">
            Applied on this host&apos;s next check-in (~20s), when no sessions
            are running.
          </p>
        </div>
        {pill === null ? null : (
          <span
            className="shrink-0 rounded-sm bg-muted/70 px-1.5 py-px text-ui-xs text-muted-foreground"
            data-testid={`host-update-pill-${item.hostId}`}
          >
            {pill.label}
          </span>
        )}
        {/* `deriveUpdateAffordance` withholds this while the host is `pending`
            or `updating` — draining sessions, or mid-swap. `MyHostsList`
            honoured that flag; this rendered the control unconditionally and
            left `showUpdateNowInput` computed and unread, so a second
            desired-version write could retarget an update already in flight. */}
        {affordance.showUpdateNowInput ? (
          <UpdateNowControl hostId={item.hostId} mutation={mutation} />
        ) : null}
      </div>
      {affordance.applyNowLabel === null ? null : (
        <div className="flex flex-wrap items-center gap-3 border-t border-border/40 px-5 py-3">
          <p className="min-w-0 flex-1 text-ui-sm text-muted-foreground">
            {affordance.waitingForSessionsLabel ??
              "Waiting for open sessions before applying."}
          </p>
          <ApplyNowControl
            hostId={item.hostId}
            label={affordance.applyNowLabel}
            mutation={mutation}
          />
        </div>
      )}
    </>
  );
}

/**
 * "Update to version…": a small popover collecting the target version,
 * validated client-side against the same dotted-numeric pattern authn-v3's
 * `PATCH /api/v3/hosts/:hostId` enforces server-side (`isValidHostVersion`).
 * There is no "latest release catalog" surfaced to the client, so the input is
 * a plain text field rather than a version picker.
 */
function UpdateNowControl(props: {
  readonly hostId: string;
  readonly mutation: UpdateHostVersionPolicyMutation;
}): ReactNode {
  const { hostId, mutation } = props;
  // Same arm-time capture as the drain-gate force below. A version draft typed
  // for host B must never submit against host C because the scope moved while
  // the popover was open — pinning a version is not destructive, but it is
  // still a write aimed at a named host.
  const [armedHostId, setArmedHostId] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  const open = armedHostId !== null;
  const targetMoved = armedHostId !== null && armedHostId !== hostId;
  const trimmed = version.trim();
  const showInvalid = trimmed.length > 0 && !isValidHostVersion(trimmed);
  const canSubmit =
    trimmed.length > 0 && isValidHostVersion(trimmed) && !targetMoved;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setArmedHostId(next ? hostId : null);
        if (!next) setVersion("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={mutation.isPending}
          data-testid={`host-update-version-trigger-${hostId}`}
        >
          Update to version…
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(85vw,16rem)]"
        align="end"
        data-testid={`host-update-version-popover-${hostId}`}
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
            if (!canSubmit) return;
            mutation.mutate(
              {
                updatePolicy: undefined,
                desiredVersion: trimmed,
                force: undefined,
              },
              {
                onSuccess: () => {
                  setArmedHostId(null);
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
            data-testid={`host-update-version-input-${hostId}`}
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
            data-testid={`host-update-version-submit-${hostId}`}
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

/**
 * "Apply now — ends N sessions" (the drain-gate force): bypasses waiting for
 * open sessions on the CURRENTLY pending update. This is destructive (it ends
 * N open terminal/agent sessions), so it always requires an explicit
 * confirmation through the same `ConfirmDestructiveDialog` this codebase uses
 * for other disruptive host actions — never a casual one-click.
 */
function ApplyNowControl(props: {
  readonly hostId: string;
  readonly label: string;
  readonly mutation: UpdateHostVersionPolicyMutation;
}): ReactNode {
  const { hostId, label, mutation } = props;
  // The TARGET is captured when the dialog is armed, not read when it is
  // confirmed.
  //
  // Only `open` used to live here while `hostId` and `mutation` arrived as
  // props that rebind on every render. Anything that moved the scoped host
  // while this dialog stood open — a switcher pick, or the active host
  // changing from another window — slid a new host underneath it, and
  // confirming then ended the sessions of a host the dialog never named. The
  // copy says "this host"; this is what makes that true.
  const [armedHostId, setArmedHostId] = useState<string | null>(null);
  const open = armedHostId !== null;
  const targetMoved = armedHostId !== null && armedHostId !== hostId;

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => setArmedHostId(hostId)}
        disabled={mutation.isPending}
        data-testid={`host-apply-now-trigger-${hostId}`}
      >
        {label}
      </Button>
      <ConfirmDestructiveDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setArmedHostId(null);
        }}
        title="Apply the update now?"
        description={
          targetMoved
            ? "The host this was aimed at is no longer the one selected. Close this and try again on the host you mean."
            : "This ends every open terminal and agent session on this host so the update can apply immediately. Sessions can be reopened once the host is back."
        }
        cascadeSummary={null}
        actionLabel="Apply now"
        isPending={mutation.isPending}
        onConfirm={() => {
          // Refuse rather than retarget. A destructive action whose subject
          // changed after it was armed has no safe interpretation.
          if (targetMoved) return;
          mutation.mutate(
            { updatePolicy: undefined, desiredVersion: undefined, force: true },
            { onSuccess: () => setArmedHostId(null) },
          );
        }}
      />
    </>
  );
}
