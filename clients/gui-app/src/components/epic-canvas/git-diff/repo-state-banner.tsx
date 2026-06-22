import type { RepoState, RepoMode } from "@traycer/protocol/host/git-schemas";
import { Badge } from "@/components/ui/badge";

function short(sha: string, len: number): string {
  return sha.slice(0, len);
}

export interface RepoStateBannerProps {
  readonly state: Exclude<RepoState, { kind: "clean" }>;
  readonly repoMode: RepoMode | null;
  readonly conflictCount: number;
}

export function RepoStateBanner(props: RepoStateBannerProps) {
  let message: string;

  switch (props.state.kind) {
    case "merge":
      message = `Merge in progress - ${props.conflictCount} conflicts`;
      break;
    case "rebase": {
      const step = props.state.step ?? "?";
      const totalSteps = props.state.totalSteps ?? "?";
      const ontoSha = props.state.ontoSha ? short(props.state.ontoSha, 7) : "?";
      message = `Rebase in progress - step ${step}/${totalSteps} onto ${ontoSha}`;
      break;
    }
    case "cherry-pick": {
      const pickingSha = props.state.pickingSha
        ? short(props.state.pickingSha, 7)
        : "?";
      message = `Cherry-pick in progress - picking ${pickingSha}`;
      break;
    }
    case "revert": {
      const revertingSha = props.state.revertingSha
        ? short(props.state.revertingSha, 7)
        : "?";
      message = `Revert in progress - reverting ${revertingSha}`;
      break;
    }
    case "am": {
      const base = "git am in progress";
      message = props.state.patchName
        ? `${base} - ${props.state.patchName}`
        : base;
      break;
    }
    case "bisect":
      message = "Bisect in progress";
      break;
    default: {
      const exhaustiveCheck: never = props.state;
      void exhaustiveCheck;
      message = "Repository operation in progress";
      break;
    }
  }

  return (
    <div className="flex items-center gap-2 bg-yellow-50 px-3 py-2 text-ui-sm text-yellow-900 dark:bg-yellow-950 dark:text-yellow-200">
      <span className="flex-1">{message}</span>
      {props.repoMode === "degraded" && (
        <Badge variant="outline" className="ml-auto text-ui-xs">
          Slow updates
        </Badge>
      )}
    </div>
  );
}
