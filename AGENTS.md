# CLAUDE.md

## Fork Setup (gavasques/traycer)

Este repo é um **fork** de `traycerai/traycer` (MIT License), mantido por Guilherme
Vasques para customizações próprias.

**Remotes:**
- `origin` → `https://github.com/gavasques/traycer.git` (fork — push aqui)
- `upstream` → `https://github.com/traycerai/traycer.git` (original — só pull)

**Caminho local:** `~/Documents/Workspaces/Thanos Traycer`

**Workflow (NUNCA commite em `main` diretamente):**

```bash
# 1. Criar feature
git checkout -b feat/minha-feature
git push -u origin feat/minha-feature

# 2. Puxar updates do original
git checkout main
git fetch upstream
git merge upstream/main
git push origin main

# 3. Rebase da feature sobre o main atualizado
git checkout feat/minha-feature
git rebase main

# Atalho: gh repo sync gavasques/traycer --branch main
```

> Fork de repo público é público. Suas customizações ficam visíveis, mas a
> licença MIT permite uso fechado do código — só mantenha o aviso de licença.

---

## Feature: Orchestrations

**O que é:** Templates globais de time de agentes — roles, responsibilities e
model bindings — gerenciados via CLI e (futuro) UI.

**Dados (no usuário, não no repo):**

```
~/.traycer/model-groups/          ← grupos de modelos globais (default, cheap, premium)
~/.traycer/orchestrations/         ← templates de time
  └── dev-team-full/
      ├── orchestration.json       ← roles + artifact chain + rules
      └── roles/*.md               ← responsibility por papel
```

**CLI commands:**
- `traycer orchestration list` — lista orquestrações
- `traycer orchestration show --name <name>` — detalhes
- `traycer orchestration roles --name <name>` — roles
- `traycer orchestration models --name <name> --role <id> [--group <g>]` — modelos por papel
- `traycer orchestration responsibility --name <name> --role <id>` — MD para injeção
- `traycer orchestration groups` — lista model groups

**Arquivos do fork:**
- `clients/traycer-cli/src/store/orchestration-store.ts` — store (filesystem)
- `clients/traycer-cli/src/commands/orchestration.ts` — 6 command builders
- `clients/traycer-cli/src/index.ts` — `registerOrchestrationCommands`

**Próximos passos:** UI (gui-app) para gerenciar orquestrações + injeção automática
via `contextPrelude` no `runtimeAgentRunInput`.

---

## Referência

O conteúdo completo de arquitetura, comandos e convenções do projeto está em
[`AGENTS.md`](AGENTS.md). Leia-o antes de mexer no código.

**Nested docs:**
- [`clients/gui-app/AGENTS.md`](clients/gui-app/AGENTS.md)
- [`clients/desktop/AGENTS.md`](clients/desktop/AGENTS.md)

**Resumo rápido:**
- Stack: Bun 1.3.12 workspaces + Nx, branch `main`
- Build: `bun run build` / `bun run compile` (nunca `tsc` direto)
- Test/Lint: `bun run test && bun run lint && bun run format`
- Commits: DCO obrigatório (`git commit -s`)
- Não rode `compile`/`build`/`lint`/`format` antes de commit — o `pre-commit` hook já faz isso
