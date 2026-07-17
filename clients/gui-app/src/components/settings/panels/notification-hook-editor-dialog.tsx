import { useState } from "react";
import type { NotificationHookConfig } from "@traycer/protocol/host/notifications/host-notifications";
import {
  draftProblem,
  draftToHook,
  HOOK_SEVERITIES,
  type HookDraft,
} from "@/components/settings/panels/notification-hook-draft";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export function NotificationHookEditorDialog(props: {
  readonly initialDraft: HookDraft;
  readonly title: string;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: (hook: NotificationHookConfig) => void;
}) {
  const [draft, setDraft] = useState(props.initialDraft);
  const problem = draftProblem(draft);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogContent className="max-h-[min(85vh,52rem)] w-[min(92vw,42rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>
            Runs on notifications of the selected severities. The payload names
            the exact event, so a script or endpoint can branch further.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="hook-name">Name</Label>
              <Input
                id="hook-name"
                value={draft.name}
                placeholder="Slack alerts"
                onChange={(event) => {
                  const name = event.target.value;
                  setDraft((previous) => ({ ...previous, name }));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="hook-type">Action</Label>
              <Select
                value={draft.actionType}
                onValueChange={(value) => {
                  setDraft((previous) => ({
                    ...previous,
                    actionType: value === "http" ? "http" : "command",
                  }));
                }}
              >
                <SelectTrigger id="hook-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="command">Run a script</SelectItem>
                  <SelectItem value="http">POST to a URL</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {draft.actionType === "http" ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="hook-url">URL</Label>
                <Input
                  id="hook-url"
                  value={draft.url}
                  placeholder="https://hooks.example.com/traycer"
                  onChange={(event) => {
                    const url = event.target.value;
                    setDraft((previous) => ({ ...previous, url }));
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="hook-headers">Headers</Label>
                <Textarea
                  id="hook-headers"
                  value={draft.headersText}
                  rows={3}
                  placeholder={"authorization: Bearer $MY_TOKEN"}
                  className="font-mono text-ui-xs"
                  onChange={(event) => {
                    const headersText = event.target.value;
                    setDraft((previous) => ({ ...previous, headersText }));
                  }}
                />
                <p className="text-ui-xs text-muted-foreground">
                  One <code>name: value</code> per line. <code>$VAR</code> and{" "}
                  <code>{"${VAR}"}</code> read the host&apos;s shell environment
                  at send time — the value is never stored or shown here.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="hook-command">Executable</Label>
                <Input
                  id="hook-command"
                  value={draft.command}
                  placeholder="/usr/local/bin/notify"
                  className="font-mono text-ui-xs"
                  onChange={(event) => {
                    const command = event.target.value;
                    setDraft((previous) => ({ ...previous, command }));
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="hook-args">Arguments</Label>
                <Textarea
                  id="hook-args"
                  value={draft.argsText}
                  rows={2}
                  placeholder={"--channel\nbuilds"}
                  className="font-mono text-ui-xs"
                  onChange={(event) => {
                    const argsText = event.target.value;
                    setDraft((previous) => ({ ...previous, argsText }));
                  }}
                />
                <p className="text-ui-xs text-muted-foreground">
                  One argument per line. Run directly (no shell); the event JSON
                  arrives on stdin.
                </p>
              </div>
            </div>
          )}

          <fieldset className="space-y-2">
            <legend className="text-ui-sm font-medium text-foreground">
              Severities
            </legend>
            <div className="overflow-hidden rounded-md border border-border/60">
              {HOOK_SEVERITIES.map((severity) => (
                <div
                  key={severity.id}
                  className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-3 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="text-ui-sm font-medium text-foreground">
                      {severity.label}
                    </div>
                    <p className="mt-1 text-ui-xs text-muted-foreground">
                      {severity.description}
                    </p>
                  </div>
                  <Switch
                    checked={draft.severities.includes(severity.id)}
                    aria-label={`${severity.label} hook deliveries`}
                    onCheckedChange={(checked) => {
                      setDraft((previous) => ({
                        ...previous,
                        severities: checked
                          ? [...previous.severities, severity.id]
                          : previous.severities.filter(
                              (id) => id !== severity.id,
                            ),
                      }));
                    }}
                  />
                </div>
              ))}
            </div>
          </fieldset>

          <div className="flex items-center gap-3 text-ui-sm text-foreground">
            <Switch
              id="hook-enabled"
              checked={draft.enabled}
              onCheckedChange={(enabled) => {
                setDraft((previous) => ({ ...previous, enabled }));
              }}
            />
            <Label htmlFor="hook-enabled">Enabled</Label>
          </div>
        </div>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-ui-xs text-destructive">{problem ?? ""}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={props.onCancel}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={problem !== null || props.saving}
              onClick={() => {
                props.onSave(draftToHook(draft));
              }}
            >
              {props.saving ? (
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant={undefined}
                />
              ) : null}
              Save hook
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
