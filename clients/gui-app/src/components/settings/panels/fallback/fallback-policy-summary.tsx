import type { ReactNode } from "react";
import type { FallbackPolicy } from "@traycer/protocol/host/fallback-policy";

/**
 * A model routing policy read out rather than edited: every setting it holds,
 * in the order the editor presents them.
 *
 * Two surfaces show a policy nobody on that page may change, and they must
 * read the same: a team's page to a viewer, and the host page of a computer
 * the team owns. The surrounding sentence differs (a viewer is told they
 * cannot edit, a member is told where the routing is set) and so do the facts
 * beside it, which is what `accounts` carries: the team's page names the
 * team's linked accounts among the settings, and a host page, which holds no
 * such fact about the team, passes `null` rather than a line it cannot stand
 * behind.
 *
 * Every field of the policy is read out, `reasonOverrides` and the default
 * tier included. What the editor has and this does not is actions and live
 * readings about the reader's OWN turns - the master toggle, the Test panel,
 * per-row provider previews, the Danger Zone, the in-flight count - none of
 * which are facts about the policy.
 */
export function FallbackPolicySummary(props: {
  readonly policy: FallbackPolicy;
  /** Rendered among the settings, where the team's page has always put it. */
  readonly accounts: ReactNode | null;
}): ReactNode {
  const policy = props.policy;
  return (
    <>
      <p>Route automatically: {policy.enabled ? "On" : "Off"}</p>
      <p>Try these in order: {policy.ladder.join(" → ")}</p>
      <p>
        Time to cancel: {policy.graceWindowSeconds} seconds. Maximum wait:{" "}
        {policy.maxWaitMinutes} minutes.
      </p>
      <p>Return to preferred: {policy.returnToPreferred}.</p>
      {props.accounts}
      {policy.tierGroups.map((group) => (
        <div key={group.id}>
          <h3 className="font-medium">{group.id}</h3>
          {group.candidates.map((candidate) => (
            <p
              key={`${candidate.harnessId}:${candidate.modelFamily}:${candidate.reasoningEffort}`}
            >
              {/* `null` is a real choice - no effort constraint - and the
                  editor's own control calls it "Any effort". Rendering the
                  raw value left a row ending in a bare separator, which read
                  as a value that failed to load rather than as the setting it
                  is. Worded as the control words it, so the read-out and the
                  control are one statement. */}
              {candidate.harnessId} · {candidate.modelFamily} ·{" "}
              {candidate.reasoningEffort ?? "Any effort"}
            </p>
          ))}
        </div>
      ))}
      {/* The tier the groups above do not answer for. Two policies with the
          same groups and different defaults route a model in no group
          differently (`routeTierGroupForFailedTuple`), so a read-out without
          this one cannot say what happens to such a model - and a reader on a
          team computer has no other way to see it. Worded as the editor words
          it, so the read-out and the control are one statement. */}
      <p>
        For a model not in any tier:{" "}
        {policy.defaultTierGroupId ?? "None - skip this step"}
      </p>
      {Object.entries(policy.reasonOverrides ?? {}).map(([reason, value]) => (
        <p key={reason}>
          {reason}: {value === "off" ? "Off" : value.join(" → ")}
        </p>
      ))}
    </>
  );
}
