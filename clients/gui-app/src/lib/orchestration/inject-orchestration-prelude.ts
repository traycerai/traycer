import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ITraycerCli } from "@traycer-clients/shared/platform/runner-host";
import {
  useOrchestrationBindingStore,
  type OrchestrationBinding,
} from "@/stores/orchestration/orchestration-binding-store";

export type OrchestrationInjectionFailure = {
  readonly kind: "cli-unavailable" | "prelude-error" | "empty-prelude";
  readonly orchestrationName: string;
  readonly roleId: string;
};

/**
 * Prepends plain-text paragraphs (one per non-empty line) ahead of the user
 * doc. Used only for chat-creation initialMessage injection.
 */
export function prependPlainTextToComposerDoc(
  content: JsonContent,
  plainText: string,
): JsonContent {
  const lines = plainText.split("\n");
  const preludeBlocks: JsonContent[] = lines.map((line) =>
    line.length === 0
      ? { type: "paragraph" }
      : {
          type: "paragraph",
          content: [{ type: "text", text: line }],
        },
  );

  const userBlocks = content.content ?? [];
  return {
    ...content,
    type: "doc",
    content: [...preludeBlocks, ...userBlocks],
  };
}

/**
 * If orchestration binding is enabled and traycerCli can build a prelude,
 * return content with the one-shot prelude prepended. On any failure, returns
 * the original content unchanged (create must not fail because of injection)
 * and optionally reports via `onFailure` when injection was attempted.
 *
 * `onFailure` fires ONLY when binding was enabled + complete and injection was
 * attempted but produced no prelude. Disabled/incomplete binding → silent.
 */
export async function maybeInjectOrchestrationPreludeAtCreate(
  content: JsonContent,
  traycerCli: ITraycerCli | null,
  bindingOverride: OrchestrationBinding | null,
  onFailure: ((reason: OrchestrationInjectionFailure) => void) | null,
): Promise<JsonContent> {
  const binding =
    bindingOverride ?? useOrchestrationBindingStore.getState().binding;
  if (!binding.enabled) return content;
  if (binding.orchestrationName.length === 0 || binding.roleId.length === 0) {
    return content;
  }

  const failureBase = {
    orchestrationName: binding.orchestrationName,
    roleId: binding.roleId,
  };

  if (traycerCli === null) {
    onFailure?.({ kind: "cli-unavailable", ...failureBase });
    return content;
  }

  try {
    const prelude = await traycerCli.orchestrationPrelude({
      name: binding.orchestrationName,
      roleId: binding.roleId,
      group: binding.modelGroup ?? undefined,
    });
    if (prelude === null || prelude.text.length === 0) {
      onFailure?.({ kind: "empty-prelude", ...failureBase });
      return content;
    }
    return prependPlainTextToComposerDoc(content, prelude.text);
  } catch {
    onFailure?.({ kind: "prelude-error", ...failureBase });
    return content;
  }
}
