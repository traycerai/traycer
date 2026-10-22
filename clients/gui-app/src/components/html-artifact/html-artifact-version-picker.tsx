import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { ChevronDown, History } from "lucide-react";
import { htmlArtifactVersionIdentity } from "@traycer/protocol/host/epic/html-artifact-versions";
import type { HtmlArtifactVersionState } from "@/hooks/epic/use-epic-html-artifact-version";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function HtmlArtifactVersionPicker({
  version,
}: {
  readonly version: HtmlArtifactVersionState;
}) {
  const coarsePointer = useCoarsePointer();
  const { selectedVersion, selectedVersionNumber, currentVersionNumber } =
    version;
  if (!version.selectionAvailable) return null;
  if (!version.supported && selectedVersion === null) return null;
  let label = "Latest";
  if (selectedVersion !== null) {
    label =
      selectedVersionNumber === null
        ? "Saved version"
        : `Version ${selectedVersionNumber}`;
  } else if (currentVersionNumber !== null) {
    label = `Latest · v${currentVersionNumber}`;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={coarsePointer ? "touch" : "sm"}
          aria-label={`HTML version history: ${label}`}
        >
          <History />
          <span>{label}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-max">
        <DropdownMenuLabel>Version history</DropdownMenuLabel>
        <HtmlArtifactVersionChoices version={version} />
        <HtmlArtifactHistoryPages version={version} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HtmlArtifactVersionChoices({
  version,
}: {
  readonly version: HtmlArtifactVersionState;
}) {
  const {
    selectedVersion,
    selectedVersionNumber,
    currentVersionNumber,
    history,
  } = version;
  const selectedIdentity =
    selectedVersion === null
      ? null
      : htmlArtifactVersionIdentity(selectedVersion);
  const versions = history.data?.versions ?? [];
  const selectedId =
    selectedVersion === null
      ? "latest"
      : (versions.find(
          (item) => htmlArtifactVersionIdentity(item) === selectedIdentity,
        )?.id ?? "selected");
  const currentCapture = versions.find(
    (item) => item.versionNumber === currentVersionNumber,
  );
  return (
    <DropdownMenuRadioGroup
      value={selectedId}
      onValueChange={(id) => {
        if (id === "latest") version.selectVersion(null);
        else {
          const next = versions.find((item) => item.id === id);
          if (next !== undefined) version.selectVersion(next);
        }
      }}
    >
      <DropdownMenuRadioItem value="latest">
        <HtmlArtifactVersionLabel
          versionNumber={currentVersionNumber}
          capturedAt={currentCapture?.manifest.capturedAt ?? null}
          latest
        />
      </DropdownMenuRadioItem>
      {selectedId === "selected" && selectedVersion !== null ? (
        <DropdownMenuRadioItem value="selected">
          <HtmlArtifactVersionLabel
            versionNumber={selectedVersionNumber}
            capturedAt={selectedVersion.manifest.capturedAt}
            latest={false}
          />
        </DropdownMenuRadioItem>
      ) : null}
      {versions
        .filter(
          (item) =>
            item.versionNumber !== currentVersionNumber ||
            item.id === selectedId,
        )
        .map((item) => (
          <DropdownMenuRadioItem key={item.id} value={item.id}>
            <HtmlArtifactVersionLabel
              versionNumber={item.versionNumber}
              capturedAt={item.manifest.capturedAt}
              latest={false}
            />
          </DropdownMenuRadioItem>
        ))}
    </DropdownMenuRadioGroup>
  );
}

function HtmlArtifactVersionLabel(props: {
  readonly versionNumber: number | null;
  readonly capturedAt: number | null;
  readonly latest: boolean;
}) {
  let label = props.latest ? "Latest" : "Saved version";
  if (props.versionNumber !== null) {
    label = `Version ${props.versionNumber}${props.latest ? " · Latest" : ""}`;
  }
  return (
    <span className="flex flex-col items-start">
      <span>{label}</span>
      {props.capturedAt === null ? null : (
        <span className="text-ui-xs text-muted-foreground">
          {new Date(props.capturedAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      )}
    </span>
  );
}

function HtmlArtifactHistoryPages({
  version,
}: {
  readonly version: HtmlArtifactVersionState;
}) {
  const { history } = version;
  const nextCursor = history.data?.nextCursor;
  const hasOlder = nextCursor !== undefined && nextCursor !== null;
  return (
    <>
      {history.isPending && version.supported ? (
        <DropdownMenuItem disabled>Loading versions…</DropdownMenuItem>
      ) : null}
      {history.isError ? (
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            void history.refetch();
          }}
        >
          Couldn't load versions. Retry
        </DropdownMenuItem>
      ) : null}
      {version.hasNewer || hasOlder ? <DropdownMenuSeparator /> : null}
      {version.hasNewer ? (
        <DropdownMenuItem
          disabled={history.isFetching}
          onSelect={(event) => {
            event.preventDefault();
            version.showNewest();
          }}
        >
          Newest versions
        </DropdownMenuItem>
      ) : null}
      {hasOlder ? (
        <DropdownMenuItem
          disabled={history.isFetching}
          onSelect={(event) => {
            event.preventDefault();
            version.showOlder();
          }}
        >
          Older versions
        </DropdownMenuItem>
      ) : null}
    </>
  );
}
