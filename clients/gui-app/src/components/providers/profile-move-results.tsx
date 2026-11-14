import { displayTitle } from "@/lib/display-title";
import type { ReactNode } from "react";
import type {
  ProvidersCommitProfileMoveRequest,
  ProvidersCommitProfileMoveResponse,
  ProvidersPreviewProfileMoveResponse,
} from "@traycer/protocol/host/profile-move-schemas";

type MoveTarget = ProvidersPreviewProfileMoveResponse["targets"][number];
type MoveRef = ProvidersCommitProfileMoveRequest["targets"][number];
type MoveResult = ProvidersCommitProfileMoveResponse["results"][number];

function targetKey(target: MoveRef): string {
  return target.kind === "agent"
    ? JSON.stringify(["agent", target.epicId, target.agentId])
    : JSON.stringify(["bot", target.botId]);
}

export function ProfileMoveResults({
  result,
  preview,
  destinationLabel,
  computerName,
  afterMoved,
}: {
  readonly afterMoved: ReactNode;
  readonly result: ProvidersCommitProfileMoveResponse;
  readonly preview: ProvidersPreviewProfileMoveResponse;
  readonly destinationLabel: string;
  readonly computerName: (hostId: string | null) => string;
}) {
  const originals = new Map(
    preview.targets.map((row) => [targetKey(row), row]),
  );
  const moved = result.results.filter((row) => row.outcome === "moved").length;
  const skipped = result.results.filter((row) => row.outcome === "skipped");
  const pending = result.results.filter((row) => row.outcome === "pending");
  const rowFor = (resultRow: MoveResult): MoveTarget | undefined =>
    resultRow.row ?? originals.get(targetKey(resultRow.target));
  const pendingNames = new Set([
    ...pending.flatMap((row) => {
      const hostId = rowFor(row)?.hostId ?? null;
      return hostId === null ? [] : [computerName(hostId)];
    }),
    ...preview.pendingComputers
      .filter((row) => row.reason === "unreachable")
      .map((row) => computerName(row.hostId)),
  ]);
  return (
    <>
      {moved > 0 ? <p>{`Moved ${moved} to ${destinationLabel}.`}</p> : null}
      {afterMoved}
      {skipped.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Not moved</h3>
          {skipped.map((row) => {
            const target = rowFor(row);
            const computer = computerName(target?.hostId ?? null);
            return (
              <div key={targetKey(row.target)}>
                <div>
                  {displayTitle(target?.title ?? "", "agent")}
                  <span className="ml-2 text-muted-foreground">{computer}</span>
                </div>
                <p className="text-muted-foreground">
                  {skipReasonText(row.reason, destinationLabel, computer)}
                </p>
              </div>
            );
          })}
        </section>
      ) : null}
      {pending.length > 0 || pendingNames.size > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Still waiting</h3>
          {[...pendingNames].map((computer) => (
            <p
              key={computer}
              className="text-muted-foreground"
            >{`${computer} can't be reached. These move when you run this again while it is online.`}</p>
          ))}
          {pending.map((row) => {
            const target = rowFor(row);
            return (
              <div key={targetKey(row.target)}>
                {displayTitle(target?.title ?? "", "agent")}
                <span className="ml-2 text-muted-foreground">
                  {computerName(target?.hostId ?? null)}
                </span>
              </div>
            );
          })}
        </section>
      ) : null}
      {preview.pendingComputers
        .filter((row) => row.reason === "unsupported")
        .map((row) => (
          <p
            key={row.hostId}
            className="text-muted-foreground"
          >{`${computerName(row.hostId)} is running an older version. Update it to move its agents.`}</p>
        ))}
    </>
  );
}

function skipReasonText(
  reason: Extract<MoveResult, { outcome: "skipped" }>["reason"],
  profile: string,
  computer: string,
): string {
  switch (reason) {
    case "not-waiting":
      return "No longer waiting";
    case "binding-changed":
      return "Already on another profile";
    case "not-allowed":
      return "You can't move this one";
    case "destination-unusable":
      return `${profile} can't be used on ${computer}`;
    case "personal-boundary":
      return "A team's bot can't use a Personal profile";
    case "unsupported":
      return `${computer} is running an older version`;
    case "gone":
      return "No longer exists";
  }
}
