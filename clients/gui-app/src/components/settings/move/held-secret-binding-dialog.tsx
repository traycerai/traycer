/**
 * Keep as a secret: Add-secret's binding (kind, protocol, hosts, port, swap
 * sites, gateway consent) with no value field. The held ciphertext is already
 * on the broker.
 */
import { useState, type ReactNode } from "react";
import type { EnvironmentReviewHeldApplyRequest } from "@traycer/protocol/host/environment-schemas";
import {
  SANDBOX_SECRET_SWAP_SITES,
  isSandboxDatabaseEngine,
  sandboxDatabaseConsentCopy,
  type SandboxRouteProtocol,
  type SandboxSecretSwapSite,
} from "@traycer/protocol/host/secret-intake-catalogue";
import {
  heldSecretApplyRequest,
  heldSecretBindingProblem,
} from "@/components/settings/move/held-secret-binding";
import { KEEP_AS_SECRET } from "@/components/settings/move/retrospective-copy";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DESKTOP_SECRET_KINDS,
  SECRET_KIND_LABEL,
  SECRET_PROTOCOL_LABEL,
  secretKindHint,
  secretKindProtocols,
  secretKindUnsupportedReason,
} from "@/lib/sandboxes/secret-intake-copy";
import {
  initialSecretForm,
  withSecretProtocol,
  type SecretFormState,
} from "@/lib/sandboxes/secret-intake-form";

const SWAP_SITE_LABEL: Readonly<Record<SandboxSecretSwapSite, string>> = {
  header: "Header",
  query: "Query string",
  body: "Body",
};

type HeldSecretApplyRequest = Extract<
  EnvironmentReviewHeldApplyRequest,
  { choice: "secret" }
>;

export function HeldSecretBindingDialog(props: {
  readonly open: boolean;
  readonly heldId: string;
  readonly heldName: string;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onApply: (request: HeldSecretApplyRequest) => void;
}): ReactNode {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? (
        <HeldSecretBindingBody
          heldId={props.heldId}
          heldName={props.heldName}
          pending={props.pending}
          onOpenChange={props.onOpenChange}
          onApply={props.onApply}
        />
      ) : null}
    </Dialog>
  );
}

function HeldSecretBindingBody(props: {
  readonly heldId: string;
  readonly heldName: string;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onApply: (request: HeldSecretApplyRequest) => void;
}): ReactNode {
  const [form, setForm] = useState<SecretFormState>(() =>
    initialSecretForm("api_key"),
  );
  const problem = heldSecretBindingProblem(form);
  const protocols = secretKindProtocols(form.kind);
  const engine: SandboxRouteProtocol = form.protocol;
  const showConsent =
    form.mode === "brokered" && isSandboxDatabaseEngine(engine);

  return (
    <DialogContent
      layout="banded"
      className="flex max-h-[min(85dvh,44rem)] w-[min(92vw,40rem)] flex-col overflow-hidden sm:max-w-none"
      data-testid="held-secret-binding"
    >
      <DialogHeader>
        <DialogTitle>{KEEP_AS_SECRET}</DialogTitle>
        <DialogDescription>
          Where {props.heldName} goes and how agents use it. The value is
          already held; it is not typed again.
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="held-secret-kind">Kind</Label>
          <Select
            value={form.kind}
            onValueChange={(value) => {
              const next = DESKTOP_SECRET_KINDS.find((kind) => kind === value);
              if (next !== undefined) setForm(initialSecretForm(next));
            }}
          >
            <SelectTrigger
              id="held-secret-kind"
              size="sm"
              className="w-full"
              data-testid="held-secret-kind"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DESKTOP_SECRET_KINDS.map((kind) => {
                const unsupported = secretKindUnsupportedReason(kind);
                return (
                  <SelectItem
                    key={kind}
                    value={kind}
                    disabled={unsupported !== null}
                  >
                    {SECRET_KIND_LABEL[kind]}
                    {unsupported === null
                      ? ` · ${secretKindHint(kind)}`
                      : ` · ${unsupported}`}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
        {protocols.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="held-secret-protocol">Protocol</Label>
            <Select
              value={form.protocol}
              onValueChange={(value) => {
                const next = protocols.find((protocol) => protocol === value);
                if (next !== undefined) {
                  setForm(withSecretProtocol(form, next));
                }
              }}
            >
              <SelectTrigger
                id="held-secret-protocol"
                size="sm"
                className="w-full"
                data-testid="secret-form-protocol"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {protocols.map((protocol) => (
                  <SelectItem key={protocol} value={protocol}>
                    {SECRET_PROTOCOL_LABEL[protocol]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,8rem)]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="held-secret-hosts">Host</Label>
            <Input
              id="held-secret-hosts"
              value={form.hosts}
              placeholder={
                form.kind === "database" ? "db.example.com" : "api.example.com"
              }
              onChange={(event) =>
                setForm({ ...form, hosts: event.currentTarget.value })
              }
              data-testid="secret-form-hosts"
            />
            <p className="text-ui-xs text-muted-foreground">
              Separate several hosts with commas.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="held-secret-port">Port</Label>
            <Input
              id="held-secret-port"
              inputMode="numeric"
              value={form.port}
              placeholder="Default"
              onChange={(event) =>
                setForm({ ...form, port: event.currentTarget.value })
              }
              data-testid="secret-form-port"
            />
          </div>
        </div>
        {form.kind === "api_key" ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-ui-sm font-medium">
              Where the key appears in a request
            </legend>
            <div className="flex flex-wrap gap-4">
              {SANDBOX_SECRET_SWAP_SITES.map((site) => (
                <div key={site} className="flex items-center gap-2 text-ui-sm">
                  <Checkbox
                    id={`held-secret-swap-${site}`}
                    checked={form.swapSites.includes(site)}
                    onCheckedChange={(checked) => {
                      const sites =
                        checked === true
                          ? [...form.swapSites, site]
                          : form.swapSites.filter((entry) => entry !== site);
                      setForm({
                        ...form,
                        swapSites: SANDBOX_SECRET_SWAP_SITES.filter((entry) =>
                          sites.includes(entry),
                        ),
                      });
                    }}
                    data-testid={`secret-form-swap-${site}`}
                  />
                  <Label htmlFor={`held-secret-swap-${site}`}>
                    {SWAP_SITE_LABEL[site]}
                  </Label>
                </div>
              ))}
            </div>
          </fieldset>
        ) : null}
        {showConsent ? (
          <div
            className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-ui-sm text-warning-foreground"
            data-testid="secret-form-consent"
          >
            {sandboxDatabaseConsentCopy(engine).map((line) => (
              <p key={line} className="max-w-[72ch]">
                {line}
              </p>
            ))}
            <div className="flex items-center gap-2">
              <Checkbox
                id="held-secret-consent"
                checked={form.plaintextConsent}
                onCheckedChange={(checked) =>
                  setForm({ ...form, plaintextConsent: checked === true })
                }
                data-testid="secret-form-consent-check"
              />
              <Label htmlFor="held-secret-consent">I understand</Label>
            </div>
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.pending}
          onClick={() => props.onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={problem !== null || props.pending}
          data-testid="held-secret-apply"
          onClick={() =>
            props.onApply(heldSecretApplyRequest(props.heldId, form))
          }
        >
          {KEEP_AS_SECRET}
          {props.pending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : null}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
