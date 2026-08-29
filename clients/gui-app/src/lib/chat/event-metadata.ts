/**
 * Re-exported from `@traycer/protocol`, not restated.
 *
 * The setup-card lifecycle walk reads `workspacePath` / `triggeringMessageId`
 * through these narrowings, and that walk is now shared with the host (it
 * decides how many transcript rows a chat has). A second copy of the narrowing
 * on this side is how the two would eventually disagree about whether a key is
 * present - which shifts every ordinal after the first disagreement.
 *
 * This module stays as the GUI's import path so its ~dozen call sites keep
 * working; it just no longer owns an implementation.
 */
export {
  readMetadataNumber,
  readMetadataString,
  readMetadataValue,
} from "@traycer/protocol/persistence/chat-transcript/event-metadata";
