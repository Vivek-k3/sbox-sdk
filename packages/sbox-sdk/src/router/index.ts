import type {
  CapabilityFlags,
  CapabilityLevel,
  CapabilityMap,
  CapabilityName,
  EgressMode,
  TemplateSourceKind,
} from "../internal/capabilities.js";
/**
 * `sbox-sdk/router` — route `create()` across several providers, the way an LLM
 * router picks a model. The router is itself a `SandboxProvider`, so it plugs
 * into `createSandboxClient` like any adapter:
 *
 *   const client = createSandboxClient({
 *     provider: router({
 *       candidates: [e2b({ apiKey }), { provider: daytona({ apiKey }), costPerHour: 0.05 }],
 *       requires: ["snapshot", "pty"],
 *       strategy: "cheapest",
 *     }),
 *   });
 *
 * Semantics worth knowing:
 * - Routing happens at create time. A sandbox holds state, so it stays on the
 *   provider it was created on; there is no per-call routing.
 * - The router promises only what EVERY eligible route can do: its capability
 *   map is the per-capability minimum across candidates that satisfy
 *   `requires`. Ask for what you need in `requires` and the router drops the
 *   candidates that can't provide it.
 * - Sandbox ids are prefixed with the route name (`e2b:abc123`) so `connect()`
 *   knows where a sandbox lives. Use `routeOf(id)` to read it back.
 * - Failover is safe by default: the router moves to the next candidate only
 *   when the error proves no VM was created (bad credentials, quota, not
 *   supported, validation), or when the caller passed `idempotencyKey`.
 * - Template builds and volumes are provider-scoped and not routed in v1.
 */
import { AllProvidersFailedError, SandboxError } from "../internal/errors.js";
import type { ProviderAttempt } from "../internal/errors.js";
import type {
  CallContext,
  DriverExec,
  MaybePromise,
  DriverHandle,
  DriverPty,
  ListFilter,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxProvider,
  SnapshotRef,
} from "../internal/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RouteCandidate {
  provider: SandboxProvider;
  /** Route key, used as the id prefix. Defaults to `provider.name`. Must be unique. */
  name?: string;
  /** Provider-specific template used when the spec doesn't set one. */
  template?: string;
  /** Regions this route can serve. If set, a spec `region` must be in it. */
  regions?: readonly string[];
  /** Price hint (any unit, consistently) for the `"cheapest"` strategy. */
  costPerHour?: number;
}

/** What a strategy sees about each eligible route. */
export interface RouteInfo {
  readonly name: string;
  readonly provider: string;
  readonly costPerHour?: number;
  readonly regions?: readonly string[];
  /** Smoothed create latency (ms), undefined until the first success. */
  readonly latencyMs?: number;
  readonly successes: number;
  readonly failures: number;
  /** True while the route is cooling down after repeated failures. */
  readonly unhealthy: boolean;
}

/** Persisted health/latency for one route. */
export interface RouteStat {
  /** Smoothed create latency (ms). */
  latencyMs?: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  /** Epoch ms until which the route is demoted. */
  unhealthyUntil: number;
}

/**
 * Where routing stats live. The default keeps them in process memory; on
 * serverless hosts (Vercel) back it with Redis or Postgres so every instance
 * routes on the same data. Writes are read-modify-write: concurrent updates may
 * race, which is acceptable for a routing heuristic.
 */
export interface RouteStatsStore {
  load(
    routes: readonly string[]
  ): MaybePromise<Readonly<Record<string, RouteStat | undefined>>>;
  save(route: string, stat: RouteStat): MaybePromise<void>;
}

/** The default in-process store. */
export function memoryStatsStore(): RouteStatsStore {
  const stats = new Map<string, RouteStat>();
  return {
    load(routes) {
      const out: Record<string, RouteStat | undefined> = {};
      for (const r of routes) {
        const s = stats.get(r);
        out[r] = s && { ...s };
      }
      return out;
    },
    save(route, stat) {
      stats.set(route, { ...stat });
    },
  };
}

export type RouteStrategyFn = (
  routes: readonly RouteInfo[],
  spec: ResolvedSandboxSpec
) => readonly string[] | readonly RouteInfo[];

export type RouteStrategy =
  | "priority"
  | "cheapest"
  | "fastest"
  | "round-robin"
  | RouteStrategyFn;

export type RouteEvent =
  | { type: "selected"; order: string[] }
  | { type: "attempt"; route: string }
  | { type: "success"; route: string; ms: number }
  | { type: "failure"; route: string; error: SandboxError; failover: boolean };

export interface RouterOptions<Req extends CapabilityName = never> {
  candidates: readonly (SandboxProvider | RouteCandidate)[];
  /** Capabilities every route must provide. Candidates lacking one are dropped. */
  requires?: readonly Req[];
  /** How to order routes for a create. Default `"priority"` (declaration order). */
  strategy?: RouteStrategy;
  /**
   * When to try the next route after a create fails.
   * - `"safe"` (default): only on errors that prove no VM was created, or when
   *   the caller passed `idempotencyKey`.
   * - `"always"`: on any error (may orphan a VM on an ambiguous timeout).
   * - `"never"`: fail on the first error.
   */
  failover?: "safe" | "always" | "never";
  /** Consecutive failures before a route is demoted. Default 3. */
  unhealthyAfter?: number;
  /** How long a demoted route stays demoted. Default 60s. */
  cooldownMs?: number;
  /** Where routing stats live. Default: in process memory. */
  statsStore?: RouteStatsStore;
  /** Observe routing decisions (logging, metrics, billing). */
  onRoute?: (event: RouteEvent) => void;
}

/** Required caps are guaranteed at the type level; the rest may be unsupported. */
export type RouterCaps<Req extends CapabilityName> = {
  [K in CapabilityName]: K extends Req
    ? Exclude<CapabilityLevel, "unsupported">
    : CapabilityLevel;
};

export interface RouterProvider<
  Req extends CapabilityName = never,
> extends SandboxProvider<RouterCaps<Req>, unknown> {
  /** Names of the routes that survived `requires`, in declaration order. */
  readonly routes: readonly string[];
  /** Live per-route stats (latency, failures, health). */
  stats(): Promise<RouteInfo[]>;
}

// ---------------------------------------------------------------------------
// Id helpers
// ---------------------------------------------------------------------------

const SEP = ":";

/** Split a router id (`e2b:abc123`) into its route and the provider's own id. */
export function routeOf(
  idOrSandbox: string | { id: string }
): { route: string; id: string } | undefined {
  const full = typeof idOrSandbox === "string" ? idOrSandbox : idOrSandbox.id;
  const at = full.indexOf(SEP);
  if (at <= 0) {
    return undefined;
  }
  return { id: full.slice(at + SEP.length), route: full.slice(0, at) };
}

// ---------------------------------------------------------------------------
// Capability + flag merging
// ---------------------------------------------------------------------------

const RANK: Record<CapabilityLevel, number> = {
  emulated: 1,
  native: 2,
  unsupported: 0,
};

/** Provider-scoped features the router does not route (yet). */
const UNROUTED: ReadonlySet<CapabilityName> = new Set([
  "templateBuild",
  "volumes",
]);

function minLevel(levels: CapabilityLevel[]): CapabilityLevel {
  let best: CapabilityLevel = "native";
  for (const l of levels) {
    if (RANK[l] < RANK[best]) {
      best = l;
    }
  }
  return best;
}

function mergeCaps(providers: SandboxProvider[]): CapabilityMap {
  const out = {} as Record<CapabilityName, CapabilityLevel>;
  const names = Object.keys(providers[0]!.capabilities) as CapabilityName[];
  for (const name of names) {
    out[name] = UNROUTED.has(name)
      ? "unsupported"
      : minLevel(providers.map((p) => p.capabilities[name]));
  }
  return out as CapabilityMap;
}

function intersect<T>(lists: (readonly T[])[]): T[] {
  const [first = [], ...rest] = lists;
  return first.filter((x) => rest.every((l) => l.includes(x)));
}

/**
 * Behavioural flags change how the core drives exec, so they must hold for
 * every route. Where routes disagree we pick the conservative value: e.g.
 * `exitCodeNative: false` makes the core use its exit marker, which works on
 * every provider.
 */
function mergeFlags(providers: SandboxProvider[]): CapabilityFlags {
  const fs = providers.map((p) => p.flags);
  const all = (k: keyof CapabilityFlags): boolean =>
    fs.every((f) => f[k] === true);
  return {
    egressModes: intersect<EgressMode>(
      fs.map(
        (f) =>
          f.egressModes ?? (["allow-all", "block-all", "allow-list"] as const)
      )
    ),
    exitCodeNative: all("exitCodeNative"),
    perCommandEnvCwd: all("perCommandEnvCwd"),
    preservesDiskOnStop: all("preservesDiskOnStop"),
    preservesMemoryOnPause: all("preservesMemoryOnPause"),
    previewBrowserAuth: all("previewBrowserAuth"),
    // Informational only; routes may differ, so report the first route's.
    previewModel: fs[0]!.previewModel,
    resumeChangesId: fs.some((f) => f.resumeChangesId === true),
    templateSources: [] as TemplateSourceKind[],
  };
}

// ---------------------------------------------------------------------------
// Handle wrapping
// ---------------------------------------------------------------------------

/** Handle methods that exist only when a capability is supported. */
const GATED_METHODS: Partial<Record<CapabilityName, (keyof DriverHandle)[]>> = {
  background: ["spawn", "connectProcess", "listProcesses"],
  codeInterpreter: ["runCode"],
  egressControl: ["setEgressPolicy"],
  exposePort: ["exposePort", "unexposePort", "listPorts"],
  filesWatch: ["watch"],
  fork: ["fork"],
  killProcess: ["killProcess"],
  metrics: ["getMetrics"],
  pause: ["pause"],
  proxiedFetch: ["proxyFetch"],
  pty: ["createPty", "connectPty"],
  setTimeout: ["setTimeout"],
  snapshot: ["snapshot", "restoreSnapshot", "listSnapshots", "deleteSnapshot"],
  ssh: ["createSsh"],
  statefulKernel: ["createContext"],
  stop: ["stop"],
};

interface Route {
  name: string;
  provider: SandboxProvider;
  template?: string;
  regions?: readonly string[];
  costPerHour?: number;
}

const EMPTY_STAT: RouteStat = {
  consecutiveFailures: 0,
  failures: 0,
  successes: 0,
  unhealthyUntil: 0,
};

function mapErr(p: SandboxProvider, e: unknown): SandboxError {
  if (e instanceof SandboxError) {
    return e;
  }
  return p.mapError?.(e) ?? SandboxError.wrap(e, p.name);
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

/** Wrap an async iterable so errors thrown mid-stream are normalized. */
function mapIterable<T>(
  p: SandboxProvider,
  src: AsyncIterable<T>
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const it = src[Symbol.asyncIterator]();
      return {
        async next() {
          try {
            return await it.next();
          } catch (e) {
            throw mapErr(p, e);
          }
        },
        async return(value?: unknown) {
          return (await it.return?.(value)) ?? { done: true, value: undefined };
        },
      } as AsyncIterator<T>;
    },
  };
}

function wrapExec<E extends DriverExec>(p: SandboxProvider, ex: E): E {
  const iter = mapIterable(p, ex);
  return new Proxy(ex, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return iter[Symbol.asyncIterator].bind(iter);
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

function wrapPty(p: SandboxProvider, pty: DriverPty): DriverPty {
  return new Proxy(pty, {
    get(target, prop, receiver) {
      if (prop === "output") {
        return mapIterable(p, target.output);
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const ROUTER = "router";

/** The provider that served a route is kept in metadata for observability. */
const ROUTE_META_KEY = "sbox.route";

function wrapInfo(route: Route, info: SandboxInfo): SandboxInfo {
  return {
    ...info,
    id: `${route.name}${SEP}${info.id}`,
    metadata: { ...info.metadata, [ROUTE_META_KEY]: route.name },
    provider: ROUTER,
  };
}

function wrapSnapshot(route: Route, ref: SnapshotRef): SnapshotRef {
  return { ...ref, id: `${route.name}${SEP}${ref.id}`, provider: ROUTER };
}

/** Strip this route's prefix from an id argument (snapshot refs). */
function unwrapId(route: Route, id: string): string {
  const parsed = routeOf(id);
  if (!parsed) {
    return id;
  }
  if (parsed.route !== route.name) {
    throw new SandboxError(
      "Validation",
      `router: '${id}' belongs to route '${parsed.route}', not '${route.name}'`,
      { provider: ROUTER }
    );
  }
  return parsed.id;
}

function wrapHandle(
  route: Route,
  inner: DriverHandle,
  caps: CapabilityMap
): DriverHandle {
  const p = route.provider;
  const out: Record<string, unknown> = {
    id: `${route.name}${SEP}${inner.id}`,
    name: inner.name,
    raw: inner.raw,
  };

  const hidden = new Set<string>();
  for (const [cap, methods] of Object.entries(GATED_METHODS) as [
    CapabilityName,
    (keyof DriverHandle)[],
  ][]) {
    if (caps[cap] === "unsupported") {
      for (const m of methods) {
        hidden.add(m);
      }
    }
  }
  if (caps.pause === "unsupported" && caps.stop === "unsupported") {
    hidden.add("resume");
  }

  // Walk own + prototype members so class-based handles are covered too.
  const keys = new Set<string>();
  for (
    let o: object | null = inner;
    o && o !== Object.prototype;
    o = Object.getPrototypeOf(o) as object | null
  ) {
    for (const k of Object.getOwnPropertyNames(o)) {
      keys.add(k);
    }
  }

  for (const key of keys) {
    if (key === "constructor" || key in out || hidden.has(key)) {
      continue;
    }
    const fn = (inner as unknown as Record<string, unknown>)[key];
    if (typeof fn !== "function") {
      continue;
    }
    out[key] = (...args: unknown[]): unknown => {
      if (
        (key === "restoreSnapshot" || key === "deleteSnapshot") &&
        typeof args[0] === "string"
      ) {
        args = [unwrapId(route, args[0]), ...args.slice(1)];
      }
      let result: unknown;
      try {
        result = (fn as (...a: unknown[]) => unknown).apply(inner, args);
      } catch (e) {
        throw mapErr(p, e);
      }
      const post = (v: unknown): unknown => {
        if (key === "getInfo") {
          return wrapInfo(route, v as SandboxInfo);
        }
        if (key === "snapshot") {
          return wrapSnapshot(route, v as SnapshotRef);
        }
        if (key === "listSnapshots") {
          return (v as SnapshotRef[]).map((r) => wrapSnapshot(route, r));
        }
        if (key === "fork") {
          return (v as DriverHandle[]).map((h) => wrapHandle(route, h, caps));
        }
        if (key === "createPty" || key === "connectPty") {
          return wrapPty(p, v as DriverPty);
        }
        if (key === "exec" || key === "spawn" || key === "connectProcess") {
          return wrapExec(p, v as DriverExec);
        }
        return v;
      };
      if (isThenable(result)) {
        return Promise.resolve(result).then(post, (e: unknown) => {
          throw mapErr(p, e);
        });
      }
      return post(result);
    };
  }
  return out as unknown as DriverHandle;
}

// ---------------------------------------------------------------------------
// Failover policy
// ---------------------------------------------------------------------------

/** Errors that prove the provider rejected the create before making a VM. */
const DEFINITELY_NO_VM = new Set<SandboxError["code"]>([
  "Unauthorized",
  "QuotaExceeded",
  "NotSupported",
  "Validation",
  "ProviderNotFound",
]);

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function router<const Req extends CapabilityName = never>(
  opts: RouterOptions<Req>
): RouterProvider<Req> {
  const requires = (opts.requires ?? []) as readonly CapabilityName[];
  for (const r of requires) {
    if (UNROUTED.has(r)) {
      throw new SandboxError(
        "Validation",
        `router: '${r}' is provider-scoped and cannot be required of a router yet`,
        { provider: ROUTER }
      );
    }
  }

  const all: Route[] = opts.candidates.map((c) => {
    const cand: RouteCandidate = "provider" in c ? c : { provider: c };
    return {
      costPerHour: cand.costPerHour,
      name: cand.name ?? cand.provider.name,
      provider: cand.provider,
      regions: cand.regions,
      template: cand.template,
    };
  });

  const seen = new Set<string>();
  for (const r of all) {
    if (!r.name || r.name.includes(SEP)) {
      throw new SandboxError(
        "Validation",
        `router: route name '${r.name}' must be non-empty and contain no '${SEP}'`,
        { provider: ROUTER }
      );
    }
    if (seen.has(r.name)) {
      throw new SandboxError(
        "Validation",
        `router: duplicate route '${r.name}'. Give one candidate a distinct \`name\`.`,
        { provider: ROUTER }
      );
    }
    seen.add(r.name);
  }

  const routes = all.filter((r) =>
    requires.every((cap) => r.provider.capabilities[cap] !== "unsupported")
  );
  if (routes.length === 0) {
    throw new SandboxError(
      "Validation",
      `router: no candidate provides all of [${requires.join(", ")}]`,
      { provider: ROUTER }
    );
  }
  const byName = new Map(routes.map((r) => [r.name, r]));
  const providers = routes.map((r) => r.provider);
  const capabilities = mergeCaps(providers);
  const flags = mergeFlags(providers);

  const strategy = opts.strategy ?? "priority";
  const failover = opts.failover ?? "safe";
  const unhealthyAfter = opts.unhealthyAfter ?? 3;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const store = opts.statsStore ?? memoryStatsStore();
  let rr = 0;

  const loadStats = async (
    names: readonly string[]
  ): Promise<Map<string, RouteStat>> => {
    const raw = await store.load(names);
    return new Map(names.map((n) => [n, raw[n] ?? EMPTY_STAT]));
  };

  const info = (r: Route, st: RouteStat, now: number): RouteInfo => ({
    costPerHour: r.costPerHour,
    failures: st.failures,
    latencyMs: st.latencyMs,
    name: r.name,
    provider: r.provider.name,
    regions: r.regions,
    successes: st.successes,
    unhealthy: st.unhealthyUntil > now,
  });

  const order = async (spec: ResolvedSandboxSpec): Promise<Route[]> => {
    const now = Date.now();
    // A snapshot lives on one provider: booting from it pins the route.
    const snap = spec.fromSnapshot ? routeOf(spec.fromSnapshot) : undefined;
    if (snap) {
      const pinned = byName.get(snap.route);
      if (!pinned) {
        throw new SandboxError(
          "NotFound",
          `router: snapshot '${spec.fromSnapshot}' is on unknown route '${snap.route}'`,
          { provider: ROUTER }
        );
      }
      return [pinned];
    }
    const eligible = routes.filter(
      (r) => !spec.region || !r.regions || r.regions.includes(spec.region)
    );
    if (eligible.length === 0) {
      throw new SandboxError(
        "Validation",
        `router: no route serves region '${spec.region}'`,
        { provider: ROUTER }
      );
    }
    const stats = await loadStats(eligible.map((r) => r.name));
    const st = (r: Route): RouteStat => stats.get(r.name) ?? EMPTY_STAT;
    let ordered: Route[];
    if (typeof strategy === "function") {
      const picked = strategy(
        eligible.map((r) => info(r, st(r), now)),
        spec
      );
      ordered = picked
        .map((x) => byName.get(typeof x === "string" ? x : x.name))
        .filter((r): r is Route => !!r && eligible.includes(r));
      if (ordered.length === 0) {
        throw new SandboxError(
          "Validation",
          "router: strategy returned no eligible routes",
          { provider: ROUTER }
        );
      }
    } else if (strategy === "cheapest") {
      ordered = eligible.toSorted(
        (a, b) =>
          (a.costPerHour ?? Number.POSITIVE_INFINITY) -
          (b.costPerHour ?? Number.POSITIVE_INFINITY)
      );
    } else if (strategy === "fastest") {
      // Unmeasured routes go first so every route gets measured once.
      ordered = eligible.toSorted(
        (a, b) => (st(a).latencyMs ?? -1) - (st(b).latencyMs ?? -1)
      );
    } else if (strategy === "round-robin") {
      const start = rr++ % eligible.length;
      ordered = [...eligible.slice(start), ...eligible.slice(0, start)];
    } else {
      ordered = [...eligible];
    }
    // Demote (don't drop) routes that are cooling down. Stable sort keeps order.
    return ordered.toSorted(
      (a, b) =>
        Number(st(a).unhealthyUntil > now) - Number(st(b).unhealthyUntil > now)
    );
  };

  /** Stats must never break a create: store errors are swallowed. */
  const record = async (r: Route, ms: number | undefined): Promise<void> => {
    try {
      const prev = (await loadStats([r.name])).get(r.name) ?? EMPTY_STAT;
      const next: RouteStat =
        ms === undefined
          ? {
              ...prev,
              consecutiveFailures: prev.consecutiveFailures + 1,
              failures: prev.failures + 1,
              unhealthyUntil:
                prev.consecutiveFailures + 1 >= unhealthyAfter
                  ? Date.now() + cooldownMs
                  : prev.unhealthyUntil,
            }
          : {
              consecutiveFailures: 0,
              failures: prev.failures,
              latencyMs:
                prev.latencyMs === undefined
                  ? ms
                  : prev.latencyMs * 0.7 + ms * 0.3,
              successes: prev.successes + 1,
              unhealthyUntil: 0,
            };
      await store.save(r.name, next);
    } catch {
      // ignore: routing falls back to stale stats
    }
  };

  const canFailover = (
    err: SandboxError,
    spec: ResolvedSandboxSpec
  ): boolean => {
    if (err.aborted || failover === "never") {
      return false;
    }
    if (failover === "always") {
      return true;
    }
    return DEFINITELY_NO_VM.has(err.code) || !!spec.idempotencyKey;
  };

  const provider: RouterProvider<Req> = {
    capabilities: capabilities as RouterCaps<Req>,
    flags,
    name: ROUTER,
    routes: routes.map((r) => r.name),

    mapError(e) {
      return e instanceof SandboxError ? e : undefined;
    },

    async stats() {
      const now = Date.now();
      const stats = await loadStats(routes.map((r) => r.name));
      return routes.map((r) => info(r, stats.get(r.name) ?? EMPTY_STAT, now));
    },

    async create(spec, ctx) {
      const ordered = await order(spec);
      opts.onRoute?.({ order: ordered.map((r) => r.name), type: "selected" });
      const attempts: ProviderAttempt[] = [];
      for (const r of ordered) {
        opts.onRoute?.({ route: r.name, type: "attempt" });
        const routed: ResolvedSandboxSpec = {
          ...spec,
          ...(spec.template === undefined && r.template !== undefined
            ? { template: r.template }
            : {}),
          ...(spec.fromSnapshot
            ? { fromSnapshot: unwrapId(r, spec.fromSnapshot) }
            : {}),
        };
        const startedAt = Date.now();
        try {
          const inner = await r.provider.create(routed, ctx);
          const ms = Date.now() - startedAt;
          await record(r, ms);
          opts.onRoute?.({ ms, route: r.name, type: "success" });
          return wrapHandle(r, inner, capabilities);
        } catch (e) {
          const err = mapErr(r.provider, e);
          await record(r, undefined);
          const next = canFailover(err, spec);
          opts.onRoute?.({
            error: err,
            failover: next,
            route: r.name,
            type: "failure",
          });
          attempts.push({ error: err, provider: r.name });
          if (!next) {
            break;
          }
        }
      }
      if (attempts.length === 1) {
        throw attempts[0]!.error;
      }
      throw new AllProvidersFailedError(attempts);
    },

    async connect(id, ctx) {
      const parsed = routeOf(id);
      const r = parsed && byName.get(parsed.route);
      if (!parsed || !r) {
        throw new SandboxError(
          "NotFound",
          `router: '${id}' has no known route prefix (routes: ${[...byName.keys()].join(", ")})`,
          { provider: ROUTER }
        );
      }
      try {
        return wrapHandle(
          r,
          await r.provider.connect(parsed.id, ctx),
          capabilities
        );
      } catch (e) {
        throw mapErr(r.provider, e);
      }
    },

    async verify(ctx) {
      const results = await Promise.allSettled(
        routes.map(async (r) => r.provider.verify?.(ctx))
      );
      const failed: ProviderAttempt[] = [];
      for (const [i, res] of results.entries()) {
        if (res.status === "rejected") {
          failed.push({
            error: mapErr(routes[i]!.provider, res.reason),
            provider: routes[i]!.name,
          });
        }
      }
      if (failed.length > 0) {
        throw new AllProvidersFailedError(failed);
      }
      return { account: routes.map((r) => r.name).join(",") };
    },

    async dispose() {
      await Promise.allSettled(routes.map(async (r) => r.provider.dispose?.()));
    },
  };

  if (capabilities.list !== "unsupported") {
    provider.list = async function* list(
      filter: ListFilter | undefined,
      ctx: CallContext
    ) {
      for (const r of routes) {
        const src = r.provider.list;
        if (!src) {
          continue;
        }
        try {
          for await (const i of src.call(r.provider, filter, ctx)) {
            yield wrapInfo(r, i);
          }
        } catch (e) {
          throw mapErr(r.provider, e);
        }
      }
    };
  }

  return provider;
}
