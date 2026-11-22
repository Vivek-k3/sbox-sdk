/**
 * `sbox-sdk/cloud` — one API key, every provider. A client adapter for an sbox
 * gateway: provider keys, routing rules and analytics live in the gateway; your
 * code holds a single key.
 *
 *   import { cloud } from "sbox-sdk/cloud";
 *
 *   const client = createSandboxClient({
 *     provider: await cloud({ apiKey: process.env.SBOX_API_KEY, requires: ["snapshot"] }),
 *   });
 *
 * `cloud()` is async: it asks the gateway which capabilities your account's
 * routes share (honouring `requires`), so the sandbox API you get is exactly
 * what the gateway can serve. Previews are provider URLs and are not proxied.
 */
import type { CapabilityName } from "../internal/capabilities.js";
import { SandboxError } from "../internal/errors.js";
import { AsyncQueue } from "../internal/stream.js";
import type {
  CallContext,
  DriverExec,
  DriverHandle,
  DriverProcess,
  ExecOptions,
  OutputEvent,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxProvider,
  SnapshotRef,
} from "../internal/types.js";
import type { RouterCaps } from "../router/index.js";
import {
  IDEMPOTENCY_HEADER,
  PROTOCOL_VERSION,
  REQUIRES_HEADER,
  RPC_METHODS,
  decode,
  encode,
  fromWireError,
  readNdjson,
} from "./protocol.js";
import type {
  ExecRequest,
  RpcMethod,
  SessionInfo,
  StreamFrame,
  WireError,
} from "./protocol.js";

export * from "./protocol.js";

export interface CloudOptions<Req extends CapabilityName = never> {
  /** Gateway API key. Default: `process.env.SBOX_API_KEY`. */
  apiKey?: string;
  /**
   * Gateway origin (+ mount path). Default: `process.env.SBOX_BASE_URL`, else
   * the hosted gateway at `https://api.sbox-sdk.dev`.
   */
  baseUrl?: string;
  /** Capabilities every route must provide (same semantics as `router`). */
  requires?: readonly Req[];
  /** Injectable transport. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface CloudProvider<
  Req extends CapabilityName = never,
> extends SandboxProvider<RouterCaps<Req>, undefined> {
  /** Route names the gateway reported for this account. */
  readonly routes?: readonly string[];
}

const NAME = "cloud";

/** The hosted sbox gateway. */
export const DEFAULT_BASE_URL = "https://api.sbox-sdk.dev";

function env(key: string): string | undefined {
  return (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.[key];
}

function stripCtx(args: unknown[]): unknown[] {
  return args.slice(0, -1);
}

function execBody(cmd: string, opts: ExecOptions): ExecRequest {
  return {
    cmd,
    opts: {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      user: opts.user,
    },
  };
}

export async function cloud<const Req extends CapabilityName = never>(
  opts: CloudOptions<Req> = {}
): Promise<CloudProvider<Req>> {
  const apiKey = opts.apiKey ?? env("SBOX_API_KEY");
  const baseUrl = (
    opts.baseUrl ??
    env("SBOX_BASE_URL") ??
    DEFAULT_BASE_URL
  ).replace(/\/$/, "");
  if (!apiKey) {
    throw new SandboxError(
      "Unauthorized",
      "missing API key: pass `apiKey` or set SBOX_API_KEY",
      { provider: NAME }
    );
  }
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const requires = (opts.requires ?? []).join(",");

  const request = async (
    method: string,
    path: string,
    init: {
      json?: unknown;
      body?: BodyInit;
      signal?: AbortSignal;
      idempotencyKey?: string;
    } = {}
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      [REQUIRES_HEADER]: requires,
    };
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (init.idempotencyKey) {
      headers[IDEMPOTENCY_HEADER] = init.idempotencyKey;
    }
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/v1${path}`, {
        body: init.json === undefined ? init.body : encode(init.json),
        headers,
        method,
        signal: init.signal,
      });
    } catch (error) {
      throw SandboxError.wrap(error, NAME);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let wire: WireError | undefined;
      try {
        wire = decode<{ error?: WireError }>(text).error;
      } catch {
        // not a protocol error body
      }
      throw wire
        ? fromWireError(wire)
        : new SandboxError("Provider", `gateway HTTP ${res.status}`, {
            provider: NAME,
            status: res.status,
          });
    }
    return res;
  };

  const getJson = async <T>(res: Response): Promise<T> =>
    decode<T>(await res.text());

  // ---- session: learn what this account's routes can do -----------------
  const session = await getJson<SessionInfo>(
    await request("POST", "/session", { json: {} })
  );
  if (session.protocol !== PROTOCOL_VERSION) {
    throw new SandboxError(
      "Validation",
      `gateway speaks protocol v${session.protocol}; this SDK speaks v${PROTOCOL_VERSION}`,
      { provider: NAME }
    );
  }
  const caps = session.capabilities;
  const has = (cap: CapabilityName | null): boolean =>
    cap === null || caps[cap] !== "unsupported";

  const asInfo = (i: SandboxInfo): SandboxInfo => ({
    ...i,
    provider: NAME,
    raw: undefined,
  });
  const asSnap = (s: SnapshotRef): SnapshotRef => ({
    ...s,
    provider: NAME,
    raw: undefined,
  });
  const sbPath = (id: string): string => `/sandboxes/${encodeURIComponent(id)}`;

  /**
   * Turn an NDJSON exec response into a DriverExec. Reading starts eagerly so
   * `pid` resolves without anyone iterating.
   */
  const streamExec = (
    open: (signal: AbortSignal) => Promise<Response>,
    ctxSignal: AbortSignal | undefined,
    kill: (abort: () => void, signal?: string) => Promise<void>
  ): { exec: DriverExec; started: Promise<{ pid: string; id?: string }> } => {
    const ac = new AbortController();
    ctxSignal?.addEventListener("abort", () => ac.abort(ctxSignal.reason), {
      once: true,
    });
    const q = new AsyncQueue<OutputEvent>();
    let resolveStart!: (v: { pid: string; id?: string }) => void;
    let rejectStart!: (e: unknown) => void;
    const started = new Promise<{ pid: string; id?: string }>((res, rej) => {
      resolveStart = res;
      rejectStart = rej;
    });
    started.catch(() => undefined);
    void (async () => {
      try {
        const res = await open(ac.signal);
        for await (const frame of readNdjson<StreamFrame>(
          res.body!,
          ac.signal
        )) {
          if (frame.type === "start") {
            resolveStart({ id: frame.id, pid: frame.pid });
          } else if (frame.type === "error") {
            throw fromWireError(frame.error);
          } else {
            q.push(frame);
          }
        }
        q.close();
        rejectStart(
          new SandboxError("Provider", "stream ended before start", {
            provider: NAME,
          })
        );
      } catch (error) {
        const err = SandboxError.wrap(error, NAME);
        rejectStart(err);
        q.fail(err);
      }
    })();
    const exec: DriverExec = {
      [Symbol.asyncIterator]: () => q.iterator(),
      kill: (signal?: string) => kill(() => ac.abort(), signal),
      pid: started.then((s) => s.pid),
    };
    return { exec, started };
  };

  const buildHandle = (info: SandboxInfo): DriverHandle<undefined> => {
    const id = info.id;
    const rpc = async (
      method: RpcMethod,
      args: unknown[],
      ctx: CallContext
    ): Promise<unknown> => {
      const res = await request("POST", `${sbPath(id)}/rpc`, {
        json: { args, method },
        signal: ctx.signal,
      });
      return (await getJson<{ result: unknown }>(res)).result;
    };

    const killVia =
      (processId: () => Promise<string | undefined>) =>
      async (abort: () => void, signal?: string): Promise<void> => {
        const pid = await processId().catch(() => undefined);
        if (pid && has("killProcess")) {
          await rpc("killProcess", [pid, signal], {
            attempt: 1,
            fetch: fetchImpl,
          });
        }
        abort();
      };

    const handle: Record<string, unknown> = {
      destroy: async (ctx: CallContext) => {
        await request("DELETE", sbPath(id), { signal: ctx.signal });
      },
      exec: (cmd: string, o: ExecOptions, ctx: CallContext): DriverExec =>
        streamExec(
          (signal) =>
            request("POST", `${sbPath(id)}/exec`, {
              json: execBody(cmd, o),
              signal,
            }),
          ctx.signal,
          async (abort) => abort()
        ).exec,
      getInfo: async (ctx: CallContext) =>
        asInfo((await rpc("getInfo", [], ctx)) as SandboxInfo),
      id,
      name: info.name,
      raw: undefined,
      readFile: async (path: string, ctx: CallContext) => {
        const res = await request(
          "GET",
          `${sbPath(id)}/files?path=${encodeURIComponent(path)}`,
          { signal: ctx.signal }
        );
        return new Uint8Array(await res.arrayBuffer());
      },
      writeFile: async (path: string, data: Uint8Array, ctx: CallContext) => {
        await request(
          "PUT",
          `${sbPath(id)}/files?path=${encodeURIComponent(path)}`,
          { body: data as BodyInit, signal: ctx.signal }
        );
      },
    };

    // RPC-backed optional methods, present exactly when the cap allows them.
    for (const [m, cap] of Object.entries(RPC_METHODS) as [
      RpcMethod,
      CapabilityName | null,
    ][]) {
      if (m === "getInfo" || !has(cap)) {
        continue;
      }
      if (m === "resume" && !has("pause") && !has("stop")) {
        continue;
      }
      handle[m] = async (...args: unknown[]) => {
        const ctx = args.at(-1) as CallContext;
        const result = await rpc(m, stripCtx(args), ctx);
        switch (m) {
          case "fork": {
            return (result as SandboxInfo[]).map((i) => buildHandle(asInfo(i)));
          }
          case "snapshot": {
            return asSnap(result as SnapshotRef);
          }
          case "listSnapshots": {
            return (result as SnapshotRef[]).map(asSnap);
          }
          default: {
            return result ?? undefined;
          }
        }
      };
    }

    if (has("background")) {
      const proc = async (
        open: (signal: AbortSignal) => Promise<Response>,
        ctx: CallContext
      ): Promise<DriverProcess> => {
        const { exec, started } = streamExec(open, ctx.signal, (abort, sig) =>
          killVia(() => started.then((st) => st.id ?? st.pid))(abort, sig)
        );
        const s = await started;
        return Object.assign(exec, { id: s.id ?? s.pid });
      };
      handle.spawn = (cmd: string, o: ExecOptions, ctx: CallContext) =>
        proc(
          (signal) =>
            request("POST", `${sbPath(id)}/processes`, {
              json: execBody(cmd, o),
              signal,
            }),
          ctx
        );
      handle.connectProcess = (pid: string, ctx: CallContext) =>
        proc(
          (signal) =>
            request(
              "GET",
              `${sbPath(id)}/processes/${encodeURIComponent(pid)}`,
              { signal }
            ),
          ctx
        );
    }

    return handle as unknown as DriverHandle<undefined>;
  };

  const provider: CloudProvider<Req> = {
    capabilities: caps as RouterCaps<Req>,
    flags: session.flags,
    name: NAME,
    routes: session.routes,

    async create(spec: ResolvedSandboxSpec, ctx: CallContext) {
      // Signals and callbacks can't cross the wire.
      const { signal: _signal, ...wireSpec } = spec;
      const res = await request("POST", "/sandboxes", {
        idempotencyKey: spec.idempotencyKey ?? ctx.idempotencyKey,
        json: { spec: wireSpec },
        signal: ctx.signal,
      });
      const { info } = await getJson<{ info: SandboxInfo }>(res);
      return buildHandle(asInfo(info));
    },

    async connect(id: string, ctx: CallContext) {
      const res = await request("GET", sbPath(id), { signal: ctx.signal });
      const { info } = await getJson<{ info: SandboxInfo }>(res);
      return buildHandle(asInfo(info));
    },

    async verify(ctx: CallContext) {
      await request("POST", "/session", { json: {}, signal: ctx.signal });
      return { account: session.routes?.join(",") };
    },
  };

  if (has("list")) {
    provider.list = async function* list(filter, ctx) {
      const q = filter ? `?filter=${encodeURIComponent(encode(filter))}` : "";
      const res = await request("GET", `/sandboxes${q}`, {
        signal: ctx.signal,
      });
      const { items } = await getJson<{ items: SandboxInfo[] }>(res);
      for (const i of items) {
        yield asInfo(i);
      }
    };
  }

  return provider;
}
