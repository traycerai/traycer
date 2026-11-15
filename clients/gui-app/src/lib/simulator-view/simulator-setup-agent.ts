import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  SimulatorPlatform,
  SimulatorStatusResponse,
} from "@traycer/protocol/host/simulator/schemas";
import { simulatorPlatformLabel } from "@/lib/simulator-view/simulator-labels";

/**
 * The platforms an agent could set up on this host: ones it cannot run yet
 * that the host says setup can make runnable (`setupSupported`). An older
 * host omits the field, which is never an offer. A pack state of
 * `unsupported` while some platform IS available is about the processor or
 * the tools registry, which nothing installed on the machine changes, so it
 * offers nothing either.
 */
export function simulatorSetupPlatforms(
  status: SimulatorStatusResponse,
): readonly SimulatorPlatform[] {
  const anyAvailable = status.platforms.some((platform) => platform.available);
  if (status.packState.kind === "unsupported" && anyAvailable) return [];
  return status.platforms
    .filter(
      (platform) => !platform.available && platform.setupSupported === true,
    )
    .map((platform) => platform.platform);
}

/** One run of a prompt line: plain text, or a command or tool name as code. */
type PromptRun = string | { readonly code: string };

const INSTALL_STEPS: Readonly<Record<SimulatorPlatform, readonly PromptRun[]>> =
  {
    android: [
      "Android: a JDK at Java 17 or later for the SDK tools; the Android SDK with its official command-line tools (",
      { code: "sdkmanager" },
      ", ",
      { code: "avdmanager" },
      "), platform-tools, the emulator and a system image for this processor; an ffmpeg build from the platform's package manager or ffmpeg.org whose ",
      { code: "ffmpeg -encoders" },
      " lists libx264, for the emulator's video; then an Android virtual device (AVD).",
    ],
    ios: [
      "iOS: Xcode from Apple, selected with ",
      { code: "xcode-select" },
      " and past its first launch, with an iOS Simulator runtime and a simulator device.",
    ],
  };

/**
 * The prompt a "Set up with an agent" draft starts with. It names the host
 * by id as well as by name, and the agent checks where it runs before it
 * changes anything: the draft's placement already refuses any other host,
 * and the check holds wherever the prompt text is pasted or sent from.
 */
export function simulatorSetupPromptContent(input: {
  readonly hostId: string;
  readonly hostName: string;
  readonly status: SimulatorStatusResponse;
}): JsonContent {
  const { hostId, hostName, status } = input;
  const setup = simulatorSetupPlatforms(status);
  const labels = setup.map(simulatorPlatformLabel).join(" and ");
  return {
    type: "doc",
    content: [
      paragraph([
        `Set up ${labels} mobile simulators on the Traycer host "${hostName}" (host id `,
        { code: hostId },
        ") so Traycer can run them there.",
      ]),
      paragraph([
        "Work only on that host. Before changing anything, check with ",
        { code: "traycer_get_self" },
        " that you are running on host ",
        { code: hostId },
        "; if you are not, stop and tell me.",
      ]),
      paragraph(["What Traycer reports on this host:"]),
      bulletList(
        status.platforms.map((platform) => {
          const label = simulatorPlatformLabel(platform.platform);
          return [
            platform.available
              ? `${label}: available.`
              : `${label}: ${platform.reason ?? "not available."}`,
          ];
        }),
      ),
      paragraph(["Then:"]),
      bulletList([
        ["Diagnose each missing prerequisite before changing anything."],
        [
          "Reuse compatible tools that are already installed: an Android SDK, a JDK at Java 17 or later (Android Studio's bundled one counts), Xcode and its simulator runtimes, and an ffmpeg whose ",
          { code: "ffmpeg -encoders" },
          " lists libx264.",
        ],
        ["Install only what is missing, from official sources:"],
        ...setup.map((platform) => INSTALL_STEPS[platform]),
        [
          "Ask me before installing any system package or using administrator privileges; do not assume this setup request authorizes those actions. Follow existing approvals for privileged actions and licenses.",
        ],
        [
          "If something cannot be fixed on this machine, such as hardware acceleration or the processor, explain why and stop.",
        ],
        [
          "Verify: ",
          { code: "simulator_list" },
          " shows the platform available. If mobile simulators are off, ask me to turn them on with ",
          { code: "simulator_request_enable" },
          ". Then boot a simulator with ",
          { code: "simulator_open" },
          " and confirm its screen streams and it responds to input.",
        ],
      ]),
    ],
  };
}

function paragraph(runs: readonly PromptRun[]): JsonContent {
  return {
    type: "paragraph",
    content: runs.map((run) =>
      typeof run === "string"
        ? { type: "text", text: run }
        : { type: "text", text: run.code, marks: [{ type: "code" }] },
    ),
  };
}

function bulletList(items: readonly (readonly PromptRun[])[]): JsonContent {
  return {
    type: "bulletList",
    content: items.map((runs) => ({
      type: "listItem",
      content: [paragraph(runs)],
    })),
  };
}
