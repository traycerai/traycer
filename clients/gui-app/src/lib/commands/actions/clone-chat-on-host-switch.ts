import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";
import {
  openCreatedChatWhenProjected,
  openNewChatInActiveTile,
  type CancelFn,
  type CreateChatCommand,
} from "@/lib/commands/actions/new-chat";

/**
 * Clone-not-migrate flow for switching a chat tab's bound host: chat tabs
 * are host-bound for life (see CLAUDE.md), so we swap the bound host and
 * spin up a sibling chat on it, leaving the original tab untouched. Returns
 * the same caller-owned cancel as `openNewChatInActiveTile`.
 */
export interface CloneChatOnHostSwitchArgs {
  readonly epicId: string;
  readonly tabId: string;
  readonly targetHostId: string;
  readonly directory: IHostDirectoryService;
  readonly createChat: CreateChatCommand;
}

export function cloneChatOnHostSwitch(
  args: CloneChatOnHostSwitchArgs,
): CancelFn {
  args.directory.selectById(args.targetHostId);
  return openNewChatInActiveTile({
    epicId: args.epicId,
    tabId: args.tabId,
    hostId: args.targetHostId,
    worktreeIntent: null,
    createChat: args.createChat,
    openWhenProjected: openCreatedChatWhenProjected,
  });
}
