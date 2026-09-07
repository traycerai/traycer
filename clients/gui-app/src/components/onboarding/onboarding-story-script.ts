import { useEffect, useState } from "react";

/** The lesson is the story, so the two platforms must not fork it - the beats, the display names and the
 * cadence live here and are imported by both. */

export type MeshAgentId = "gui" | "claude" | "opencode";

export const PANE_LABEL: Record<MeshAgentId, string> = {
  gui: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
};

export type StoryKind =
  | "user"
  | "chat"
  | "spec"
  | "handoff"
  | "term"
  | "blocked"
  | "msg"
  | "decision";

// The rate-limits collaboration: Codex initiates, Claude gets blocked and asks OpenCode, OpenCode answers,
// Codex records the decision, Claude resumes.
export const STORY_STEPS = [
  {
    pane: "gui",
    kind: "user",
    text: "We need team usage limits without locking existing customers out.",
    to: null,
  },
  {
    pane: "gui",
    kind: "chat",
    text: "I'll split this into implementation, verification, and risk review.",
    to: null,
  },
  { pane: "gui", kind: "spec", text: "usage-limits.spec", to: null },
  {
    pane: "gui",
    kind: "handoff",
    text: "Claude Code, implement the billing-service check from usage-limits.spec.",
    to: "claude",
  },
  { pane: "claude", kind: "term", text: "reading usage-limits.spec", to: null },
  {
    pane: "claude",
    kind: "blocked",
    text: "background jobs may bypass API checks",
    to: null,
  },
  {
    pane: "claude",
    kind: "handoff",
    text: "OpenCode, verify where usage is consumed outside the API path.",
    to: "opencode",
  },
  {
    pane: "opencode",
    kind: "msg",
    text: "Tracing usage paths across the billing service…",
    to: null,
  },
  {
    pane: "opencode",
    kind: "msg",
    text: "Found 2 paths: API + scheduled sync. Enforcement must live below both.",
    to: "claude",
  },
  {
    pane: "claude",
    kind: "handoff",
    text: "Codex, both paths skip the API layer — where should enforcement live?",
    to: "gui",
  },
  {
    pane: "gui",
    kind: "decision",
    text: "Enforce in the billing service, not the API route. Keep a grace period for existing teams.",
    to: null,
  },
  {
    pane: "gui",
    kind: "handoff",
    text: "Claude, move the check down and add the grace-period branch.",
    to: "claude",
  },
  {
    pane: "claude",
    kind: "term",
    text: "moved check to billing service",
    to: null,
  },
  { pane: "claude", kind: "term", text: "added grace-period branch", to: null },
  { pane: "claude", kind: "term", text: "tests passing", to: null },
  {
    pane: "claude",
    kind: "handoff",
    text: "OpenCode, re-verify both paths now.",
    to: "opencode",
  },
  {
    pane: "opencode",
    kind: "msg",
    text: "Verified API + scheduled sync paths. No bypass found.",
    to: "gui",
  },
  {
    pane: "gui",
    kind: "chat",
    text: "Shipping with the grace period — thanks, both.",
    to: null,
  },
] as const satisfies ReadonlyArray<{
  readonly pane: MeshAgentId;
  readonly kind: StoryKind;
  readonly text: string;
  readonly to: MeshAgentId | null;
}>;

export type StoryBeat = (typeof STORY_STEPS)[number];

// Hold longer on the final beat before looping, and longer on message-passing
// beats (a directional pill is travelling) so the flow is easy to follow.
export function storyStepDuration(step: number, last: number): number {
  if (step >= last) return 3200;
  if (STORY_STEPS[step].to !== null) return 2800;
  return 1900;
}

/** `active` is the caller's "my story scene is on screen" - a boolean rather than a scene id, because the two
 * dioramas name their scenes differently. */
export function useStoryStep(active: boolean, reducedMotion: boolean): number {
  const [step, setStep] = useState(0);
  const last = STORY_STEPS.length - 1;
  const running = active && !reducedMotion;
  useEffect(() => {
    if (!running) return;
    const id = window.setTimeout(
      () => setStep((current) => (current >= last ? 0 : current + 1)),
      storyStepDuration(step, last),
    );
    return () => window.clearTimeout(id);
  }, [running, step, last]);
  if (!active) return 0;
  if (reducedMotion) return last;
  return step;
}
