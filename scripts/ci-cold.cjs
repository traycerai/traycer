#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dns = require("node:dns/promises");
const { execFileSync } = require("node:child_process");

const domains = [
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
];
const hosts =
  process.platform === "win32"
    ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
    : "/etc/hosts";
const stateFile = path.join(
  process.env.RUNNER_TEMP,
  "traycer-ci-blackhole.json",
);

function command(program, args) {
  execFileSync(program, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw new Error("Cold setup is restricted to GitHub Actions runners");
  const [operation, cold, blackhole] = process.argv.slice(2);
  if (operation === "restore") {
    if (!fs.existsSync(stateFile)) return;
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (process.platform === "linux") {
      for (const program of state.firewalls) {
        command("sudo", [program, "-D", "OUTPUT", "-j", "TRAYCER_GITHUB"]);
        command("sudo", [program, "-F", "TRAYCER_GITHUB"]);
        command("sudo", [program, "-X", "TRAYCER_GITHUB"]);
      }
    } else if (process.platform === "win32") {
      command("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Remove-NetFirewallRule -DisplayName TraycerGitHubBlackhole",
      ]);
    } else {
      command("sudo", ["pfctl", "-a", "com.apple/traycer-ci", "-F", "rules"]);
    }
    if (process.platform === "win32") fs.writeFileSync(hosts, state.hosts);
    else {
      const original = `${stateFile}.hosts`;
      fs.writeFileSync(original, state.hosts);
      command("sudo", ["cp", original, hosts]);
    }
    fs.rmSync(stateFile, { force: true });
    return;
  }
  if (operation !== "prepare") throw new Error("Expected prepare or restore");
  if (cold === "true") {
    // Keep the image's Node available for the dependency-free bootstrap after
    // emptying setup-node's tool cache; the pinned setup-node still downloads.
    const bootstrap = path.join(
      process.env.RUNNER_TEMP,
      "ci-bootstrap-runtime",
    );
    fs.mkdirSync(bootstrap, { recursive: true });
    const node = path.join(
      bootstrap,
      process.platform === "win32" ? "node.exe" : "node",
    );
    fs.copyFileSync(process.execPath, node);
    fs.chmodSync(node, 0o755);
    fs.appendFileSync(process.env.GITHUB_PATH, `${bootstrap}\n`);
    for (const directory of [
      ".nx",
      "node_modules",
      "traycer/node_modules",
      path.join(process.env.RUNNER_TEMP, "traycer-ci-tools"),
      path.join(os.homedir(), ".bun"),
      path.join(os.homedir(), ".cache/pre-commit"),
      path.join(os.homedir(), ".cache/electron"),
      path.join(os.homedir(), ".cache/ms-playwright"),
      path.join(os.homedir(), ".traycer/host/dev/providers"),
      "traycer-host/src/harnesses/codex/protocol/generated",
      path.join(os.homedir(), ".npm"),
      path.join(os.homedir(), ".cache/node-gyp"),
      path.join(os.homedir(), "Library/Caches/electron"),
      path.join(os.homedir(), "Library/Caches/ms-playwright"),
      ...(process.env.RUNNER_TOOL_CACHE
        ? ["Bun", "Python", "node"].map((tool) =>
            path.join(process.env.RUNNER_TOOL_CACHE, tool),
          )
        : []),
    ])
      fs.rmSync(directory, { recursive: true, force: true });
    if (process.platform !== "win32")
      command("sudo", ["rm", "-rf", "/opt/traycer-ci"]);
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      "NX_SKIP_NX_CACHE=true\nNX_DISABLE_NX_CACHE=true\nNX_SKIP_REMOTE_CACHE=true\nNX_DAEMON=false\n",
    );
    console.log("[ci-tools] cold caches emptied; Nx caching disabled");
  }
  if (blackhole !== "true") return;
  const addresses = [
    ...new Set(
      (
        await Promise.all(
          domains.map(async (hostname) => {
            try {
              return (await dns.lookup(hostname, { all: true })).map(
                (entry) => entry.address,
              );
            } catch {
              return [];
            }
          }),
        )
      ).flat(),
    ),
  ];
  if (addresses.length === 0)
    throw new Error("Cannot resolve GitHub addresses for the firewall");
  const state = { hosts: fs.readFileSync(hosts, "utf8"), firewalls: [] };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  if (process.platform === "linux") {
    for (const program of ["iptables", "ip6tables"]) {
      command("sudo", [program, "-N", "TRAYCER_GITHUB"]);
      state.firewalls.push(program);
      command("sudo", [program, "-I", "OUTPUT", "1", "-j", "TRAYCER_GITHUB"]);
      fs.writeFileSync(stateFile, JSON.stringify(state));
      for (const address of addresses.filter(
        (ip) => ip.includes(":") === (program === "ip6tables"),
      )) {
        command("sudo", [
          program,
          "-A",
          "TRAYCER_GITHUB",
          "-d",
          address,
          "-j",
          "REJECT",
        ]);
      }
    }
  } else if (process.platform === "win32") {
    command("powershell.exe", [
      "-NoProfile",
      "-Command",
      `New-NetFirewallRule -DisplayName TraycerGitHubBlackhole -Direction Outbound -Action Block -RemoteAddress ${addresses.join(",")}`,
    ]);
  } else {
    const rules = `${stateFile}.pf`;
    fs.writeFileSync(
      rules,
      addresses.map((ip) => `block drop out quick to ${ip}`).join("\n") + "\n",
    );
    command("sudo", ["pfctl", "-a", "com.apple/traycer-ci", "-f", rules]);
    command("sudo", ["pfctl", "-E"]);
  }
  const blockedHosts = `${state.hosts}\n${domains.map((name) => `127.0.0.1 ${name}\n::1 ${name}`).join("\n")}\n`;
  if (process.platform === "win32") fs.writeFileSync(hosts, blockedHosts);
  else {
    const temporary = `${stateFile}.hosts`;
    fs.writeFileSync(temporary, blockedHosts);
    command("sudo", ["cp", temporary, hosts]);
  }
  console.log(
    "[ci-tools] GitHub firewall and DNS blackhole active before tool setup",
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
