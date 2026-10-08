import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type {
  SandboxHourlyPrice,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import type { HostScopeSandbox } from "@/components/settings/host-scope/host-scope-model";
import { sandboxStateWord } from "@/components/settings/host-scope/host-option-model";
import { useSandboxDestroy } from "@/hooks/sandboxes/use-sandbox-destroy-mutation";
import { formatCredits, formatMemory } from "@/lib/sandboxes/sandbox-pricing";

/**
 * The card a sandbox host shows above its identity card in Settings: its
 * state, shape, region and rate, and the actions its state allows.
 *
 * Stage 1 draws four states as themselves - Creating, Awake, Destroyed,
 * Failed - which are the only ones a stage-1 server produces. Any other state
 * still renders, as its state word, with no copy of its own and no action.
 */
export function SandboxCard(props: {
  readonly hostName: string;
  readonly sandbox: HostScopeSandbox;
}): ReactNode {
  const { summary } = props.sandbox;
  const state = props.sandbox.state ?? summary?.state ?? null;
  const word = sandboxStateWord(props.sandbox);
  return (
    <Card size="sm" data-testid="sandbox-card" data-state={state ?? "unknown"}>
      <CardHeader>
        <CardTitle>{summary?.displayName ?? props.hostName}</CardTitle>
        <CardDescription>{sandboxStateLine(state, summary)}</CardDescription>
        {word === null ? null : (
          <CardAction>
            <Badge
              variant={stateBadgeVariant(state)}
              data-testid="sandbox-card-state"
            >
              {capitalize(word)}
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {summary === null ? (
          <p className="text-ui-xs text-muted-foreground">
            Loading this sandbox&apos;s details…
          </p>
        ) : (
          <SandboxFacts summary={summary} />
        )}
        <SandboxSecretsSummarySlot />
      </CardContent>
      {summary !== null && canDestroy(state) ? (
        <CardFooter>
          <SandboxDestroyAction
            sandboxId={summary.id}
            name={summary.displayName}
          />
        </CardFooter>
      ) : null}
    </Card>
  );
}

function SandboxFacts(props: { readonly summary: SandboxSummary }): ReactNode {
  const { summary } = props;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-xs">
      <dt className="text-muted-foreground">Size</dt>
      <dd data-testid="sandbox-card-shape">
        {formatShape(summary.cpus, summary.memoryMb, summary.diskMb)}
      </dd>
      <dt className="text-muted-foreground">Region</dt>
      <dd data-testid="sandbox-card-region">{summary.region}</dd>
      <dt className="text-muted-foreground">Rate</dt>
      <dd data-testid="sandbox-card-rate">
        {formatRate(summary.priceMcPerHour)}
      </dd>
      {summary.burst ? (
        <>
          <dt className="text-muted-foreground">Created by</dt>
          <dd>An agent, for one task</dd>
        </>
      ) : null}
    </dl>
  );
}

/**
 * The named slot the secrets summary (the secrets this sandbox may use, their
 * destinations and their mode) renders into. Empty in this release; the
 * secrets track fills it, here and nowhere else on the card.
 */
function SandboxSecretsSummarySlot(): ReactNode {
  return null;
}

function SandboxDestroyAction(props: {
  readonly sandboxId: string;
  readonly name: string;
}): ReactNode {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const destroy = useSandboxDestroy(props.sandboxId);
  return (
    <>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={destroy.isPending}
        data-testid="sandbox-card-destroy"
        onClick={() => setConfirmOpen(true)}
      >
        {destroy.isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId="sandbox-card-destroy-spinner"
            variant={undefined}
          />
        ) : null}
        Destroy
      </Button>
      <ConfirmDestructiveDialog
        blockedReason={null}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Destroy ${props.name}?`}
        description={`${props.name} and its disk are deleted and can't be recovered. Code on a sandbox is not synced anywhere, so copy off anything you want to keep first.`}
        cascadeSummary={null}
        actionLabel="Destroy sandbox"
        isPending={destroy.isPending}
        onConfirm={() => {
          destroy.mutate(undefined, {
            onSuccess: () => {
              setConfirmOpen(false);
              toast.success(`Destroyed ${props.name}`);
            },
          });
        }}
      />
    </>
  );
}

/** Destroy is offered where the server accepts it: from a settled state. */
function canDestroy(state: HostSandboxState | null): boolean {
  return (
    state === "awake" ||
    state === "failed" ||
    state === "suspended" ||
    state === "stopped"
  );
}

function sandboxStateLine(
  state: HostSandboxState | null,
  summary: SandboxSummary | null,
): string {
  switch (state) {
    case "creating":
      return "Provisioning and booting. This takes about 10 seconds once capacity is found.";
    case "awake":
      return "Running. Billed at the awake rate.";
    case "destroying":
    case "destroyed":
      return "Destroyed. Its disk is gone and nothing more is billed.";
    case "failed":
      return summary?.failureCode === null || summary === null
        ? "Failed to start. Nothing is billed for a sandbox that never woke."
        : `Failed to start (${summary.failureCode}). Nothing is billed for a sandbox that never woke.`;
    default:
      return "Sandbox";
  }
}

function stateBadgeVariant(
  state: HostSandboxState | null,
): "success" | "info" | "destructive" | "muted" {
  if (state === "awake") return "success";
  if (state === "creating") return "info";
  if (state === "failed") return "destructive";
  return "muted";
}

function formatShape(cpus: number, memoryMb: number, diskMb: number): string {
  const vcpu = `${cpus} vCPU`;
  return diskMb > 0
    ? `${vcpu} · ${formatMemory(memoryMb)} memory · ${formatMemory(diskMb)} disk`
    : `${vcpu} · ${formatMemory(memoryMb)} memory`;
}

function formatRate(price: SandboxHourlyPrice | null): string {
  if (price === null) return "Not priced here";
  return `${formatCredits(price.awakeMc)} credits/hour awake · ${formatCredits(price.suspendedMc)} suspended · ${formatCredits(price.stoppedMc)} stopped`;
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}
