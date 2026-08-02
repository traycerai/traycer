import type { GuiAgentCommandOption } from "@traycer/protocol/host/index";

import type {
  MentionPreview,
  ProviderSlashCommand,
  SlashCommand,
} from "@/lib/composer/types";
import type { SlashCommandCatalog } from "@/lib/composer/tiptap-json-content";

/**
 * The full command description plus its usage hint (when the command takes
 * arguments), as the preview panel's single named field for a slash entry.
 */
function slashCommandPreview(command: GuiAgentCommandOption): MentionPreview {
  const usage = command.argumentHint;
  return {
    kind: "text",
    primary:
      usage === null || usage.length === 0
        ? command.description
        : `${command.description} ${usage}`,
    secondary: null,
    mono: false,
  };
}

function dedupeSlashCommands(
  commands: ReadonlyArray<SlashCommand>,
): ReadonlyArray<SlashCommand> {
  const byName = new Map<string, SlashCommand>();
  for (const command of commands) {
    const key = command.name.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, command);
    }
  }
  return Array.from(byName.values());
}

/**
 * The one projection from a wire `agent.gui.listCommands` response to the
 * commands the composer works in. Lives here rather than in `useSlashCommands`
 * because the picker reads it through that hook while a submit resolving a cold
 * catalog reads it through `fetchSlashCommandCatalog` - two entry points that
 * must agree on what a command IS, or a chip built at send time would differ
 * from the one the popover inserts.
 */
export function slashCommandsFromOptions(
  options: ReadonlyArray<GuiAgentCommandOption>,
): ReadonlyArray<SlashCommand> {
  const providerCommands: ReadonlyArray<ProviderSlashCommand> = options.map(
    (command): ProviderSlashCommand => ({
      ...command,
      source: "provider",
      preview: slashCommandPreview(command),
    }),
  );
  return dedupeSlashCommands(providerCommands);
}

/**
 * Keys commands by lowercased name for the raw-text converters. Case-insensitive
 * because a written `$Plan` must resolve to the same option the picker inserts
 * for `plan`.
 */
export function slashCommandCatalogFrom(
  commands: ReadonlyArray<SlashCommand>,
): SlashCommandCatalog {
  return new Map(
    commands.map((command) => [command.name.toLowerCase(), command]),
  );
}
