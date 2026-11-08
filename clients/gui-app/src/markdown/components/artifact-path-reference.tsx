import { use, type ReactNode } from "react";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { artifactEpicIdFromLinkPath } from "../links/artifact-link-path";
import { MarkdownLinkContext } from "../links/markdown-link-context";
import { TraycerReferenceChip } from "./traycer-reference-chip";
import { extractText } from "./extract-react-node-text";

export function ArtifactPathReference(props: Record<string, unknown>) {
  const policy = use(MarkdownLinkContext);
  const path = props["data-artifact-path"];
  const children = props.children as ReactNode;
  if (typeof path !== "string" || policy === null) return <>{children}</>;
  const segments = path.split(/[\\/]/u).filter(Boolean);
  const basename = segments.at(-1) ?? path;
  const pathLabel = /^index\.(?:md|html)$/iu.test(basename)
    ? (segments.at(-2) ?? basename)
    : basename;
  const authoredLabel = extractText(children);
  // Preserve descriptive Markdown link labels; abbreviate path-shaped labels.
  const label =
    artifactEpicIdFromLinkPath(authoredLabel) === null
      ? authoredLabel
      : pathLabel;
  return (
    <TraycerReferenceChip
      icon={<FileText className="size-3.5" />}
      title={path}
      refKind="artifact"
      sameEpicNodeRef={null}
      epicId={undefined}
      onOpen={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const opened = policy.openFileLink({
          path,
          line:
            typeof props["data-line"] === "number" ? props["data-line"] : null,
          col: typeof props["data-col"] === "number" ? props["data-col"] : null,
          isDirectory: /[/\\]$/u.test(path),
        });
        if (!opened) toast("Couldn’t open link");
      }}
    >
      {label}
    </TraycerReferenceChip>
  );
}
