import type {
  CommentThreadStatusFilter,
  CommentsListThreadsResponse,
  CommentsSetThreadStatusResponse,
} from "@traycer/protocol/host/comments";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import { jsonContentToMarkdown } from "@traycer/protocol/common/json-content-serializer";

type FormatCommentsListThreadsXmlInput = {
  readonly response: CommentsListThreadsResponse;
  readonly platform: "POSIX" | "WINDOWS";
  readonly query: {
    readonly artifactPaths: readonly string[] | null;
    readonly status: CommentThreadStatusFilter;
  };
};

type XmlThread = {
  readonly thread: CommentThreadWire;
  readonly anchorStatus: "present" | "missing" | "unavailable";
  readonly anchorWarning: string | null;
};

export function formatCommentsListThreadsXml(
  input: FormatCommentsListThreadsXmlInput,
): string {
  const lines = ["<traycer_comments>"];
  const matchingThreadCount = input.response.artifacts.reduce(
    (count, artifact) => count + artifact.threads.length,
    0,
  );
  const hasArtifactWarnings = input.response.artifacts.some(
    (artifact) => artifact.warning !== null,
  );

  if (matchingThreadCount === 0 && !hasArtifactWarnings) {
    return emptyListMessage(input.query);
  }

  for (const artifact of input.response.artifacts) {
    lines.push(
      "",
      `<artifact ${[
        attribute("path", artifact.artifactPath),
        attribute("kind", artifact.kind),
        attribute("title", artifact.title),
      ].join(" ")}>`,
    );
    if (artifact.warning !== null) {
      lines.push(`<warning>${escapeXmlText(artifact.warning)}</warning>`);
    }
    for (const thread of artifact.threads) {
      lines.push("", serializeThread(thread, input.platform));
    }
    lines.push("", "</artifact>");
  }

  lines.push("", "</traycer_comments>", "");
  return lines.join("\n");
}

export function formatCommentsSetThreadStatusResponse(
  response: CommentsSetThreadStatusResponse,
): string {
  const lines: string[] = [];
  lines.push(`Updated status for ${response.updated.length} threads.`);
  if (response.failed.length > 0) {
    lines.push(
      "",
      `Failed to update status for ${response.failed.length} threads:`,
    );
    for (const failure of response.failed) {
      lines.push(
        `- ${failure.artifactPath} ${failure.threadId}: ${failure.reason}`,
      );
    }
  }
  return lines.join("\n");
}

function emptyListMessage(
  query: FormatCommentsListThreadsXmlInput["query"],
): string {
  const comments =
    query.status === "all" ? "comments" : `${query.status} comments`;
  const scope =
    query.artifactPaths === null ? "the epic" : "the selected artifacts";
  return `No ${comments} found in ${scope}.`;
}

function serializeThread(
  input: XmlThread,
  platform: "POSIX" | "WINDOWS",
): string {
  const { thread } = input;
  const author = authorAttribute(
    thread.data.createdByHandle ?? null,
    thread.data.createdByUserId,
  );
  const attrs = [
    attribute("id", thread.threadId),
    author,
    attribute("created_at", isoTimestamp(thread.createdAt)),
    attribute("status", thread.resolved ? "resolved" : "open"),
  ]
    .filter((value): value is string => value !== null)
    .join(" ");
  const lines = [`<thread ${attrs}>`];
  const quotedText = thread.data.quotedText?.trim() ?? "";

  if (quotedText.length > 0) {
    const quotedSectionAttrs = [
      attribute("anchor", input.anchorStatus),
      input.anchorWarning === null
        ? null
        : attribute("reason", input.anchorWarning),
    ].filter((value): value is string => value !== null);
    lines.push(
      `<quoted_section ${quotedSectionAttrs.join(" ")}>${escapeXmlText(quotedText)}</quoted_section>`,
    );
  }

  thread.comments.forEach((comment, index) => {
    const commentAuthor = authorAttribute(
      comment.author.fallbackHandle,
      comment.author.userId,
    );
    const commentAttrs = [
      attribute("id", comment.commentId),
      attribute("n", String(index + 1)),
      commentAuthor,
      attribute("created_at", isoTimestamp(comment.createdAt)),
      comment.updatedAt === null
        ? null
        : attribute("edited_at", isoTimestamp(comment.updatedAt)),
    ].filter((value): value is string => value !== null);
    const body = jsonContentToMarkdown(comment.content, {
      mentionFormat: "user",
      platform,
    });

    lines.push(
      `<comment ${commentAttrs.join(" ")}>`,
      escapeXmlText(body),
      "</comment>",
    );
  });

  lines.push("</thread>");
  return lines.join("\n");
}

// Legacy comments were persisted before author handles were guaranteed at
// write time; fall back to the stable user id (as `user_id=`, mirroring what
// the GUI shows) so the model always gets an attribution signal instead of an
// anonymous comment.
function authorAttribute(
  providerHandle: string | null,
  userId: string,
): string | null {
  const trimmedHandle = providerHandle?.trim() ?? "";
  if (trimmedHandle.length > 0) {
    return attribute("author", trimmedHandle);
  }
  const trimmedUserId = userId.trim();
  return trimmedUserId.length > 0
    ? attribute("user_id", trimmedUserId)
    : null;
}

function attribute(name: string, value: string): string {
  return `${name}="${escapeXmlAttribute(value)}"`;
}

function isoTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
