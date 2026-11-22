/**
 * Docker Engine API transport: endpoint discovery (DOCKER_HOST, OrbStack,
 * Docker Desktop, Colima, Rancher Desktop, Podman) and a tiny HTTP client over
 * `node:http` that also supports the connection hijack `exec/start` needs.
 * `node:*` modules are imported lazily, only when a transport is created.
 */
import { SandboxError } from "../adapter/index.js";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "DELETE";

export interface DockerRequest {
  method: HttpMethod;
  /** Path without the API version prefix, e.g. `/containers/json`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** Objects are sent as JSON; bytes as `application/x-tar` unless overridden. */
  body?: Uint8Array | object;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface DockerResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** MUST be consumed (or `drain`ed) so the connection is released. */
  body: AsyncIterable<Uint8Array>;
}

/** A hijacked (upgraded) raw connection, as returned by `exec/start`. */
export interface DockerConn {
  readonly output: AsyncIterable<Uint8Array>;
  write(data: Uint8Array): Promise<void>;
  /** Half-close: the process sees EOF on stdin, output keeps flowing. */
  closeWrite(): Promise<void>;
  close(): void;
}

export interface DockerTransport {
  /** Human-readable endpoint, e.g. `unix:///Users/me/.orbstack/run/docker.sock`. */
  readonly endpoint: string;
  /** Best guess at the runtime behind the endpoint (OrbStack, Colima, ...). */
  readonly runtime: string;
  /** Host that published ports are reachable on. */
  readonly previewHost: string;
  request(req: DockerRequest): Promise<DockerResponse>;
  hijack(req: DockerRequest): Promise<DockerConn>;
  dispose?(): void;
}

// ---------------------------------------------------------------------------
// endpoint discovery
// ---------------------------------------------------------------------------

export type DockerEndpoint =
  | { kind: "unix"; socketPath: string; runtime: string }
  | {
      kind: "tcp";
      host: string;
      port: number;
      tls: boolean;
      certPath?: string;
      runtime: string;
    };

export interface SocketCandidate {
  socketPath: string;
  runtime: string;
}

/** Guess the runtime from a socket path (after resolving symlinks). */
export function runtimeForSocket(socketPath: string): string {
  if (socketPath.includes("/.orbstack/")) {
    return "OrbStack";
  }
  if (socketPath.includes("/.colima/")) {
    return "Colima";
  }
  if (socketPath.includes("/.rd/")) {
    return "Rancher Desktop";
  }
  if (socketPath.includes("podman")) {
    return "Podman";
  }
  if (socketPath.includes("/.docker/")) {
    return "Docker Desktop";
  }
  return "Docker";
}

/**
 * Parse a `DOCKER_HOST`-style URL. Supports `unix://` and `tcp://` (TLS when
 * `tlsVerify` is set, as with `DOCKER_TLS_VERIFY`). `ssh://` and `npipe://`
 * are rejected with a Validation error.
 */
export function parseDockerHost(
  value: string,
  tls: { verify?: boolean; certPath?: string } = {}
): DockerEndpoint {
  if (value.startsWith("unix://")) {
    const socketPath = value.slice("unix://".length);
    return { kind: "unix", runtime: runtimeForSocket(socketPath), socketPath };
  }
  if (value.startsWith("/")) {
    return {
      kind: "unix",
      runtime: runtimeForSocket(value),
      socketPath: value,
    };
  }
  const m = /^(tcp|http|https):\/\/([^/:]+|\[[^\]]+\])(?::(\d+))?\/?$/.exec(
    value
  );
  if (m) {
    const secure = m[1] === "https" || !!tls.verify;
    return {
      certPath: tls.certPath,
      host: m[2]!.replace(/^\[|\]$/g, ""),
      kind: "tcp",
      port: m[3] ? Number(m[3]) : secure ? 2376 : 2375,
      runtime: "remote",
      tls: secure,
    };
  }
  throw new SandboxError(
    "Validation",
    `unsupported DOCKER_HOST '${value}' (use unix:// or tcp://; ssh:// and npipe:// are not supported)`,
    { provider: "docker" }
  );
}

/** Well-known socket locations, in probe order. */
export function socketCandidates(
  env: Record<string, string | undefined>,
  home: string
): SocketCandidate[] {
  const out: SocketCandidate[] = [
    { runtime: "OrbStack", socketPath: `${home}/.orbstack/run/docker.sock` },
    { runtime: "Docker", socketPath: "/var/run/docker.sock" },
    {
      runtime: "Docker Desktop",
      socketPath: `${home}/.docker/run/docker.sock`,
    },
    { runtime: "Colima", socketPath: `${home}/.colima/default/docker.sock` },
    { runtime: "Rancher Desktop", socketPath: `${home}/.rd/docker.sock` },
  ];
  if (env.XDG_RUNTIME_DIR) {
    out.push({
      runtime: "Podman",
      socketPath: `${env.XDG_RUNTIME_DIR}/podman/podman.sock`,
    });
  }
  out.push({
    runtime: "Podman",
    socketPath: `${home}/.local/share/containers/podman/machine/podman.sock`,
  });
  return out;
}

export interface DiscoverOptions {
  socketPath?: string;
  host?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  /** Probe: does a unix socket exist at this path? Returns its real path. */
  probe?: (path: string) => Promise<string | undefined>;
}

/**
 * Pick the Docker endpoint: explicit `socketPath` / `host` option, then
 * `DOCKER_HOST`, then the first well-known socket that exists.
 */
export async function discoverEndpoint(
  opts: DiscoverOptions = {}
): Promise<DockerEndpoint> {
  if (opts.socketPath) {
    return {
      kind: "unix",
      runtime: runtimeForSocket(
        (await opts.probe?.(opts.socketPath)) ?? opts.socketPath
      ),
      socketPath: opts.socketPath,
    };
  }
  const env = opts.env ?? {};
  const tls = {
    certPath: env.DOCKER_CERT_PATH,
    verify: !!env.DOCKER_TLS_VERIFY && env.DOCKER_TLS_VERIFY !== "0",
  };
  if (opts.host) {
    return parseDockerHost(opts.host, tls);
  }
  if (env.DOCKER_HOST) {
    const ep = parseDockerHost(env.DOCKER_HOST, tls);
    if (ep.kind === "unix" && opts.probe) {
      const real = await opts.probe(ep.socketPath);
      if (real) {
        return { ...ep, runtime: runtimeForSocket(real) };
      }
    }
    return ep;
  }
  const probe = opts.probe ?? (async () => undefined);
  const candidates = socketCandidates(env, opts.home ?? "");
  for (const c of candidates) {
    const real = await probe(c.socketPath);
    if (real) {
      const guessed = runtimeForSocket(real);
      return {
        kind: "unix",
        runtime: guessed === "Docker" ? c.runtime : guessed,
        socketPath: c.socketPath,
      };
    }
  }
  throw new SandboxError(
    "Provider",
    `no Docker socket found (tried DOCKER_HOST and ${candidates
      .map((c) => c.socketPath)
      .join(
        ", "
      )}). Start OrbStack / Docker Desktop / Colima / Rancher Desktop / Podman, or pass { socketPath }.`,
    { provider: "docker", retryable: false }
  );
}

/** Node probe: resolve symlinks and check the target is a socket. */
export async function nodeSocketProbe(
  path: string
): Promise<string | undefined> {
  const fs = await import("node:fs/promises");
  try {
    const real = await fs.realpath(path);
    const st = await fs.stat(real);
    return st.isSocket() ? real : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// node:http transport
// ---------------------------------------------------------------------------

export function buildPath(req: DockerRequest): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined) {
      params.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    }
  }
  const qs = params.toString();
  return qs ? `${req.path}?${qs}` : req.path;
}

function encodeBody(req: DockerRequest): {
  bytes?: Uint8Array;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = { ...req.headers };
  if (req.body === undefined) {
    return { headers };
  }
  if (req.body instanceof Uint8Array) {
    headers["Content-Type"] ??= "application/x-tar";
    headers["Content-Length"] = String(req.body.length);
    return { bytes: req.body, headers };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(req.body));
  headers["Content-Type"] ??= "application/json";
  headers["Content-Length"] = String(bytes.length);
  return { bytes, headers };
}

function flatHeaders(
  raw: Record<string, string | string[] | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) {
      out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
    }
  }
  return out;
}

/** Create a `node:http` transport for an endpoint (lazy-imports node:*). */
export async function createNodeTransport(
  endpoint: DockerEndpoint
): Promise<DockerTransport> {
  const http = await import("node:http");
  let mod: typeof import("node:http") | typeof import("node:https") = http;
  const base: import("node:https").RequestOptions = {};
  if (endpoint.kind === "unix") {
    base.socketPath = endpoint.socketPath;
  } else {
    base.host = endpoint.host;
    base.port = endpoint.port;
    if (endpoint.tls) {
      mod = await import("node:https");
      if (endpoint.certPath) {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const read = (f: string) =>
          fs.readFile(path.join(endpoint.certPath!, f));
        base.ca = await read("ca.pem");
        base.cert = await read("cert.pem");
        base.key = await read("key.pem");
      }
    }
  }
  const agent =
    mod === http
      ? new http.Agent({ keepAlive: true })
      : new (await import("node:https")).Agent({ keepAlive: true });

  const endpointLabel =
    endpoint.kind === "unix"
      ? `unix://${endpoint.socketPath}`
      : `${endpoint.tls ? "https" : "tcp"}://${endpoint.host}:${endpoint.port}`;

  const request = (req: DockerRequest): Promise<DockerResponse> =>
    new Promise((resolve, reject) => {
      const { bytes, headers } = encodeBody(req);
      const r = mod.request(
        {
          ...base,
          agent,
          headers: { Host: "docker", ...headers },
          method: req.method,
          path: buildPath(req),
          signal: req.signal,
        },
        (res) => {
          resolve({
            body: res,
            headers: flatHeaders(res.headers),
            status: res.statusCode ?? 0,
          });
        }
      );
      r.on("error", reject);
      r.end(bytes);
    });

  const hijack = (req: DockerRequest): Promise<DockerConn> =>
    new Promise((resolve, reject) => {
      const { bytes, headers } = encodeBody(req);
      const r = mod.request({
        ...base,
        // A hijacked socket must never go back into the keep-alive pool.
        agent: false,
        headers: {
          Connection: "Upgrade",
          Host: "docker",
          Upgrade: "tcp",
          ...headers,
        },
        method: req.method,
        path: buildPath(req),
        signal: req.signal,
      });
      r.on("upgrade", (_res, socket, head) => {
        socket.setNoDelay(true);
        resolve({
          close: () => socket.destroy(),
          closeWrite: () =>
            new Promise<void>((res) => {
              if (socket.writableEnded || socket.destroyed) {
                res();
                return;
              }
              socket.end(() => res());
            }),
          output: (async function* upgradedOutput() {
            if (head.length > 0) {
              yield new Uint8Array(head);
            }
            try {
              for await (const chunk of socket) {
                yield chunk as Uint8Array;
              }
            } catch (error) {
              // ECONNRESET after we destroyed the socket ourselves is EOF.
              if (!socket.destroyed) {
                throw error;
              }
            }
          })(),
          write: (data) =>
            new Promise<void>((res, rej) => {
              if (socket.writableEnded || socket.destroyed) {
                rej(
                  new SandboxError("Conflict", "stdin is already closed", {
                    provider: "docker",
                  })
                );
                return;
              }
              socket.write(data, (err) => {
                if (err) {
                  rej(err);
                } else {
                  res();
                }
              });
            }),
        });
      });
      r.on("response", (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          const chunks: Uint8Array[] = [];
          res.on("data", (c: Uint8Array) => chunks.push(c));
          res.on("end", () => {
            reject(
              apiErrorFrom(
                res.statusCode ?? 0,
                new TextDecoder().decode(Buffer.concat(chunks))
              )
            );
          });
          res.on("error", reject);
          return;
        }
        // No upgrade (old daemon / proxy): output streams on the response.
        resolve({
          close: () => res.destroy(),
          closeWrite: async () => {},
          output: (async function* responseOutput() {
            for await (const c of res) {
              yield c as Uint8Array;
            }
          })(),
          write: async () => {
            throw new SandboxError(
              "NotSupported",
              "daemon did not upgrade the connection; stdin unavailable",
              { provider: "docker" }
            );
          },
        });
      });
      r.on("error", reject);
      r.end(bytes);
    });

  return {
    dispose: () => agent.destroy(),
    endpoint: endpointLabel,
    hijack,
    previewHost: endpoint.kind === "tcp" ? endpoint.host : "127.0.0.1",
    request,
    runtime: endpoint.runtime,
  };
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/** A non-2xx Engine API response. */
export class DockerApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DockerApiError";
    this.status = status;
  }
}

export function apiErrorFrom(status: number, body: string): DockerApiError {
  let message = body.trim();
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) {
      message = parsed.message;
    }
  } catch {
    // plain-text body
  }
  return new DockerApiError(status, message || `HTTP ${status}`);
}
