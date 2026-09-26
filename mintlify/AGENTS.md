# AGENTS.md — Public docs site

`mintlify/` is the public documentation site, published to
https://docs.traycer.ai. It is customer-facing product documentation, not a
place for internal or developer notes.

Mintlify builds every `.md` and `.mdx` file in this directory. A file does
not have to be listed in `docs.json` to become a public URL. `docs.json` sets
`seo.indexing` to `all`, so an unlisted page is still served and written into
`llms.txt`.

## What belongs here

Customer-facing product pages only. Add each new page to the `docs.json`
navigation.

## What does not

Support runbooks, production ops procedures, ADRs, design notes, SQL,
credentials, and agent instructions other than this file. Contributor and
development docs live in the repo's top-level `docs/`, which is not
published.

## Publishing

Mintlify deploys the `mintlify` branch, reading `docs.json` from this
directory. The Publish Docs workflow
(`.github/workflows/publish-docs.yml`) runs `mint broken-links` here, then
force-pushes the triggering ref to that branch. Nothing is live until that
workflow runs.

Feature videos are hosted at `https://assets.traycer.ai/docs/videos/`, not
committed here.

`CLAUDE.md` is a symlink to this file. Both are listed in `.mintignore`, so
the site does not serve them.
