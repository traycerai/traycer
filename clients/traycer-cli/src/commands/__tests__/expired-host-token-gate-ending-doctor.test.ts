import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openWorld,
  type HomeRef,
  type World,
} from "./expired-host-token-harness";
import { UnaryDoor } from "./expired-host-token-unary-door";
import { liveUnary, seams } from "./expired-host-token-seams";
import { runDoctor } from "../../doctor/engine";
import type { DoctorIssue } from "../../doctor/issues";

/**
 * How the gate ended a call, read through the doctor's real RPC probe, reached
 * by `runDoctor` itself: the real host-rpc, the harness's fake unary socket and
 * pid-metadata seam. The TCP port check meets a real listener (a socket that
 * accepts and says nothing), and the service, install and upgrade neighbours
 * are staged as the other doctor tests stage them.
 */

const home = vi.hoisted((): HomeRef => ({ path: null }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.path ?? actual.homedir() };
});
vi.mock("../../logger", async () =>
  (await import("./expired-host-token-seams")).loggerModule(),
);
vi.mock("../../host/pid-metadata", async (importOriginal) =>
  (await import("./expired-host-token-seams")).pidMetadataModule(
    await importOriginal<typeof import("../../host/pid-metadata")>(),
  ),
);
vi.mock("../../internal/sign-in-environments", async (importOriginal) =>
  (await import("./expired-host-token-seams")).signInEnvironmentsModule(
    await importOriginal<
      typeof import("../../internal/sign-in-environments")
    >(),
  ),
);
vi.mock(
  "@traycer-clients/shared/host-client/host-ownership",
  async (importOriginal) =>
    (await import("./expired-host-token-seams")).hostOwnershipModule(
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-ownership")
      >(),
    ),
);
vi.mock(
  "../../../../shared/host-transport/whatwg-stream-ws-factory",
  async () =>
    (await import("./expired-host-token-seams")).streamFactoryModule(),
);
vi.mock("../../../../shared/host-transport/whatwg-ws-factory", async () =>
  (await import("./expired-host-token-seams")).unaryFactoryModule(),
);
vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: () => ({
    version: "0.0.0",
    installedAt: "2026-05-01T00:00:00Z",
    executablePath: process.execPath,
    source: { kind: "registry", value: "0.0.0" },
    archiveSha256: "deadbeef",
    signatureKeyId: "stub",
    sizeBytes: 1024,
  }),
}));
vi.mock("../../host/bootstrap-log", () => ({
  readBootstrapMarkers: async () => [],
}));
vi.mock("../../service", () => ({
  createServiceController: () => ({
    status: async () => ({
      state: "running",
      version: "0.0.0",
      listenUrl: "ws://127.0.0.1:9/rpc",
      pid: process.pid,
    }),
    install: async () => undefined,
    uninstall: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    restart: async () => undefined,
  }),
  serviceLabelFor: (environment: "production" | "dev") => ({
    id: `ai.traycer.host.${environment}`,
  }),
}));
vi.mock("../../commands/cli-upgrade", () => ({
  readPendingCliUpgrade: () => null,
  pendingUpgradeFinalisable: () => false,
}));
vi.mock("../../upgrade/finalize-helper", () => ({
  readPostFinalizeMarker: async () => ({ status: "absent" }),
}));

let world: World;
let unary: UnaryDoor;
let listener: Server;
const accepted: Socket[] = [];

beforeEach(async () => {
  vi.stubEnv("TRAYCER_AGENT_ID", "");
  vi.stubEnv("TRAYCER_EPIC_ID", "");
  world = await openWorld(home, "none");
  unary = new UnaryDoor(world.mint, world.expiredHeld);
  liveUnary.door = unary;
  unary.serve = () => {
    throw new Error("the host answers nothing");
  };
  // The port check dials this listener; the RPC never does.
  listener = createServer((socket) => {
    accepted.push(socket);
  });
  await new Promise<void>((resolve) => {
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  seams.endpoint = {
    hostId: world.hostId,
    websocketUrl: `ws://127.0.0.1:${port}/rpc`,
  };
});

afterEach(async () => {
  for (const socket of accepted.splice(0)) socket.destroy();
  await new Promise<void>((resolve) => {
    listener.close(() => resolve());
  });
  liveUnary.door = null;
  vi.unstubAllEnvs();
  await world.close();
});

type EndingKind =
  | "sign-in-rejected"
  | "not-a-member"
  | "not-admitted"
  | "sandbox-frozen";

/**
 * The whole probe line each definite refusal prints, written out: the fixed
 * prefix, then the refusal's own line. Not-admitted and sandbox-frozen have no
 * line of their own, so their message ends at the prefix's trailing space;
 * not-a-member's own line carries the one `traycer login` sentence the report
 * may hold.
 */
const HOST_REFUSAL_LINES = [
  [
    "not-a-member",
    "Could not complete an RPC handshake with the host: traycer: This computer belongs to a team. This account is not a member. Switch accounts to use Traycer here. Run `traycer login` to switch accounts.",
  ],
  ["not-admitted", "Could not complete an RPC handshake with the host: "],
  ["sandbox-frozen", "Could not complete an RPC handshake with the host: "],
] as const;

/** `runDoctor`, with the mint answered as the ending requires. */
async function doctorEndedBy(
  kind: EndingKind,
): Promise<readonly DoctorIssue[]> {
  const run = runDoctor({
    environment: "production",
    portConflictDeps: { platform: "darwin", runCommand: async () => null },
  });
  await vi.waitFor(() => expect(world.mint.requests.length).toBeGreaterThan(0));
  world.mint.respond(kind);
  const result = await run;
  // The host was never sent a request frame: the gate ended the probe's call.
  expect(unary.requests).toEqual([]);
  return result.issues;
}

/** The issue the probe raised: the one that carries this endpoint. */
function probeIssueOf(issues: readonly DoctorIssue[]): DoctorIssue {
  const found = issues.filter(
    (issue) =>
      (issue.details as { websocketUrl?: unknown } | null)?.websocketUrl ===
      seams.endpoint.websocketUrl,
  );
  expect(found).toHaveLength(1);
  return found[0];
}

describe("the doctor's RPC probe, through runDoctor, ended by the gate", () => {
  it("sign-in-rejected: exactly the issue a host's own UNAUTHORIZED raises", async () => {
    const issue = probeIssueOf(await doctorEndedBy("sign-in-rejected"));
    expect(issue).toEqual({
      code: "HOST_RPC_UNAUTHORIZED",
      severity: "error",
      title: "Host rejected the stored credentials",
      message:
        "The host is listening but rejected the authenticated RPC connection (UNAUTHORIZED) even after a bearer refresh. Sign in again.",
      fixAction: null,
      terminalCommand: "traycer login",
      details: {
        websocketUrl: seams.endpoint.websocketUrl,
        rpcCode: "UNAUTHORIZED",
      },
    });
  }, 60_000);

  it.each(HOST_REFUSAL_LINES)(
    "%s: the generic probe-failed issue with its own line, and no restart, no sign-in advice",
    async (kind, message) => {
      const issues = await doctorEndedBy(kind);
      expect(probeIssueOf(issues)).toEqual({
        code: "PORT_UNREACHABLE",
        severity: "warning",
        title: "Host RPC probe failed",
        message,
        fixAction: null,
        terminalCommand: null,
        details: { websocketUrl: seams.endpoint.websocketUrl, rpcCode: kind },
      });
      // No issue of the whole report restarts the host.
      for (const reported of issues) {
        expect(reported.fixAction).not.toBe("host-restart");
        expect(reported.terminalCommand ?? "").not.toContain("restart");
      }
    },
    60_000,
  );
});
