export type InterviewToolProvider = "claude" | "opencode";

const INTERVIEW_BLOCK_ID_SUFFIX = ":interview";

const CLAUDE_INTERVIEW_TOOLS: ReadonlySet<string> = new Set([
  "askuserquestion",
  "requestuserinput",
]);

const OPENCODE_INTERVIEW_TOOLS: ReadonlySet<string> = new Set(["question"]);

export function interviewBlockId(toolUseId: string): string {
  return `${toolUseId}${INTERVIEW_BLOCK_ID_SUFFIX}`;
}

export function toolUseIdFromInterviewBlockId(blockId: string): string | null {
  if (!blockId.endsWith(INTERVIEW_BLOCK_ID_SUFFIX)) return null;
  const toolUseId = blockId.slice(0, -INTERVIEW_BLOCK_ID_SUFFIX.length);
  return toolUseId.length === 0 ? null : toolUseId;
}

export function isClaudeInterviewToolName(toolName: string): boolean {
  return CLAUDE_INTERVIEW_TOOLS.has(normalizeInterviewToolName(toolName));
}

export function isOpenCodeInterviewToolName(toolName: string): boolean {
  return OPENCODE_INTERVIEW_TOOLS.has(toolName);
}

export function isKnownInterviewToolName(toolName: string): boolean {
  return (
    isClaudeInterviewToolName(toolName) ||
    isOpenCodeInterviewToolName(toolName)
  );
}

export function isKnownInterviewDisplayToolName(toolName: string): boolean {
  return (
    isClaudeInterviewToolName(toolName) ||
    OPENCODE_INTERVIEW_TOOLS.has(normalizeInterviewToolName(toolName))
  );
}

export function isInterviewToolNameForProvider(
  provider: InterviewToolProvider,
  toolName: string,
): boolean {
  switch (provider) {
    case "claude":
      return isClaudeInterviewToolName(toolName);
    case "opencode":
      return isOpenCodeInterviewToolName(toolName);
  }
}

function normalizeInterviewToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
}
