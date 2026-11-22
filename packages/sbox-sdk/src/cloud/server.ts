/**
 * `sbox-sdk/cloud/server` — the protocol half of an sbox gateway. A
 * Web-standard `(Request) => Promise<Response>` handler, so it mounts as-is in
 * a Next.js route handler, Hono, Bun.serve, or a Vercel Function:
 *
 *   // app/api/[...path]/route.ts
 *   const handler = createGatewayHandler({
 *     basePath: "/api",
 *     resolve: async (req, { requires }) => {
 *       const account = await authenticate(req);      // your auth
 *       return router({ candidates: await providersFor(account), requires });
 *     },
 *     onEvent: (e, req) => recordUsage(e, req),       // your analytics
 *   });
 *   export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
 *
 * It is stateless: every request re-resolves the provider and reconnects to the
 * sandbox by id. Auth, key storage, metering and billing belong to the host.
 */
import type {
  CapabilityMap,
  CapabilityName,
} from "../internal/capabilities.js";
import { SandboxError } from "../internal/errors.js";
import type {
  CallContext,
  DriverExec,
  DriverHandle,
  ListFilter,
  ResolvedSandboxSpec,
  SandboxProvider,
} from "../internal/types.js";
import {
  IDEMPOTENCY_HEADER,
  PROTOCOL_VERSION,
  REQUIRES_HEADER,
  RPC_METHODS,
  encode,
  statusFor,
  toWireError,
  wireCapabilities,
  wireFlags,
} from "./protocol.js";
import type {
  ExecRequest,
  RpcMethod,
  RpcRequest,
  SessionInfo,
  StreamFrame,
} from "./protocol.js";

/** What happened, for usage analytics and billing. */
export type GatewayEvent =
  | {
      type: "sandbox.create";
      sandboxId?: string;
      ok: boolean;
      ms: number;
      error?: string;
    }
  | { type: "sandbox.destroy"; sandboxId: string; ok: boolean; ms: number }
  | {
      type: "exec";
      sandboxId: string;
      background: boolean;
      ok: boolean;
      ms: number;
      exitCode?: number;
    }
  | {
      type: "files.read" | "files.write";
      sandboxId: string;
      bytes: number;
      ok: boolean;
      ms: number;
    }
  | {
      type: "rpc";
      sandboxId: string;
      method: RpcMethod;
      ok: boolean;
      ms: number;
    };

export interface GatewayResolveContext {
  /** Capabilities the client requires; pass them to `router({ requires })`. */
  requires: CapabilityName[];
}

export interface GatewayHandlerOptions {
  /**
   * Authenticate the request and return the provider to serve it (normally a
   * `router()` over the account's providers). Throw a `SandboxError`
   * (`Unauthorized`, `QuotaExceeded`, ...) to reject.
   */
  resolve(
    req: Request,
    ctx: GatewayResolveContext
  ): SandboxProvider | Promise<SandboxProvider>;
  /** Path prefix the handler is mounted under, e.g. "/api". Default "". */
  basePath?: string;
  /** Usage events. Never awaited on the request path; errors are ignored. */
  onEvent?(event: GatewayEvent, req: Request): void | Promise<void>;
  /** Keep event delivery alive past the response (e.g. Vercel `waitUntil`). */
  waitUntil?(promise: Promise<unknown>): void;
  /** Injected into the adapter `CallContext`. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

const json = (body: unknown, status = 200): Response =>
  new Response(encode(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const fail = (err: unknown): Response => {
  const error = toWireError(err);
  return json({ error }, statusFor(error.code));
};

function bad(message: string): SandboxError {
  return new SandboxError("Validation", message, { provider: "gateway" });
}

export function createGatewayHandler(
  opts: GatewayHandlerOptions
): (req: Request) => Promise<Response> {
  const base = (opts.basePath ?? "").replace(/\/$/, "");
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  return async (req: Request): Promise<Response> => {
    const emit = (event: GatewayEvent): void => {
      if (!opts.onEvent) {
        return;
      }
      const p = Promise.resolve()
        .then(() => opts.onEvent!(event, req))
        .catch(() => undefined);
      opts.waitUntil?.(p);
    };

    try {
      const url = new URL(req.url);
      if (!url.pathname.startsWith(`${base}/v1/`)) {
        throw new SandboxError("NotFound", `no route ${url.pathname}`, {
          provider: "gateway",
        });
      }
      const parts = url.pathname
        .slice(base.length + "/v1/".length)
        .split("/")
        .map((p) => decodeURIComponent(p));

      const requires = (req.headers.get(REQUIRES_HEADER) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as CapabilityName[];
      const provider = await opts.resolve(req, { requires });
      const caps: CapabilityMap = wireCapabilities(provider.capabilities);

      const ctx = (idempotencyKey?: string): CallContext => ({
        attempt: 1,
        fetch: fetchImpl,
        idempotencyKey,
        signal: req.signal,
      });

      const method = req.method.toUpperCase();
      const [root, id, sub, subId] = parts;

      // ---- session -------------------------------------------------------
      if (root === "session" && method === "POST") {
        const info: SessionInfo = {
          capabilities: caps,
          flags: wireFlags(provider.flags),
          protocol: PROTOCOL_VERSION,
          routes: (provider as { routes?: string[] }).routes,
        };
        return json(info);
      }

      if (root !== "sandboxes") {
        throw new SandboxError("NotFound", `no route ${url.pathname}`, {
          provider: "gateway",
        });
      }

      // ---- collection ----------------------------------------------------
      if (id === undefined) {
        if (method === "POST") {
          const { spec } = (await req.json()) as { spec: ResolvedSandboxSpec };
          const started = Date.now();
          try {
            const handle = await provider.create(
              spec ?? {},
              ctx(req.headers.get(IDEMPOTENCY_HEADER) ?? undefined)
            );
            const info = await handle.getInfo(ctx());
            emit({
              ms: Date.now() - started,
              ok: true,
              sandboxId: handle.id,
              type: "sandbox.create",
            });
            return json({ info }, 201);
          } catch (error) {
            emit({
              error: toWireError(error).code,
              ms: Date.now() - started,
              ok: false,
              type: "sandbox.create",
            });
            throw error;
          }
        }
        if (method === "GET") {
          if (caps.list === "unsupported" || !provider.list) {
            throw new SandboxError("NotSupported", "list is not supported", {
              provider: "gateway",
            });
          }
          const raw = url.searchParams.get("filter");
          const filter = raw ? (JSON.parse(raw) as ListFilter) : undefined;
          const items = [];
          for await (const i of provider.list(filter, ctx())) {
            items.push(i);
          }
          return json({ items });
        }
        throw bad(`method ${method} not allowed on /sandboxes`);
      }

      const handle = await provider.connect(id, ctx());

      // ---- one sandbox ---------------------------------------------------
      if (sub === undefined) {
        if (method === "GET") {
          return json({ info: await handle.getInfo(ctx()) });
        }
        if (method === "DELETE") {
          const started = Date.now();
          let ok = false;
          try {
            await handle.destroy(ctx());
            ok = true;
          } finally {
            emit({
              ms: Date.now() - started,
              ok,
              sandboxId: id,
              type: "sandbox.destroy",
            });
          }
          return new Response(null, { status: 204 });
        }
      }

      if (sub === "exec" && method === "POST") {
        const body = (await req.json()) as ExecRequest;
        return streamExec(
          handle.exec(body.cmd, body.opts ?? {}, ctx()),
          { background: false, sandboxId: id },
          emit
        );
      }

      if (sub === "processes") {
        if (caps.background === "unsupported" || !handle.spawn) {
          throw new SandboxError("NotSupported", "background processes", {
            provider: "gateway",
          });
        }
        if (method === "POST" && subId === undefined) {
          const body = (await req.json()) as ExecRequest;
          const proc = await handle.spawn(body.cmd, body.opts ?? {}, ctx());
          return streamExec(
            proc,
            { background: true, processId: proc.id, sandboxId: id },
            emit
          );
        }
        if (method === "GET" && subId !== undefined) {
          if (!handle.connectProcess) {
            throw new SandboxError("NotSupported", "connectProcess", {
              provider: "gateway",
            });
          }
          const proc = await handle.connectProcess(subId, ctx());
          return streamExec(
            proc,
            { background: true, processId: proc.id, sandboxId: id },
            emit,
            false
          );
        }
      }

      if (sub === "files") {
        const path = url.searchParams.get("path");
        if (!path) {
          throw bad("missing ?path=");
        }
        const started = Date.now();
        if (method === "GET") {
          const bytes = await handle.readFile(path, ctx());
          emit({
            bytes: bytes.byteLength,
            ms: Date.now() - started,
            ok: true,
            sandboxId: id,
            type: "files.read",
          });
          return new Response(bytes as BodyInit, {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        if (method === "PUT") {
          const bytes = new Uint8Array(await req.arrayBuffer());
          await handle.writeFile(path, bytes, ctx());
          emit({
            bytes: bytes.byteLength,
            ms: Date.now() - started,
            ok: true,
            sandboxId: id,
            type: "files.write",
          });
          return new Response(null, { status: 204 });
        }
      }

      if (sub === "rpc" && method === "POST") {
        const { method: m, args } = (await req.json()) as RpcRequest;
        if (!Object.hasOwn(RPC_METHODS, m)) {
          throw bad(`unknown rpc method '${String(m)}'`);
        }
        const cap = RPC_METHODS[m];
        const fn = handle[m] as ((...a: unknown[]) => unknown) | undefined;
        if ((cap && caps[cap] === "unsupported") || typeof fn !== "function") {
          throw new SandboxError("NotSupported", m, { provider: "gateway" });
        }
        const started = Date.now();
        let ok = false;
        try {
          let result = await fn.apply(handle, [...(args ?? []), ctx()]);
          if (m === "fork") {
            // Handles can't cross the wire: return the forks' infos.
            result = await Promise.all(
              (result as DriverHandle[]).map((h) => h.getInfo(ctx()))
            );
          }
          ok = true;
          return json({ result: result ?? null });
        } finally {
          emit({
            method: m,
            ms: Date.now() - started,
            ok,
            sandboxId: id,
            type: "rpc",
          });
        }
      }

      throw new SandboxError("NotFound", `no route ${method} ${url.pathname}`, {
        provider: "gateway",
      });
    } catch (error) {
      return fail(error);
    }
  };
}

/**
 * Stream an exec as NDJSON. A client disconnect kills a foreground exec; a
 * background process keeps running (reattach via GET /processes/:pid).
 */
function streamExec(
  ex: DriverExec & { id?: string },
  meta: { sandboxId: string; background: boolean; processId?: string },
  emit: (e: GatewayEvent) => void,
  record = true
): Response {
  const enc = new TextEncoder();
  const started = Date.now();
  let exitCode: number | undefined;
  let finished = false;
  const done = (ok: boolean): void => {
    if (finished) {
      return;
    }
    finished = true;
    if (record) {
      emit({
        background: meta.background,
        exitCode,
        ms: Date.now() - started,
        ok,
        sandboxId: meta.sandboxId,
        type: "exec",
      });
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async cancel() {
      done(false);
      if (!meta.background) {
        await ex.kill().catch(() => undefined);
      }
    },
    async start(controller) {
      const send = (frame: StreamFrame): void => {
        if (!finished) {
          try {
            controller.enqueue(enc.encode(`${encode(frame)}\n`));
          } catch {
            // client went away; cancel() handles cleanup
          }
        }
      };
      try {
        const pid = await ex.pid.catch(() => "");
        send({ id: meta.processId, pid, type: "start" });
        for await (const ev of ex) {
          if (ev.type === "exit") {
            exitCode = ev.exitCode;
          }
          send(ev);
        }
        done(true);
      } catch (error) {
        send({ error: toWireError(error), type: "error" });
        done(false);
      }
      try {
        controller.close();
      } catch {
        // already cancelled
      }
    },
  });
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson",
    },
  });
}
