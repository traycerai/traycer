# Desktop development

The renderer's development tools include a relay drop switch. In a development
desktop window, open the application Developer Tools and run:

```js
window.__traycerDevDropRelay();
```

It returns the number of open relay sockets closed in that window. Other
connections stay open. Run it again after recovery to request another drop.
The close uses code 4007 (`relay-relink`), so a relay that supports session
continuity can park and reclaim the session.

The switch is loaded before the application starts. It requires both Vite's
development mode and the desktop's baked `isDevBuild` gate. Renderer release
bundles remove the installation branch; staging and production source runs
also leave the socket constructor and global namespace unchanged.

Its focused verification runs from `clients/desktop/`:

```sh
bun run vitest run src/renderer-shell/__tests__/dev-relay-drop.test.ts
```
