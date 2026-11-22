# sbox-sdk Renewal Plan (Nov 2026)

**Status:** research complete, plan drafted, nothing implemented yet.
**Inputs:** four research passes (existing providers ×3, new-provider landscape ×1) run on 2026-11-22 against npm tarballs, `.d.ts`, changelogs and official docs; plus requirements from Borat (BYOK cloud desktop sandboxes).
**Target release:** `0.1.0` (breaking changes allowed; we are alpha).

---

## 1. Where we stand

The repo was last touched in mid-August 2026. In the three months since, the provider landscape moved a lot:

- **Several adapters fail at runtime even on the SDK versions we lock.** Unit tests only check capability tables, so these went unnoticed.
- **Three providers made breaking changes to their SDKs:** Vercel (v4), Cloudflare (v1.0) and Daytona (a new package name).
- **Two providers are gone or replaced:**
  - Runloop is winding down; customer support ended 2026-11-13.
  - CodeSandbox has become Together Sandbox.
- **Almost every capability table undercounts.** PTY, egress control, fork, volumes, secrets and metrics are now native on most providers, but our tables still mark them `unsupported`.
- **Providers now share features our core can't express:**
  - template/image build
  - PTY sessions
  - lifecycle policies
  - memory vs filesystem snapshots
  - credential-injecting egress
  - browser-safe preview auth

### 1.1 Adapter health

| Adapter     | Locked   | Latest                | Severity              | Headline problem                                                                                                                                           |
| ----------- | -------- | --------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vercel      | 2.2.1    | 4.1.0                 | 🔴 broken             | Still on the v1 API: `sandboxId` is gone (now `name`); `destroy()` only stops, so sandboxes and snapshots leak; `runtime` deprecated in favour of `image`. |
| beam        | 1.0.12   | 1.1.6                 | 🔴 broken             | Calls `inst.sandboxId()` as a function, but it's a getter, so every create/connect throws.                                                                 |
| northflank  | 0.9.5    | 0.13.0                | 🔴 broken             | Wrong signature for `execServiceSession`, so every exec and file op fails. `status` is an object, so `create` always polls for 2 minutes.                  |
| blaxel      | 0.2.94   | 0.3.40                | 🔴 broken on `*`      | `list()` now returns a `PaginatedList`, so `for…of` throws. stderr is merged into stdout. `process.env` is mutated globally.                               |
| runloop     | 1.24.1   | 3.0.0                 | 🔴 broken + sunset    | Preview URL is always empty (v2 tunnel API). `executeSync` is deprecated. The service is winding down.                                                     |
| railway     | 3.4.1    | 3.17.0                | 🟠 wrong              | A create without a template drops token/env/idle/network config. `template` is a checkpoint name, not an image.                                            |
| codesandbox | 2.4.2    | 2.4.2 (legacy)        | 🟠 leaks + superseded | `destroy()` only shuts down, so sandboxes leak. The product is now `together-sandbox`.                                                                     |
| modal       | 0.8.1    | 0.11.2                | 🟠 connect broken     | Its `Sandbox` constructor changed (use `sandboxes.fromId`). File I/O goes base64-over-exec even though a native filesystem API exists.                     |
| cloudflare  | 0.12.1   | 1.0.3                 | 🟠 dead-end           | v1.0 removed `getSandbox` and the `Sandbox` class, and 0.x support ends 2026-12-31. `exposePort` was deprecated even in 0.12.                              |
| daytona     | 0.191.0  | `@daytona/sdk` 2.1.0  | 🟠 package moved      | `@daytonaio/sdk` is deprecated. The adapter passes `ttlMs` as the _create wait timeout_. Labels are ignored.                                               |
| morph       | 0.0.20   | 0.0.20 (abandoned TS) | 🟡 leaks              | Every create makes an orphaned snapshot, and so does every fork. Most of the spec is ignored.                                                              |
| fly         | REST     | REST                  | 🟡 wrong defaults     | Default `ubuntu` image exits immediately. Exec timeout defaults to 10s. `list` doesn't paginate. Preview has no routed service.                            |
| aws-lambda  | 3.1075.0 | 3.1175.0              | 🟡 wrong              | The runner drops `spec.env`, and the README build command is wrong. `getInfo` is hard-coded. `list` doesn't paginate. Preview token expires.               |
| e2b         | 2.6.1    | 2.9.1                 | 🟢 works, stale       | Idempotency key is fake (stored in metadata). `domain` isn't passed through. List filter is ignored. Seven caps are under-declared.                        |

### 1.2 Core-layer defects (from code review)

1. Shell builder (`internal/shell.ts:58–62`): `cd X && export …; cmd` runs `cmd` even if `cd` fails. Env keys aren't validated, which allows injection.
2. `spawn` skips `buildExecCommand` (`internal/sandbox.ts:166`), so cwd and env are lost on providers that don't support them per command.
3. `ports.fetch` silently makes a port **public** as a fallback (`sandbox.ts:335`).
4. `create` retries use a random idempotency key, and most adapters ignore the key anyway, so a retry can create duplicate VMs.
5. `network` is gated on `egressControl` but also holds `createSsh`, so a provider with SSH but no egress control can't offer SSH.
6. `fork` lives under `snapshots`, gated on `snapshot`, not `fork`. `restore` returns `void`, which can't express "restore made a new sandbox".
7. `resume` isn't capability-gated. One `setTimeout` can't tell idle timeout apart from max age.
8. The `emulate` option is never read (dead code).
9. The core never enforces `timeoutMs` when an adapter ignores it.
10. Files are fully buffered, and `write` never uses `handle.upload`.
11. Conformance only checks that caps are declared. It doesn't check that **optional method presence matches the caps**, and it doesn't test stderr separation, kill, stdin, timeout, real `getInfo` state or pagination.

---

## 2. Core API v2 (the `0.1.0` surface)

Design rules carry over: one import swap changes the provider, capability-gated sub-APIs are typed `undefined`, and `NotSupportedError` is thrown before any network call.

### 2.1 Templates (new; Borat priority #1)

```ts
type TemplateSource =
  | { dockerfile: string; context?: string | Record<string, FileBody> } // build in the user's account
  | { image: string }                                                    // registry ref
  | { snapshot: string };                                                // snapshot-as-template (Freestyle/Sprites/Morph)

interface TemplateSpec {
  source: TemplateSource;
  name?: string;
  resources?: ResourceSpec;   // build-time / default runtime resources
  startCmd?: string; readyCmd?: string;
}

client.templates.build(spec, { onLog?, signal?, cacheKey? }): Promise<TemplateRef>
client.templates.get(ref) / list() / delete(ref)
client.create({ template: "id" | TemplateRef | TemplateSpec })   // inline spec => build-or-reuse
```

- **Cache key:** a content hash of the Dockerfile, the context and the resources. Look it up with the provider's native tag/alias/digest before building, so a second `create` never rebuilds.
- **No publishing:** builds happen in the user's own account and are never pushed anywhere public.
- **Build logs:** streamed through `onLog({ step?, line })`.
- **Capabilities:** a new `templateBuild` cap, plus a `templateSources` flag set (`dockerfile | image | snapshot`).
- **Native mapping:**

| Provider               | Native build API                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| E2B                    | `Template.fromDockerfile`, `Template.build(..., { onBuildLogs })`                                                                     |
| Daytona                | `Image.fromDockerfile`, `snapshot.create({ onLogs })`                                                                                 |
| Modal                  | `images.fromRegistry().dockerfileCommands().build()` (no `fromDockerfile` in JS, so we parse simple Dockerfiles or take `image` only) |
| Blaxel                 | `ImageInstance`                                                                                                                       |
| Beam                   | `Image.fromDockerfile`                                                                                                                |
| Runloop                | `blueprints.create({ dockerfile })`                                                                                                   |
| AWS Lambda             | `CreateMicrovmImage`                                                                                                                  |
| Together               | `snapshots.create({ dockerfile, cacheKey, onProgress })`                                                                              |
| Tensorlake, Superserve | builders                                                                                                                              |
| Morph                  | `Snapshot.setup` chains (snapshot source)                                                                                             |
| Railway                | `Sandbox.template()` (no Dockerfile, so `image`/`dockerfile` is unsupported)                                                          |

- **Vercel and Cloudflare:** both have no build API. They support `{ image }` only. Cloudflare's Dockerfile lives in wrangler config.

### 2.2 Lifecycle

```ts
spec.lifecycle = {
  idleTimeoutMs?: number;          // auto-suspend after idle
  maxAgeMs?: number;               // wall-clock TTL (replaces ttlMs; keep ttlMs as alias)
  onIdle?: "pause" | "stop" | "destroy";
  autoResume?: boolean;            // wake on request (E2B, AWS, Morph, Beam VM, Sprites)
};
```

- **States:** add `archived` and `suspending`. `getInfo()` must fetch live state; no more hard-coded `running`.
- **Capability gating:** gate `resume` on `pause`.
- **Behaviour flags:** `pauseMode: "memory" | "filesystem"` and `resumeChangesId` (Together and Morph return a new ID on resume/restore).
- **New client methods:** `client.getOrCreate({ name, ...spec })` (native on Vercel, Daytona, Blaxel, Modal, Railway; emulated elsewhere via list-by-metadata) and `client.connect(id, { resume?: boolean })`.

### 2.3 Snapshots and fork

- `snapshots.create({ name?, mode?: "memory" | "filesystem" })`. `SnapshotRef.includesMemory` records which it was.
- `client.create({ fromSnapshot: ref })` is the canonical restore. `snapshots.restore()` stays only for providers that restore in place (Blaxel, Daytona).
- `sandbox.fork({ count?, name? }): Promise<Sandbox[]>` moves to the top level and is gated on `fork`. It's native on E2B, Vercel, Daytona, Blaxel, Morph, Freestyle, Superserve, Tensorlake and CodeSandbox/Together.

### 2.4 PTY (new)

```ts
sandbox.pty.create({ cmd?, cols, rows, cwd?, env? }): Promise<PtySession>
sandbox.pty.connect(id)
PtySession: { id, write(data), resize(cols, rows), onData / AsyncIterable<Uint8Array>, kill(), wait() }
```

Native on E2B, Vercel (`openInteractive`), Cloudflare, Daytona, Modal, Runloop, Northflank, Sprites, Freestyle and Tensorlake.

### 2.5 Ports and previews (Borat priority #2)

```ts
interface Preview {
  url: string;          // https
  wsUrl: string;        // wss, same route
  port: number;
  auth:
    | { type: "public" }
    | { type: "query"; param: string; token: string; expiresAt?: Date }  // browser + WebSocket safe
    | { type: "header"; headers: Record<string,string>; expiresAt?: Date } // NOT browser-WS safe
    | { type: "signed-url"; expiresAt?: Date };                           // token baked into url
  browserUrl(): string; // url with whatever auth a browser needs, or throws if impossible
}
ports.expose(port, { visibility?: "public" | "private", ttlMs? })
```

- **New flag:** `previewBrowserAuth: boolean`, true when private previews work from a browser WebSocket. The audit records each provider's model: E2B uses a `trafficAccessToken` header, Daytona has signed preview URLs, Modal has connect tokens, Blaxel has preview tokens and sessions, and AWS has tokens with a 60-minute maximum.
- **Fix:** `ports.fetch` must never make a port public as a side effect.

### 2.6 Network, secrets, SSH

- **Split** `network` into `network.egress` (gated on `egressControl`) and `network.ssh()` (gated on `ssh`).
- **`EgressPolicy` additions:**
  - `allow` / `deny` lists of domains and CIDRs, plus `defaultAction`
  - `setEgressPolicy` works at runtime where the provider supports it
  - optional `inject: [{ domains, headers: { name: SecretRef } }]` for credential injection. The secret never enters the sandbox; this is supported on E2B, Vercel, Cloudflare, Sprites, Freestyle and Superserve.
- **`SecretRef`:** add `mode: "env" | "egress"`.

### 2.7 Resources, volumes, metrics, verify

- `ResourceSpec`: add `shmMB` (Borat: Chromium needs about 1 GB) and `gpu: { type, count }`.
- `client.volumes.create / list / delete` (gated on `volumes`); `spec.volumes` stays for mounts.
- `sandbox.metrics(): Promise<{ cpuPct?, memMB?, diskMB?, ... }>`. This is the implementation of the existing `metrics` cap, which has no method today.
- `provider.verify(): Promise<{ ok: true; account?: string } | { ok: false; error }>` makes the cheapest authenticated call available, never a create (Borat priority #6). It's also exposed as `npx sbox verify <provider>`.

### 2.8 Later (not in 0.1.0)

These are tracked but not in scope yet:

- `sandbox.desktop` (computer use: screenshot, input, VNC URL) across Tensorlake, Daytona, Beam VM, Morph and Hopx
- `sandbox.git` helpers
- MCP gateway URLs
- lifecycle webhooks
- warm pools

---

## 3. Phased execution

### Phase 0: Foundations (before any feature work)

1. Install dependencies and get `pnpm build / test / types / check` green on the current code.
2. **Conformance v2:**
   - assert that optional `DriverHandle` method presence matches the caps (catches lying tables)
   - behavioural tests for stderr separation, non-zero exit, kill, stdin, timeout, cwd/env, binary file round-trip, live `getInfo` state, and paginated `list`
3. **Live test harness:** `pnpm test:live --provider e2b`, skipped unless `<PROVIDER>_API_KEY` is set. It runs the same conformance suite against real APIs, with leak checks (list by an `sbox-test` tag after each run). A per-provider nightly CI job is optional, using repo secrets.
4. **Mock-SDK fixtures:** each adapter test gets fakes generated from the provider's _current_ `.d.ts`, so a signature drift like Beam's or Northflank's fails typecheck.
5. **Fix the core defects in §1.2:** shell builder, spawn, `ports.fetch`, idempotency, SSH gating, dead `emulate`, timeout enforcement, streaming `upload`.

### Phase 1: Core API v2

Implement §2 in `internal/types.ts`, `capabilities.ts`, `sandbox.ts`, `client.ts` and `adapter/`, and update the memory provider so it implements everything (it's the reference). Keep `ttlMs`, `onIdle` and `snapshots.fork` as deprecated aliases for one minor release.

### Phase 2: Repair and upgrade existing adapters (worst first)

Each adapter goes through the same checklist:

1. Bump the peer floor.
2. Fix the audited bugs.
3. Wire the newly native caps.
4. Implement templates, previews and `verify`.
5. Pass conformance offline and live.
6. Update its docs page.

| Order | Adapter         | Key work                                                                                                                                                                            |
| ----- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | **vercel**      | Port to v4: `name`, `delete`, `image`, `snapshot`/`fork`, `networkPolicy`, drives, `openInteractive` PTY. Note that v4 needs Node ≥ 22.19.                                          |
| 2     | **beam**        | Fix the getter, use native `fs`, env/volumes/secrets. Consider a `beam` VM mode (pause keeps RAM, desktop).                                                                         |
| 3     | **northflank**  | `execServiceCommand`, status-object parsing, stream upload/download, port merge, containerSnapshot, ssh.                                                                            |
| 4     | **blaxel**      | `for await` list, split stdout/stderr, native streaming/background, `initialize()`, preview tokens, snapshot/fork/restore, network.                                                 |
| 5     | **e2b**         | Native `idempotencyKey`, `domain` passthrough, list filter, live state, fork, PTY, stdin, network, volumes, secrets, lifecycle, `Template` build.                                   |
| 6     | **daytona**     | Migrate to `@daytona/sdk`. Spike `v0` vs `v2` first; v2 is labelled alpha. Fix the TTL mapping, labels, snapshot/fork/ssh/network/secrets/metrics/pty.                              |
| 7     | **modal**       | `sandboxes.fromId`, native filesystem, `poll()`, tags/regions/volumes, network policy, `snapshotFilesystem`, PTY, connect tokens.                                                   |
| 8     | **railway**     | Fix the create overload, token passthrough, checkpoints, resources/region, stdin, kill, domains.                                                                                    |
| 9     | **cloudflare**  | Pin `0.12.14` now and mark it deprecated. Design a v1 adapter that wraps a user-supplied container Durable Object stub (it runs inside a Worker, so the constructor shape differs). |
| 10    | **fly**         | Fix the default `init`, exec timeout, stdin for writes, pagination, services for preview, volumes, secrets.                                                                         |
| 11    | **aws-lambda**  | Fix runner env, idle policy, real `getInfo`, pagination, token refresh, and the README build command. Add `templates.build` via `CreateMicrovmImage`.                               |
| 12    | **morph**       | Leak fixes (snapshot digest, branch snapshot cleanup), lifecycle, pause/ssh/streaming. Mark it **maintenance-only** because the TS SDK is abandoned.                                |
| —     | **runloop**     | Mark deprecated in 0.1.0 and remove in 0.2.0. Do the minimal tunnel-URL fix only if cheap.                                                                                          |
| —     | **codesandbox** | Mark deprecated and point to `together`. Fix the `destroy()` leak only.                                                                                                             |

### Phase 3: New adapters

**Tier 1 (this cycle):**

| Adapter      | SDK                                                                            | Why                                                                                                            | Effort |
| ------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------ |
| `superserve` | `@superserve/sdk`                                                              | Closest to E2B's shape: SSE exec, previews with per-port auth, snapshot and fork, egress, BuildSpec templates. | S      |
| `tensorlake` | `tensorlake` (has a native Rust binding, so we may want a REST client instead) | Broadest coverage: PTY, memory snapshots, clone, VNC desktop, GPU, Dockerfile builds.                          | M      |
| `sprites`    | `@fly/sprites` (Node ≥ 24)                                                     | Most traction among new entrants. Persistent and named; templates are checkpoints. Separate from `fly`.        | M      |
| `freestyle`  | `freestyle`                                                                    | Live copy-on-write fork with memory, a reattachable PTY, egress credential injection.                          | M      |
| `together`   | `together-sandbox`                                                             | Successor to CodeSandbox, with Dockerfile builds into snapshots. Exercises `resumeChangesId`.                  | M      |
| `docker`     | docker CLI / socket                                                            | Local parity for Borat (OrbStack, Docker Desktop, Colima, Podman). `templates.build` maps to `docker build`.   | M      |

**Tier 2 (next cycle):** Docker Cloud Sandboxes (once its SDK settles), Upstash Box, AWS Bedrock AgentCore Code Interpreter, Alibaba OpenSandbox, Azure Container Apps dynamic sessions, Koyeb, Microsandbox and LangSmith Sandboxes.

**Skip:** Deno Sandbox (closed to new customers), Runloop (winding down), OpenComputer (pivoting), Islo and Hopx (thin or stale SDKs), GKE agent-sandbox (no TS SDK), Riza and Vers (stale), and browser-only providers like Steel, Kernel and Browserbase (possibly a future `browser` capability).

### Phase 4: Docs, CLI, release

- Docs site:
  - adapter pages for the new and changed providers
  - a regenerated capability matrix
  - new guides: templates, previews and browser auth, lifecycle, PTY, egress/secrets, migrating 0.0.x → 0.1.0
- CLI: `sbox verify`, `sbox templates build`, and `sbox caps` with the new caps.
- `skills/sbox-sdk/SKILL.md` and the README provider table.
- Release `0.1.0` (`#minor`).

---

## 4. Borat requirement mapping

| #   | Need                                                                                             | Covered by                                                                                |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 1   | Template from a Dockerfile, built in the user's account, cached by content hash, progress events | §2.1 `templates.build` and inline `create({ template: spec })`                            |
| 2   | HTTP plus WebSocket preview from a browser, private auth via query/signed URL                    | §2.5 `wsUrl`, `auth`, `browserUrl()`, `previewBrowserAuth` flag                           |
| 3   | Pause/resume or snapshot, reconnect by id                                                        | §2.2 lifecycle, `connect(id, { resume })`, §2.3                                           |
| 4   | Binary upload/download                                                                           | Already in the API. Phase 0 adds live binary round-trip conformance and streaming upload. |
| 5   | CPU/memory/`shmMB`, TTL or auto-stop                                                             | §2.7 `shmMB`, §2.2 lifecycle                                                              |
| 6   | Cheap key check                                                                                  | §2.7 `provider.verify()`                                                                  |
| 7   | Local docker adapter                                                                             | Phase 3 `docker`                                                                          |

Best initial cloud targets for Borat's desktop image are **E2B, Daytona and Tensorlake**. All three have a Dockerfile build, browser-usable private previews, and memory pause.

---

## 5. Decisions (product owner, 2026-11-22)

1. **Breaking changes in 0.1.0: yes.** Deprecated aliases (`ttlMs`, `onIdle`, `snapshots.fork`, `network.createSsh`, `expose({ private })`) are kept for one minor.
2. **Runloop + CodeSandbox:** deprecated in 0.1.0, removed in 0.2.0. Only leak/crash fixes. CodeSandbox users are pointed to `together`.
3. **Cloudflare:** pin `@cloudflare/sandbox@0.12.x`, mark deprecated. A v1 (container Durable Object) adapter moves to Tier 2.
4. **Daytona:** move to `@daytona/sdk`, using its stable v0 API surface. v2 is revisited once it leaves alpha.
5. **Live testing:** opt-in per provider via env keys (`pnpm test:live`). No keys were available at planning time, so only `memory` and `docker` run live locally.
6. **`docker` adapter moves to the front of Tier 1** (Borat's local path).
7. **Driver template registry method is `lookup()`** (not `find`, which collides with lint rules for Array.find).
