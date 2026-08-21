import { describe, expect, it } from "vitest";
import { plainTerminalFleetIdentityKey } from "@traycer/protocol/host/terminal/plain-schemas";
import {
  epicTerminalUiIdentityKey,
  failedCreateHasAuthoritativeRow,
  hasTerminalPendingCreate,
  terminalPendingCreateMarker,
  withTerminalPendingCreate,
  withoutTerminalPendingCreate,
} from "@/lib/terminals/pending-create-identity";

const HOST_A = "host-a";
const HOST_B = "host-b";
const TERMINAL_ID = "term-1";
const ADVERSARIAL_HOST = 'failed:["host-a","term-1"]';
const ADVERSARIAL_TERMINAL = '","term-1';

describe("pending-create identity", () => {
  it("writes composite fleet keys and does not treat a bare terminal id as pending", () => {
    const marked = withTerminalPendingCreate(new Set(), HOST_A, TERMINAL_ID);
    expect(marked.has(TERMINAL_ID)).toBe(false);
    expect(marked.has(terminalPendingCreateMarker(HOST_A, TERMINAL_ID))).toBe(
      true,
    );
    expect(hasTerminalPendingCreate(marked, HOST_A, TERMINAL_ID)).toBe(true);
    expect(hasTerminalPendingCreate(marked, HOST_B, TERMINAL_ID)).toBe(false);
    expect(
      hasTerminalPendingCreate(new Set([TERMINAL_ID]), HOST_A, TERMINAL_ID),
    ).toBe(false);
  });

  it("unmarks one host without clearing another host's same terminal id", () => {
    const pending = withTerminalPendingCreate(
      withTerminalPendingCreate(new Set(), HOST_A, TERMINAL_ID),
      HOST_B,
      TERMINAL_ID,
    );
    const next = withoutTerminalPendingCreate(pending, HOST_A, TERMINAL_ID);
    expect(hasTerminalPendingCreate(next, HOST_A, TERMINAL_ID)).toBe(false);
    expect(hasTerminalPendingCreate(next, HOST_B, TERMINAL_ID)).toBe(true);
  });

  it("does not interpret a chat/artifact id as a terminal pending marker", () => {
    const chatOnly = new Set([TERMINAL_ID]);
    expect(hasTerminalPendingCreate(chatOnly, HOST_A, TERMINAL_ID)).toBe(false);
    const canonicalAsChatId = new Set([
      terminalPendingCreateMarker(HOST_A, TERMINAL_ID),
    ]);
    expect(canonicalAsChatId.has(TERMINAL_ID)).toBe(false);
    expect(
      withoutTerminalPendingCreate(chatOnly, HOST_A, TERMINAL_ID).has(
        TERMINAL_ID,
      ),
    ).toBe(true);
  });

  it("keeps NUL-containing host/terminal pairs distinct", () => {
    const leftHost = "a\u0000b";
    const leftTerminal = "c";
    const rightHost = "a";
    const rightTerminal = "b\u0000c";
    const pending = withTerminalPendingCreate(
      withTerminalPendingCreate(new Set(), leftHost, leftTerminal),
      rightHost,
      rightTerminal,
    );
    expect(hasTerminalPendingCreate(pending, leftHost, leftTerminal)).toBe(
      true,
    );
    expect(hasTerminalPendingCreate(pending, rightHost, rightTerminal)).toBe(
      true,
    );
    const next = withoutTerminalPendingCreate(pending, leftHost, leftTerminal);
    expect(hasTerminalPendingCreate(next, leftHost, leftTerminal)).toBe(false);
    expect(hasTerminalPendingCreate(next, rightHost, rightTerminal)).toBe(true);
  });

  it("uses namespaced composite keys that stay injective for adversarial identifiers", () => {
    const sessionKey = epicTerminalUiIdentityKey(
      "session",
      ADVERSARIAL_HOST,
      ADVERSARIAL_TERMINAL,
    );
    const failedKey = epicTerminalUiIdentityKey(
      "failed",
      ADVERSARIAL_HOST,
      ADVERSARIAL_TERMINAL,
    );
    expect(sessionKey).not.toBe(failedKey);
    expect(sessionKey.startsWith("session:")).toBe(true);
    expect(failedKey.startsWith("failed:")).toBe(true);
    expect(epicTerminalUiIdentityKey("session", HOST_A, TERMINAL_ID)).not.toBe(
      epicTerminalUiIdentityKey("failed", HOST_A, TERMINAL_ID),
    );
    expect(epicTerminalUiIdentityKey("session", 'x","y', "z")).not.toBe(
      epicTerminalUiIdentityKey("session", "x", 'y","z'),
    );
    expect(terminalPendingCreateMarker(HOST_A, TERMINAL_ID)).toBe(
      plainTerminalFleetIdentityKey({
        hostId: HOST_A,
        terminalId: TERMINAL_ID,
      }),
    );
  });

  it("treats only a matching-host durable row as authoritative", () => {
    expect(
      failedCreateHasAuthoritativeRow({
        jobHostId: HOST_A,
        jobTerminalId: TERMINAL_ID,
        sessionHostId: HOST_A,
        durableHasTerminalId: () => false,
      }),
    ).toBe(false);
    expect(
      failedCreateHasAuthoritativeRow({
        jobHostId: HOST_A,
        jobTerminalId: TERMINAL_ID,
        sessionHostId: HOST_A,
        durableHasTerminalId: (terminalId) => terminalId === TERMINAL_ID,
      }),
    ).toBe(true);
    expect(
      failedCreateHasAuthoritativeRow({
        jobHostId: HOST_B,
        jobTerminalId: TERMINAL_ID,
        sessionHostId: HOST_A,
        durableHasTerminalId: () => true,
      }),
    ).toBe(false);
  });
});
