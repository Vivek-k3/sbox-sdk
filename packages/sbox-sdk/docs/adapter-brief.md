# Adapter work brief (0.1.0 renewal)

Read this fully before touching an adapter. The overall plan and the audit findings are in `docs/renewal-plan.md`.

## Context

- Core v2 has landed (commit `09377fd`).
  - Read `src/internal/types.ts` (look for `DriverHandle`, `DriverPty`, `DriverTemplates`, `DriverVolumes`, `SandboxProvider`, `ResolvedSandboxSpec`) and `src/internal/capabilities.ts`.
  - `src/memory/index.ts` is the **reference adapter**: it implements every driver feature.
- The conformance suite is `src/conformance/index.ts`. Its first check, `contract: driver methods match declared caps`, fails if a cap is declared but the method is missing, **or if a method exists but its cap is `unsupported`**.
- Current SDKs are already installed in `node_modules` (you don't need to install anything). Read their `.d.ts` directly.
- Older and newer tarballs from the audit are in `/tmp/sbx-audit/` (if present).
- The node version is 26 and Docker is available locally (OrbStack).

## Ownership rules (several agents work in this tree at the same time)

- **Edit only your own files:**
  - `src/<provider>/**`
  - `apps/web/content/docs/adapters/<provider>.mdx`
- **Never edit any of these:**
  - `package.json`, `pnpm-lock.yaml`
  - `src/internal/**`, `src/adapter/**`, `src/conformance/**`, `src/memory/**`, `src/live/**`
  - other providers' directories
  - `apps/web/content/docs/adapters/meta.json`

  If you need a core change, **don't make it**. Work around it, and list the request in your final report.

- **Never run `git commit`, `git stash`, `git checkout`, `git reset` or `pnpm install/add`.** I commit after review.
- Scope lint and format to your files:
  ```bash
  pnpm exec oxfmt src/<provider> && pnpm exec oxlint src/<provider>
  ```
  Don't run root `pnpm fix`.
- Verify with these commands. Other adapters may be mid-edit, so judge only the errors in _your_ files.
  ```bash
  pnpm types
  pnpm exec vitest run src/<provider>
  ```

## Quality bar for every adapter

1. **Type the SDK for real.** Use `type Mod = typeof import("<pkg>")` and the SDK's own exported types. Don't hand-write SDK interfaces, and don't use `as unknown as` to hide mismatches. Keep the lazy `await import()` inside create/connect, so importing the subpath stays cheap.
2. **Make the caps table truthful.** Declare every capability the provider supports as `native`, and implement it. Anything you can't implement stays `unsupported`, and the corresponding driver method must be absent.
3. **Map the full `ResolvedSandboxSpec`:**
   - `template` / `templateRef` / `fromSnapshot`
   - `env`, `metadata` → labels/tags
   - `resources` (incl. `shmMB` where possible), `region`
   - `lifecycle` (`idleTimeoutMs`, `maxAgeMs`, `onIdle`, `autoResume`)
   - `network` (egress at create), `secrets`, `volumes`, `ports`
   - `idempotencyKey`: from `ctx.idempotencyKey`, natively if the API has it; otherwise derive a deterministic name from it
4. **`getInfo()` must fetch live state.** Never hard-code `running`. Map **every** provider status to `SandboxState`.
5. **`list()` paginates fully** and honors `filter.metadata` / `filter.state` / `filter.limit`.
6. **`destroy()` deletes the sandbox.** Stop/shutdown alone leaks it.
7. **Exec:**
   - Stream when the SDK streams, and keep stdout and stderr separate.
   - Report the real exit code.
   - `kill()` must actually kill.
   - Pass `timeoutMs` through natively. The core also has a backstop.
   - Honor `cwd`/`env` natively, or set `perCommandEnvCwd: false`.
8. **Files:** use the SDK's native file API, not base64-over-exec, unless there is no other way. Large or binary files must round-trip.
9. **Previews:**
   - Return `Preview` with `url`, and `wsUrl` if the provider uses a different host or scheme for WebSockets.
   - Set `auth` precisely: `query` (param + token), `header` (headers), `signed-url`, or `public`.
   - Set `flags.previewBrowserAuth: true` only if a private preview works from a browser WebSocket.
10. **Templates** (if the provider can build): implement `provider.templates` (`DriverTemplates`):
    - `build(spec)` builds in the user's account and tags the result with `spec.cacheKey`, using an alias, label or name such as `spec.name`. Stream progress through `onEvent`.
    - `lookup(idOrKey)` finds it again by cacheKey, alias or id.
    - Set `flags.templateSources` to what you actually accept (`"dockerfile" | "image" | "snapshot"`).
    - Helpers you can import from `../adapter/index.js`: `loadTemplateContext`, `tarContext`, `parseDockerfile`.
    - **Never** push to a public registry.
11. **New driver features to implement where supported:**
    - `createPty`, `connectPty` (`DriverPty`)
    - `getMetrics`
    - `fork(count)`
    - `snapshot({ name, mode })`, where `SnapshotRef.includesMemory` records whether memory was captured
    - `setEgressPolicy` (incl. `deny`, `inject` where supported)
    - `createSsh`
    - `provider.volumes` (`DriverVolumes`)
    - `provider.getOrCreate` (named sandboxes)
    - **`provider.verify(ctx)`, required for every adapter:** the cheapest authenticated call (e.g. list with limit 1). Never create.
12. **`resumeChangesId: true`** if resume/restore returns a new id.
13. **Errors:** `mapError` maps 401/403 → `Unauthorized`, 404 → `NotFound`, 429/quota → `QuotaExceeded` (retryable), 409 → `Conflict`, timeouts → `Timeout`.
14. **Tests** (`src/<provider>/<provider>.test.ts`):
    - Build a **fake SDK** with `vi.mock("<pkg>", …)`, typed against the real SDK types.
    - Back the fake's exec with `MiniShell` from `../memory/shell.js` over an in-memory filesystem, so commands like `echo`, `cat`, `sleep`, `exit 3`, `>&2`, pipes and `sh -c` behave for real.
    - **Run `runConformance(provider, { live: true })` offline through your adapter with that fake, and make it pass.** Model the fake on the SDK's real method names and argument shapes (from its `.d.ts` and docs), so a wrong call fails the test.
    - Also unit-test spec mapping (what args reach the SDK for a rich `create()` spec), `mapError`, status mapping, and pagination.
15. **Live config:** write `src/<provider>/live.ts` exporting `live: LiveConfig` (see `src/memory/live.ts` and `src/live/types.ts`), with the env var names users would naturally set.
16. **Docs:** rewrite `apps/web/content/docs/adapters/<provider>.mdx` to match. Look at the existing pages for frontmatter and structure. Include install, auth/env, a quickstart, template build (if supported), previews and browser auth, the caps notes, and known limitations.
17. **Deprecation** (only where told): add `@deprecated` JSDoc on the factory, a one-time `console.warn` on the first factory call, and a callout in the docs page.

## Final report (keep it under 400 words)

- What changed, per provider, including bugs fixed with the old `file:line` references from the audit.
- The final caps table diff: `unsupported`→`native` and the reverse.
- Test results: the offline conformance pass count, and `pnpm types` clean for your files (yes/no).
- Anything unverified or guessed about the provider API.
- Requested core changes, if any.
