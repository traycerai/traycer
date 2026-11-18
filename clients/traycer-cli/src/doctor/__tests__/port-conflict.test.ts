import { describe, expect, it } from "vitest";
import {
  parseLsof,
  parseNetstat,
  parseSs,
  parseTasklist,
  resolvePortConflict,
} from "../port-conflict";

// Unit-level pin for the lsof/ss/netstat parsers + the platform-aware
// `resolvePortConflict` orchestrator. We never spawn the real OS tools
// in CI - every path is exercised via stubbed stdout fixtures so the
// suite is reproducible on macOS, Linux, and Windows builders alike.

describe("parseLsof", () => {
  it("extracts pid + command from a typical -Fpcn payload", () => {
    const stdout = [
      "p4321",
      "cnode",
      "n*:7300",
      "p9999",
      "cother",
      "n*:1",
    ].join("\n");
    expect(parseLsof(stdout)).toEqual({ pid: 4321, processName: "node" });
  });

  it("returns null on empty input", () => {
    expect(parseLsof("")).toBeNull();
  });
});

describe("parseSs", () => {
  it("extracts pid + name from the systemd ss `users:` field", () => {
    const stdout =
      'LISTEN 0  128  0.0.0.0:7300  0.0.0.0:*  users:(("node",pid=4321,fd=18))';
    expect(parseSs(stdout)).toEqual({ pid: 4321, processName: "node" });
  });

  it("returns null when no users:(...) clause is present", () => {
    expect(parseSs("LISTEN 0 128 0.0.0.0:7300")).toBeNull();
  });
});

describe("parseNetstat / parseTasklist", () => {
  it("extracts the listening pid for the requested port", () => {
    const stdout = [
      "Active Connections",
      "",
      "  Proto  Local Address      Foreign Address    State        PID",
      "  TCP    127.0.0.1:7300     0.0.0.0:0          LISTENING    4321",
      "  TCP    127.0.0.1:5000     0.0.0.0:0          LISTENING    9999",
    ].join("\r\n");
    expect(parseNetstat(stdout, 7300)).toEqual({ pid: 4321 });
  });

  it("returns null when the port is not listening", () => {
    expect(parseNetstat("Proto Local State", 7300)).toBeNull();
  });

  it("parses a tasklist CSV row for the process image name", () => {
    expect(
      parseTasklist('"node.exe","4321","Console","1","42,108 K"\r\n'),
    ).toBe("node.exe");
  });
});

describe("resolvePortConflict - platform routing", () => {
  it("returns the lsof match on macOS", async () => {
    const result = await resolvePortConflict(7300, new Set([1234]), {
      platform: "darwin",
      runCommand: async (bin) => {
        if (bin === "lsof") {
          return {
            stdout: ["p4321", "cnode"].join("\n"),
            stderr: "",
          };
        }
        return null;
      },
    });
    expect(result).toEqual({ pid: 4321, processName: "node" });
  });

  it("ignores the host's own pid (no false positive)", async () => {
    const result = await resolvePortConflict(7300, new Set([4321]), {
      platform: "darwin",
      runCommand: async () => ({ stdout: "p4321\ncnode\n", stderr: "" }),
    });
    expect(result).toBeNull();
  });

  it("falls back to ss on Linux when lsof is unavailable", async () => {
    const result = await resolvePortConflict(7300, new Set([1234]), {
      platform: "linux",
      runCommand: async (bin) => {
        if (bin === "lsof") return null;
        if (bin === "ss") {
          return {
            stdout:
              'LISTEN 0 128 0.0.0.0:7300 0.0.0.0:* users:(("node",pid=4321,fd=18))',
            stderr: "",
          };
        }
        return null;
      },
    });
    expect(result).toEqual({ pid: 4321, processName: "node" });
  });

  it("uses netstat + tasklist on Windows", async () => {
    const result = await resolvePortConflict(7300, new Set([1234]), {
      platform: "win32",
      runCommand: async (bin) => {
        if (bin === "netstat") {
          return {
            stdout:
              "  TCP    127.0.0.1:7300     0.0.0.0:0          LISTENING    4321\r\n",
            stderr: "",
          };
        }
        if (bin === "tasklist") {
          return {
            stdout: '"node.exe","4321","Console","1","42,108 K"\r\n',
            stderr: "",
          };
        }
        return null;
      },
    });
    expect(result).toEqual({ pid: 4321, processName: "node.exe" });
  });

  it("returns null when the port could not be resolved on any platform", async () => {
    const result = await resolvePortConflict(7300, new Set(), {
      platform: "darwin",
      runCommand: async () => null,
    });
    expect(result).toBeNull();
  });

  it("returns null for an invalid port (defensive)", async () => {
    const result = await resolvePortConflict(0, new Set(), {
      platform: "darwin",
      runCommand: async () => null,
    });
    expect(result).toBeNull();
  });
});
