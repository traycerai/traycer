import {
  formatListHarnessesResponse,
  type FormattableHarnessSummary,
} from "@traycer/protocol/agent/agent-harnesses";
import {
  listGuiHarnessesRequestSchema,
  listGuiHarnessesResponseSchema,
  type GuiHarnessOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  callHostRpc,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import type { CommandFn } from "../runner/runner";

export function buildAgentListHarnessesCommand(): CommandFn {
  return async () => {
    const result = await toAgentCliError(
      callHostRpc(
        "agent.gui.listHarnesses",
        parseUserInput(listGuiHarnessesRequestSchema, {}),
      ),
    );
    const catalog = parseHostResponse(listGuiHarnessesResponseSchema, result);
    const response = {
      harnesses: catalog.harnesses
        .filter((harness) => harness.enabled)
        .map(harnessSummary),
    };
    return {
      data: response,
      human: formatListHarnessesResponse(response),
      exitCode: 0,
    };
  };
}

function harnessSummary(harness: GuiHarnessOption): FormattableHarnessSummary {
  return {
    id: harness.id,
    label: harness.label,
    available: harness.available,
    availabilityPending: harness.availabilityPending,
    error: harness.error,
  };
}
