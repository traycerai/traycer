<img alt="Traycer" src="https://assets.traycer.ai/traycer-readme-banner.png" />

<div align="center">

[Download](https://traycer.ai/download) · [Docs](https://docs.traycer.ai) · [Releases](https://github.com/traycerai/traycer/releases/latest) · [Contributing](CONTRIBUTING.md)

<br />

[![MIT License](https://img.shields.io/badge/License-MIT-555555.svg?labelColor=333333&color=666666)](./LICENSE)
[![Downloads](https://img.shields.io/github/downloads/traycerai/traycer/total?labelColor=333333&color=666666)](https://github.com/traycerai/traycer/releases)
[![GitHub Stars](https://img.shields.io/github/stars/traycerai/traycer?labelColor=333333&color=666666&logo=github)](https://github.com/traycerai/traycer)
[![Last Commit](https://img.shields.io/github/last-commit/traycerai/traycer?labelColor=333333&color=666666)](https://github.com/traycerai/traycer/commits/main)
[![Commit Activity](https://img.shields.io/github/commit-activity/m/traycerai/traycer?labelColor=333333&color=666666)](https://github.com/traycerai/traycer/graphs/commit-activity)

[![Discord](https://img.shields.io/badge/Discord-Join-%235462eb?labelColor=%235462eb&logo=discord&logoColor=%23f5f5f5)](https://traycer.ai/discord)
[![Follow @TraycerAI on X](https://img.shields.io/twitter/follow/TraycerAI?logo=X&color=%23f5f5f5)](https://twitter.com/intent/follow?screen_name=traycerai)

</div>

**Run a fleet of coding agents — Claude Code, Codex, Cursor, and a dozen more — in parallel, on your existing subscriptions, without losing context.**

Traycer is an open-source AI orchestration app. Every agent keeps a durable session you can hand between models mid-conversation, agents talk to each other to plan, implement, and review, and your whole team can work in the same shared workspace in real time.

[![Traycer Demo Video](https://github.com/user-attachments/assets/a5efda0c-16f2-453b-9f8d-50d09df25aa4)](https://youtu.be/doh2yz3ZFvU)

## Features

|  |  |
| --- | --- |
| **Parallel agents, isolated worktrees** — Spin up any number of agents in one Task. Each can run in its own Git worktree, so parallel work never collides. | <!-- assets/parallel-agents.gif --> <sub><i>demo coming soon</i></sub> |
| **Switch models mid-conversation** — Move the same agent between Claude, Codex, Grok, or any other provider without losing a word of context. The context window is shared across all providers. | <!-- assets/model-switch.gif --> <sub><i>demo coming soon</i></sub> |
| **Agent-to-agent communication** — Agents message each other to delegate tickets, debate architecture, and peer-review code. Capabilities are permissioned per user, Host, and runtime — see the [capability matrix](https://docs.traycer.ai/concepts/agent-to-agent). | <!-- assets/agent-to-agent.gif --> <sub><i>demo coming soon</i></sub> |
| **Artifacts that outlive the chat** — Specs, tickets, reviews, and walkthroughs live as rendered documents beside the conversation — with live wireframe and Mermaid previews — so intent and decisions survive long after the transcript scrolls away. | <!-- assets/artifacts.gif --> <sub><i>demo coming soon</i></sub> |
| **Real-time team collaboration** — Invite teammates into a shared workspace: shareable boards, live co-editing, comments, and ticket assignment. | <!-- assets/collaboration.gif --> <sub><i>demo coming soon</i></sub> |
| **Chat and Terminal, side by side** — Work with the same providers through a rich Chat interface or a real Terminal, with files and Git diff panels one keystroke away. | <!-- assets/terminal-and-diff.gif --> <sub><i>demo coming soon</i></sub> |
| **Cross-device sync** — Close your laptop, open another machine, and pick up the same agents in the same state. Any device, any OS. | <!-- assets/cross-device.gif --> <sub><i>demo coming soon</i></sub> |
| **Remote hosts** — Every machine you sign in on runs a Traycer Host, and the app can reach all of yours. Kick off agents on your desktop or a beefy remote box, then steer them from wherever you are. | <!-- assets/remote-hosts.gif --> <sub><i>demo coming soon</i></sub> |
| **Mobile app** <sub>*coming soon*</sub> — Watch runs, answer your agents' questions, and start new work from your phone. iOS and Android. | <!-- assets/mobile.gif --> <sub><i>demo coming soon</i></sub> |
| **In-app browser** <sub>*coming soon*</sub> — A browser built into Traycer that agents can drive: open the app they just built, click through flows, and debug live pages without leaving the workspace. | <!-- assets/in-app-browser.gif --> <sub><i>demo coming soon</i></sub> |

## Bring Your Own Agent

Traycer connects to the subscriptions you already pay for instead of locking you into one ecosystem — or use Traycer's native inference subscription. Connect any of these coding agents:

<div align="center">
<table>
  <tr>
    <td align="center" width="150"><a href="https://claude.com/product/claude-code"><img src="assets/readme/agents/claude.svg" width="28" alt="Claude Code" /><br /><b>Claude Code</b></a></td>
    <td align="center" width="150"><a href="https://openai.com/codex"><img src="assets/readme/agents/codex.svg" width="28" alt="Codex" /><br /><b>Codex</b></a></td>
    <td align="center" width="150"><a href="https://cursor.com"><img src="assets/readme/agents/cursor.svg" width="28" alt="Cursor" /><br /><b>Cursor</b></a></td>
    <td align="center" width="150"><a href="https://opencode.ai"><img src="assets/readme/agents/opencode.svg" width="28" alt="OpenCode" /><br /><b>OpenCode</b></a></td>
  </tr>
  <tr>
    <td align="center" width="150"><a href="https://traycer.ai"><img src="assets/readme/agents/traycer.svg" width="28" alt="Traycer" /><br /><b>Traycer</b></a></td>
    <td align="center" width="150"><a href="https://x.ai"><img src="assets/readme/agents/grok.svg" width="28" alt="Grok" /><br /><b>Grok</b></a></td>
    <td align="center" width="150"><a href="https://github.com/features/copilot"><img src="assets/readme/agents/copilot.svg" width="28" alt="GitHub Copilot" /><br /><b>GitHub Copilot</b></a></td>
    <td align="center" width="150"><a href="https://devin.ai"><img src="assets/readme/agents/devin.svg" width="28" alt="Devin" /><br /><b>Devin</b></a></td>
  </tr>
  <tr>
    <td align="center" width="150"><a href="https://ampcode.com"><img src="assets/readme/agents/amp.svg" width="28" alt="Amp" /><br /><b>Amp</b></a></td>
    <td align="center" width="150"><a href="https://factory.ai"><img src="assets/readme/agents/droid.svg" width="28" alt="Droid" /><br /><b>Droid</b></a></td>
    <td align="center" width="150"><a href="https://kiro.dev"><img src="assets/readme/agents/kiro.svg" width="28" alt="Kiro" /><br /><b>Kiro</b></a></td>
    <td align="center" width="150"><a href="https://kilocode.ai"><img src="assets/readme/agents/kilocode.svg" width="28" alt="Kilo Code" /><br /><b>Kilo Code</b></a></td>
  </tr>
  <tr>
    <td align="center" width="150"><a href="https://kimi.com"><img src="assets/readme/agents/kimi.svg" width="28" alt="Kimi" /><br /><b>Kimi</b></a></td>
    <td align="center" width="150"><a href="https://github.com/QwenLM/qwen-code"><img src="assets/readme/agents/qwen.svg" width="28" alt="Qwen Code" /><br /><b>Qwen Code</b></a></td>
    <td align="center" width="150"><a href="https://openrouter.ai"><img src="assets/readme/agents/openrouter.svg" width="28" alt="OpenRouter" /><br /><b>OpenRouter</b></a></td>
    <td align="center" width="150"><a href="https://pi.dev"><img src="assets/readme/agents/pi.svg" width="28" alt="Pi" /><br /><b>Pi</b></a></td>
  </tr>
  <tr>
    <td align="center" width="150"><a href="https://hermes-agent.nousresearch.com"><img src="assets/readme/agents/hermes.svg" width="28" alt="Hermes Agent" /><br /><b>Hermes Agent</b></a></td>
    <td align="center" width="150"><a href="https://huggingface.co"><img src="assets/readme/agents/huggingface.svg" width="28" alt="Hugging Face" /><br /><b>Hugging Face</b></a></td>
    <td align="center" width="150"><a href="https://github.com/can1357/oh-my-pi"><img src="assets/readme/agents/omp.svg" width="28" alt="Oh My Pi" /><br /><b>Oh My Pi</b></a></td>
    <td align="center" width="150"><a href="https://reasonix.io"><img src="assets/readme/agents/reasonix.svg" width="28" alt="Reasonix" /><br /><b>Reasonix</b></a></td>
  </tr>
</table>
</div>

Setup commands and provider-specific configuration: [Coding Agents docs](https://docs.traycer.ai/agents-and-models/coding-agents).

## How it works

```mermaid
graph LR
    subgraph Task
        A1[Agent · Claude Code] --- A2[Agent · Codex]
        A1 -. agent-to-agent .-> A2
        AR[Artifacts<br/>specs · tickets · reviews]
    end
    A1 --> W1[Git worktree 1]
    A2 --> W2[Git worktree 2]
    Task <--> H[Traycer Host<br/>on your machine]
    H <--> C[Sync + collaboration]
```

- **Task** — the top-level container for related agents, panels, terminals, and artifacts.
- **Agent** — a durable session; switch its model anytime, delegate to child agents, reach it from any device.
- **Artifacts** — persistent documents (specs, tickets, stories, reviews) that keep decisions and context beyond the conversation.
- **Worktrees** — run each agent in your workspace folder, a fresh Git worktree, or an existing one.
- **Hosts** — each machine you sign in on runs a Traycer Host that owns its agents and files; every client can reach any of your hosts, local or remote.

This repository contains the open-source clients, CLI, and protocol. The Traycer Host is provisioned as a signed build from GitHub Releases — see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Installation

| Platform              | Install                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple Silicon) | [Download .dmg (arm64)](https://github.com/traycerai/traycer/releases/latest/download/traycer-desktop-macos-arm64.dmg)    |
| macOS (Intel)         | [Download .dmg (x64)](https://github.com/traycerai/traycer/releases/latest/download/traycer-desktop-macos-x64.dmg)        |
| Linux (AppImage)      | [Download .AppImage](https://github.com/traycerai/traycer/releases/latest/download/traycer-desktop-linux-x86_64.AppImage) |
| Linux (Debian/Ubuntu) | [Download .deb](https://github.com/traycerai/traycer/releases/latest/download/traycer-desktop-linux-amd64.deb)            |
| Linux (Fedora/RHEL)   | [Download .rpm](https://github.com/traycerai/traycer/releases/latest/download/traycer-desktop-linux-x86_64.rpm)           |
| Windows (x64)         | [Download .exe](https://github.com/traycerai/traycer/releases/latest/download/traycer-desktop-windows-x64.exe)            |

All builds: [latest release](https://github.com/traycerai/traycer/releases/latest). Mobile apps for iOS and Android are coming soon.

## Privacy

Your code is processed in-memory and never stored or used for training. Prompts and conversations follow **Privacy Mode** (default on for Team plans, opt-in for individuals); with it off, prompts may be logged to help improve our Services.

Agent requests for the CLI providers you configure go directly to that provider; Traycer's own inference is served by Traycer. Crash reporting (Sentry) and analytics (PostHog) may be enabled in release builds. Full [Privacy Policy](https://traycer.ai/legal/privacy-policy).

## Documentation

Setup, configuration, agent integrations, and provider-specific behavior: [**docs.traycer.ai**](https://docs.traycer.ai).

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md). Commits must be signed off under the [Developer Certificate of Origin (DCO)](CONTRIBUTING.md#developer-certificate-of-origin-dco). Bugs and feature requests: [open an issue](https://github.com/traycerai/traycer/issues).

> **Security:** Please don't report security vulnerabilities through public GitHub issues — email **support@traycer.ai**. See the [Security Policy](SECURITY.md).

<a href="https://github.com/traycerai/traycer/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=traycerai/traycer" />
</a>

## Community

- **[Discord](https://traycer.ai/discord)** — chat with the team and community
- **[X / Twitter](https://x.com/traycerai)** — updates and announcements
- **[YouTube](https://www.youtube.com/@TraycerAI)** — walkthroughs and demos

## Star History

<a href="https://star-history.com/#traycerai/traycer&Date">
  <img src="https://api.star-history.com/svg?repos=traycerai/traycer&type=Date" width="600" alt="Star history chart" />
</a>

## License

Licensed under the [MIT License](LICENSE).
