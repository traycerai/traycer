import { useState } from "react";
import { basenameOfPath } from "@/lib/path";
import { resolvePrimaryPath } from "@/lib/worktree/resolve-primary-path";
import { useAuthStore } from "@/stores/auth/auth-store";
import { usePendingOrPinnedLandingWorkspace } from "@/stores/home/landing-draft-store";

const PROMPT_POOL: ReadonlyArray<string> = [
  "What should we work on?",
  "What's on your mind?",
  "Where shall we start?",
  "What's next on the list?",
  "Ready when you are.",
  "Let's ship something.",
];

function timeGreeting(hour: number): string {
  if (hour < 5) return "Burning the midnight oil";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Burning the midnight oil";
}

function pickPrompt(): string {
  const index = Math.floor(Math.random() * PROMPT_POOL.length);
  return PROMPT_POOL[index];
}

function readFirstName(userName: string): string | null {
  if (userName.includes("@")) return null;

  const firstName = userName
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)[0];

  if (firstName.length === 0) return null;
  return `${firstName[0].toUpperCase()}${firstName.slice(1)}`;
}

interface HomeHeroProps {
  readonly workspaceFolders: ReadonlyArray<string> | null;
  // The draft's raw stored primary. The folder list alone cannot name the
  // MAIN project (a main switch may leave an additional folder at index 0).
  readonly workspacePrimaryPath: string | null;
}

/** Renders the landing greeting for the active or pending main project. */
export function HomeHero({
  workspaceFolders,
  workspacePrimaryPath,
}: HomeHeroProps) {
  // Blank landing (no draft yet): the shared pending-or-pinned resolver -
  // the same snapshot the picker shows and a minted draft will start from.
  const pendingOrPinned = usePendingOrPinnedLandingWorkspace();
  const profile = useAuthStore((state) => state.profile);
  const [greeting] = useState(() => timeGreeting(new Date().getHours()));
  const [prompt] = useState(() => pickPrompt());

  // Greet with the chat's MAIN project: the draft's resolved primary, else
  // the blank landing's pending/pinned main - never array position zero.
  const projectPath =
    workspaceFolders !== null
      ? resolvePrimaryPath(workspaceFolders, workspacePrimaryPath)
      : resolvePrimaryPath(
          pendingOrPinned.folders,
          pendingOrPinned.primaryPath,
        );
  const projectName = projectPath !== null ? basenameOfPath(projectPath) : null;
  const firstName = profile === null ? null : readFirstName(profile.userName);

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <h1 className="text-display font-medium text-foreground sm:text-display">
        {greeting}
        {firstName === null ? null : `, ${firstName}`}
      </h1>
      <p className="text-ui text-muted-foreground sm:text-title-sm">
        {prompt}
        {projectName !== null ? (
          <span className="text-muted-foreground/70">
            {" "}
            in <span className="text-foreground">{projectName}</span>
          </span>
        ) : null}
      </p>
    </div>
  );
}
