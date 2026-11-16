import { useId, type ReactNode } from "react";
import type { ReviewHeldEntry } from "@traycer-clients/shared/environment/environment-review";
import type { TeamReviewValue } from "@/components/settings/move/team-review-values";
import { heldCommandLine } from "@/components/settings/move/held-from-review";
import { PackPolicyReadout } from "@/components/settings/environment/team-provider-items";
import { FallbackPolicySummary } from "@/components/settings/panels/fallback/fallback-policy-summary";
import { harnessLabel } from "@/components/settings/panels/fallback/fallback-harness-label";
import { TeamReadFailed } from "@/components/settings/environment/team-read-failed";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";

/** A validated public value only; never an editor, host read or raw JSON. */
export function TeamReviewValueReadout(props: {
  readonly entry: ReviewHeldEntry;
  readonly value: TeamReviewValue | null;
  readonly onRetry: () => void;
}): ReactNode {
  const id = useId();
  const value = props.value;
  if (value === null) {
    const line = heldCommandLine({ ...props.entry, op: "delete" });
    return (
      <p>
        {line.name} {line.clause}
      </p>
    );
  }
  switch (value.kind) {
    case "unreadable":
      return (
        <TeamReadFailed
          message="Couldn't read these settings."
          onRetry={props.onRetry}
        />
      );
    case "facts": {
      const line = heldCommandLine({
        ...props.entry,
        ...value.facts,
        op: "put",
      });
      return <p>{line.clause}</p>;
    }
    case "text":
      return (
        <Textarea
          aria-label={`${props.entry.key} text`}
          value={value.text}
          readOnly
        />
      );
    case "pack":
      return (
        <PackPolicyReadout
          packId={props.entry.key}
          pinnedVersion={value.pinnedVersion}
          autoDownload={value.autoDownload}
        />
      );
    case "fallback":
      return (
        <FallbackPolicySummary
          policy={value.policy}
          accounts={null}
          tierLabels={value.tierLabels}
        />
      );
    case "profile":
      return (
        <div className="flex flex-col gap-2">
          <label
            htmlFor={`${id}-name`}
            className="flex flex-col gap-1 text-ui-sm"
          >
            Profile name
            <Input id={`${id}-name`} value={value.name} readOnly />
          </label>
          <label
            htmlFor={`${id}-color`}
            className="flex flex-col gap-1 text-ui-sm"
          >
            Accent color
            <Input id={`${id}-color`} value={value.color ?? "None"} readOnly />
          </label>
          <p>
            {harnessLabel(value.harnessId)} · {value.enabled ? "On" : "Off"}
          </p>
          {value.accountIdentity === null ? null : (
            <p>{value.accountIdentity}</p>
          )}
          <label
            htmlFor={`${id}-needs-link`}
            className="flex items-center gap-2 text-ui-sm"
          >
            Needs a sign-in
            <Switch
              id={`${id}-needs-link`}
              aria-label="Needs a sign-in"
              checked={value.needsLink}
              disabled
            />
          </label>
        </div>
      );
    case "mcp":
      return (
        <div className="flex flex-col gap-2">
          {value.reference === null ? null : (
            <p>
              MCP server: <span className="font-mono">{value.reference}</span>
            </p>
          )}
          {value.command === null ? null : (
            <p className="font-mono">{value.command}</p>
          )}
          {value.groups.map((group) => (
            <div key={group.id} className="flex flex-col gap-1">
              <p className="font-medium">{harnessLabel(group.harness)}</p>
              {group.tools.map((tool) => (
                <label
                  key={tool.id}
                  htmlFor={`${id}-${group.id}-${tool.id}`}
                  className="flex items-center justify-between gap-3 text-ui-sm"
                >
                  {tool.name}
                  <Switch
                    id={`${id}-${group.id}-${tool.id}`}
                    aria-label={`${group.harness} ${tool.name}`}
                    checked={tool.enabled}
                    disabled
                  />
                </label>
              ))}
            </div>
          ))}
          <p>
            Off:{" "}
            {value.offFor.length === 0
              ? "None"
              : value.offFor.map(harnessLabel).join(" · ")}
          </p>
        </div>
      );
  }
}
