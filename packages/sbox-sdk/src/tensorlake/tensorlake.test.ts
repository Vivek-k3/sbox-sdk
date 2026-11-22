/**
 * Offline tests for the Tensorlake adapter. The adapter speaks the documented
 * HTTP API, so the fake here is an HTTP server (a `fetch` implementation)
 * modelled on https://docs.tensorlake.ai/api-reference/openapi.yaml: the
 * lifecycle API, the per-sandbox proxy (SSE process runs, files, PTY), and
 * Cloud Volumes. Processes run through `MiniShell` over an in-memory fs.
 * The `tensorlake` SDK (used only for image builds) is mocked with its real
 * export names and signatures.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SandboxError } from "../adapter/index.js";
import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../internal/client.js";
import { MiniShell } from "../memory/shell.js";
import type { ShellFs } from "../memory/shell.js";
import {
  mapTensorlakeError,
  mapTensorlakeStatus,
  tensorlake,
  TensorlakeHttpError,
  tensorlakeTemplateName,
  toTensorlakeCreate,
  toTensorlakeNetwork,
} from "./index.js";
import type {
  TensorlakeWebSocket,
  TensorlakeWebSocketCtor,
  TlCreateRequest,
  TlSandboxInfo,
} from "./index.js";

type TlModule = typeof import("tensorlake");

// --------------------------------------------------------------------------
// in-memory filesystem
// --------------------------------------------------------------------------

class MemFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(["/", "/tmp", "/var", "/var/tmp", "/home"]);

  static norm(p: string): string {
    const parts: string[] = [];
    for (const seg of (p.startsWith("/") ? p : `/${p}`).split("/")) {
      if (seg === "" || seg === ".") {
        continue;
      }
      if (seg === "..") {
        parts.pop();
      } else {
        parts.push(seg);
      }
    }
    return `/${parts.join("/")}`;
  }
  static parent(p: string): string {
    const n = MemFs.norm(p);
    const i = n.lastIndexOf("/");
    return i <= 0 ? "/" : n.slice(0, i);
  }
  clone(): MemFs {
    const c = new MemFs();
    c.files = new Map(this.files);
    c.dirs = new Set(this.dirs);
    return c;
  }
  mkdirp(p: string): void {
    let cur = MemFs.norm(p);
    const chain: string[] = [];
    while (cur !== "/") {
      chain.unshift(cur);
      cur = MemFs.parent(cur);
    }
    for (const d of chain) {
      this.dirs.add(d);
    }
  }
  write(p: string, d: Uint8Array): void {
    const n = MemFs.norm(p);
    this.mkdirp(MemFs.parent(n));
    this.files.set(n, d);
  }
  list(p: string): { name: string; type: "file" | "dir" }[] | null {
    const d = MemFs.norm(p);
    if (!this.dirs.has(d)) {
      return null;
    }
    const out = new Map<string, "file" | "dir">();
    for (const sub of this.dirs) {
      if (sub !== d && MemFs.parent(sub) === d) {
        out.set(sub.slice(sub.lastIndexOf("/") + 1), "dir");
      }
    }
    for (const f of this.files.keys()) {
      if (MemFs.parent(f) === d) {
        out.set(f.slice(f.lastIndexOf("/") + 1), "file");
      }
    }
    return [...out].map(([name, type]) => ({ name, type }));
  }
  shell(): ShellFs {
    return {
      isDir: (p) => this.dirs.has(MemFs.norm(p)),
      list: (p) => this.list(p),
      mkdir: (p, r) => {
        const n = MemFs.norm(p);
        if (this.dirs.has(n)) {
          return r ? null : `mkdir: cannot create '${p}': File exists`;
        }
        if (!r && !this.dirs.has(MemFs.parent(n))) {
          return `mkdir: cannot create '${p}': No such file or directory`;
        }
        this.mkdirp(n);
        return null;
      },
      read: (p) => this.files.get(MemFs.norm(p)) ?? null,
      remove: (p, r, force) => {
        const n = MemFs.norm(p);
        if (this.files.delete(n)) {
          return null;
        }
        if (this.dirs.has(n)) {
          if (!r) {
            return `rm: cannot remove '${p}': Is a directory`;
          }
          for (const d of [...this.dirs]) {
            if (d === n || d.startsWith(`${n}/`)) {
              this.dirs.delete(d);
            }
          }
          for (const f of [...this.files.keys()]) {
            if (f.startsWith(`${n}/`)) {
              this.files.delete(f);
            }
          }
          return null;
        }
        return force ? null : `rm: cannot remove '${p}': No such file`;
      },
      rename: (a, b) => {
        const na = MemFs.norm(a);
        const nb = MemFs.norm(b);
        const data = this.files.get(na);
        if (data) {
          this.files.delete(na);
          this.write(nb, data);
          return null;
        }
        if (this.dirs.has(na)) {
          this.mkdirp(nb);
          for (const f of [...this.files.keys()]) {
            if (f.startsWith(`${na}/`)) {
              this.write(nb + f.slice(na.length), this.files.get(f)!);
              this.files.delete(f);
            }
          }
          this.dirs.delete(na);
          return null;
        }
        return `mv: cannot stat '${a}': No such file or directory`;
      },
      stat: (p) => {
        const n = MemFs.norm(p);
        if (this.dirs.has(n)) {
          return { size: 0, type: "dir" };
        }
        const f = this.files.get(n);
        return f ? { size: f.length, type: "file" } : null;
      },
      write: (p, d) => this.write(p, d),
    };
  }
}

// --------------------------------------------------------------------------
// fake Tensorlake backend
// --------------------------------------------------------------------------

const API = "https://api.tensorlake.test";
const VOL = "https://git.tensorlake.test";
const INGRESS = "https://sandbox.tensorlake.test";
const KEY = "tl_test_key";
const enc = new TextEncoder();
const dec = new TextDecoder();

interface Proc {
  pid: number;
  command: string;
  args: string[];
  status: "running" | "exited" | "signaled";
  exitCode?: number;
  signal?: number;
  ac: AbortController;
  events: { line: string; stream: "stdout" | "stderr" }[];
  listeners: Set<() => void>;
  done: Promise<void>;
}

interface FakeSandbox {
  info: TlSandboxInfo;
  fs: MemFs;
  procs: Map<number, Proc>;
  ptys: Map<string, { token: string; command: string }>;
  ticks: number;
}

class FakeTensorlake {
  sandboxes = new Map<string, FakeSandbox>();
  snapshots = new Map<
    string,
    { id: string; sandboxId: string; type: string; fs: MemFs; polls: number }
  >();
  images = new Map<string, MemFs>();
  volumes = new Set<string>();
  createBodies: TlCreateRequest[] = [];
  patchBodies: Record<string, unknown>[] = [];
  listPageSize = 2;
  #n = 0;
  #pid = 100;

  byIdOrName(key: string): FakeSandbox | undefined {
    const direct = this.sandboxes.get(key);
    if (direct) {
      return direct;
    }
    for (const s of this.sandboxes.values()) {
      if (s.info.name === key && s.info.status !== "terminated") {
        return s;
      }
    }
    return undefined;
  }

  spawnSandbox(body: TlCreateRequest, fs?: MemFs): FakeSandbox {
    const id = `sbx${++this.#n}`;
    const sb: FakeSandbox = {
      fs: fs ?? new MemFs(),
      info: {
        allow_unauthenticated_access:
          body.allow_unauthenticated_access ?? false,
        auto_resume: body.auto_resume ?? true,
        created_at: Date.now(),
        exposed_ports: body.exposed_ports ?? null,
        id,
        image: body.image,
        ingress_endpoint: INGRESS,
        name: body.name ?? null,
        network_policy: body.network ?? null,
        resources: { cpus: 1, disk_mb: 10_240, memory_mb: 1024 },
        sandbox_url: `https://${id}.sandbox.tensorlake.test`,
        status: "running",
        timeout_secs: body.timeout_secs ?? 600,
      },
      procs: new Map(),
      ptys: new Map(),
      ticks: 0,
    };
    this.sandboxes.set(id, sb);
    return sb;
  }

  startProcess(
    sb: FakeSandbox,
    command: string,
    args: string[],
    env: Record<string, string>,
    cwd: string | undefined,
    timeoutSecs?: number
  ): Proc & { timedOut: () => boolean } {
    const pid = ++this.#pid;
    const ac = new AbortController();
    let timedOut = false;
    const proc = {
      ac,
      args,
      command,
      events: [],
      exitCode: undefined,
      listeners: new Set<() => void>(),
      pid,
      status: "running",
      timedOut: () => timedOut,
    } as unknown as Proc & { timedOut: () => boolean };
    const notify = () => {
      for (const l of proc.listeners) {
        l();
      }
    };
    const bufs = { stderr: "", stdout: "" };
    const feed = (stream: "stdout" | "stderr", d: Uint8Array) => {
      bufs[stream] += dec.decode(d);
      let nl = bufs[stream].indexOf("\n");
      while (nl !== -1) {
        proc.events.push({ line: bufs[stream].slice(0, nl), stream });
        bufs[stream] = bufs[stream].slice(nl + 1);
        nl = bufs[stream].indexOf("\n");
      }
      notify();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutSecs) {
      timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, timeoutSecs * 1000);
    }
    const script =
      command === "sh" && args[0] === "-c"
        ? (args[1] ?? "")
        : [command, ...args].join(" ");
    proc.done = (async () => {
      const code = await new MiniShell(sb.fs.shell()).run(script, {
        cwd: cwd ?? "/",
        env,
        signal: ac.signal,
        stderr: (d) => feed("stderr", d),
        stdin: new Uint8Array(),
        stdout: (d) => feed("stdout", d),
      });
      clearTimeout(timer);
      for (const s of ["stdout", "stderr"] as const) {
        if (bufs[s]) {
          proc.events.push({ line: bufs[s], stream: s });
          bufs[s] = "";
        }
      }
      if (ac.signal.aborted) {
        proc.status = "signaled";
        proc.signal = 9;
      } else {
        proc.status = "exited";
        proc.exitCode = code;
      }
      notify();
    })();
    sb.procs.set(pid, proc);
    return proc;
  }

  json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status,
    });
  }

  text(status: number, body: string): Response {
    return new Response(body, { status });
  }

  sse(
    produce: (
      send: (event: string | undefined, data: unknown) => void
    ) => Promise<void>,
    signal?: AbortSignal | null
  ): Response {
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        let open = true;
        signal?.addEventListener("abort", () => {
          open = false;
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {
            // already closed
          }
        });
        await produce((event, data) => {
          if (open) {
            controller.enqueue(
              enc.encode(
                `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`
              )
            );
          }
        });
        if (open) {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  fetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    if (
      req.headers.get("authorization") !== `Bearer ${KEY}` &&
      !req.url.startsWith(VOL)
    ) {
      return this.text(401, "invalid api key");
    }
    const url = new URL(req.url);
    if (url.origin === API) {
      return this.api(req, url);
    }
    if (url.origin === VOL) {
      return this.vol(req, url);
    }
    const m = /^https:\/\/(?:(\d+)-)?([^.]+)\.sandbox\.tensorlake\.test$/.exec(
      url.origin
    );
    if (m) {
      const sb = this.byIdOrName(m[2]!);
      if (!sb || sb.info.status === "terminated") {
        return this.json(404, {
          code: "SANDBOX_NOT_FOUND",
          error: "no sandbox",
        });
      }
      if (sb.info.status === "suspended") {
        sb.info.status = "running"; // auto_resume on proxy traffic
      }
      return this.proxy(req, url, sb);
    }
    return this.text(404, `no route ${req.url}`);
  };

  async api(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const method = req.method;
    if (path === "/sandboxes" && method === "POST") {
      const body = (await req.json()) as TlCreateRequest;
      this.createBodies.push(body);
      if (body.name && this.byIdOrName(body.name)) {
        return this.text(
          409,
          "A sandbox with the requested name already exists"
        );
      }
      let fs: MemFs | undefined;
      if (body.snapshot_id) {
        const snap = this.snapshots.get(body.snapshot_id);
        if (!snap) {
          return this.text(404, "snapshot not found");
        }
        fs = snap.fs.clone();
      } else if (body.image) {
        const img = this.images.get(body.image);
        if (!img) {
          return this.json(422, {
            error: "image not found",
            code: "ImageNotFound",
          });
        }
        fs = img.clone();
      }
      const sb = this.spawnSandbox(body, fs);
      return this.json(200, {
        ingress_endpoint: INGRESS,
        sandbox_id: sb.info.id,
        status: "running",
      });
    }
    if (path === "/sandboxes" && method === "GET") {
      const status = url.searchParams.get("status");
      const all = [...this.sandboxes.values()]
        .map((s) => s.info)
        .filter((i) => i.status !== "terminated")
        .filter((i) => !status || i.status === status);
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const size = Math.min(
        Number(url.searchParams.get("limit") ?? "100"),
        this.listPageSize
      );
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : null;
      return this.json(200, { next_cursor: next, sandboxes: page });
    }
    let m = /^\/sandboxes\/([^/]+)(\/[a-z_]+)?$/.exec(path);
    if (m) {
      const sb = this.byIdOrName(decodeURIComponent(m[1]!));
      if (!sb) {
        return this.text(404, "Sandbox not found");
      }
      const action = m[2];
      if (!action && method === "GET") {
        return this.json(200, sb.info);
      }
      if (!action && method === "DELETE") {
        sb.info.status = "terminated";
        for (const p of sb.procs.values()) {
          p.ac.abort();
        }
        return new Response(null, { status: 200 });
      }
      if (!action && method === "PATCH") {
        const body = (await req.json()) as Record<string, unknown>;
        this.patchBodies.push(body);
        if ("exposed_ports" in body) {
          sb.info.exposed_ports = body.exposed_ports as number[];
        }
        if ("allow_unauthenticated_access" in body) {
          sb.info.allow_unauthenticated_access =
            body.allow_unauthenticated_access as boolean;
        }
        if ("network" in body) {
          sb.info.network_policy =
            body.network as TlSandboxInfo["network_policy"];
        }
        return this.json(200, sb.info);
      }
      if (action === "/suspend" && method === "POST") {
        if (!sb.info.name) {
          return this.text(400, "ephemeral sandboxes cannot be suspended");
        }
        sb.info.status = "suspended";
        return new Response(null, { status: 202 });
      }
      if (action === "/resume" && method === "POST") {
        sb.info.status = "running";
        return new Response(null, { status: 200 });
      }
      if (action === "/snapshot" && method === "POST") {
        const body = (await req.json()) as { snapshot_type?: string };
        const id = `snap${this.snapshots.size + 1}`;
        this.snapshots.set(id, {
          fs: sb.fs.clone(),
          id,
          polls: 0,
          sandboxId: sb.info.id,
          type: body.snapshot_type ?? "filesystem",
        });
        return this.json(202, { snapshot_id: id, status: "in_progress" });
      }
      if (action === "/copy" && method === "POST") {
        const times = Number(url.searchParams.get("times") ?? "1");
        const name = url.searchParams.get("name");
        const out = [];
        for (let i = 0; i < times; i++) {
          const child = this.spawnSandbox(
            {
              name: name
                ? times === 1
                  ? name
                  : `${name}-${i + 1}`
                : undefined,
            },
            sb.fs.clone()
          );
          out.push({ sandbox_id: child.info.id, status: "running" });
        }
        return this.json(200, {
          sandboxes: out,
          source_sandbox_id: sb.info.id,
        });
      }
    }
    if (path === "/snapshots" && method === "GET") {
      return this.json(200, {
        snapshots: [...this.snapshots.values()].map((s) => ({
          sandbox_id: s.sandboxId,
          snapshot_id: s.id,
          snapshot_type: s.type,
          status: "completed",
        })),
      });
    }
    m = /^\/snapshots\/([^/]+)$/.exec(path);
    if (m) {
      const snap = this.snapshots.get(m[1]!);
      if (!snap) {
        return this.text(404, "snapshot not found");
      }
      if (method === "DELETE") {
        this.snapshots.delete(snap.id);
        return new Response(null, { status: 200 });
      }
      snap.polls++;
      return this.json(200, {
        sandbox_id: snap.sandboxId,
        snapshot_id: snap.id,
        snapshot_type: snap.type,
        status: snap.polls > 1 ? "local_ready" : "in_progress",
      });
    }
    if (path === "/artifact-storage/v1/token" && method === "POST") {
      const payload = btoa(JSON.stringify({ iss: "project_test" }));
      return this.json(200, {
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        token: `h.${payload}.s`,
      });
    }
    return this.text(404, `no api route ${method} ${path}`);
  }

  vol(req: Request, url: URL): Response | Promise<Response> {
    if (!req.headers.get("authorization")?.startsWith("Basic ")) {
      return this.text(401, "missing credential");
    }
    const m = /^\/project\/project_test\/repos(?:\/([^/]+))?(\/meta)?$/.exec(
      url.pathname
    );
    if (!m) {
      return this.text(404, "no route");
    }
    const name = m[1] ? decodeURIComponent(m[1]) : undefined;
    if (!name && req.method === "GET") {
      return this.json(200, {
        next_after: null,
        project: "project_test",
        repos: [...this.volumes].map((n) => ({ kind: "filesystem", name: n })),
      });
    }
    if (name && m[2] && req.method === "GET") {
      return this.volumes.has(name)
        ? this.json(200, { kind: "filesystem", name })
        : this.text(404, "repo-not-found");
    }
    if (name && req.method === "POST") {
      if (this.volumes.has(name)) {
        return this.text(409, "exists");
      }
      this.volumes.add(name);
      return new Response(null, { status: 201 });
    }
    if (name && req.method === "DELETE") {
      this.volumes.delete(name);
      return new Response(null, { status: 204 });
    }
    return this.text(404, "no route");
  }

  async proxy(req: Request, url: URL, sb: FakeSandbox): Promise<Response> {
    const path = url.pathname;
    const method = req.method;
    if (path === "/api/v1/processes/run" && method === "POST") {
      const body = (await req.json()) as {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        working_dir?: string;
        timeout?: number;
      };
      const proc = this.startProcess(
        sb,
        body.command,
        body.args ?? [],
        body.env ?? {},
        body.working_dir,
        body.timeout
      );
      return this.sse(async (send) => {
        send(undefined, { handle: 1, pid: proc.pid, started_at: Date.now() });
        let i = 0;
        for (;;) {
          while (i < proc.events.length) {
            const e = proc.events[i++]!;
            send(undefined, {
              line: e.line,
              stream: e.stream,
              timestamp: Date.now(),
            });
          }
          if (proc.status !== "running") {
            break;
          }
          await new Promise<void>((r) => {
            const l = () => {
              proc.listeners.delete(l);
              r();
            };
            proc.listeners.add(l);
          });
        }
        if (proc.status === "exited") {
          send(undefined, { exit_code: proc.exitCode });
        } else {
          send(undefined, {
            signal: 9,
            ...(proc.timedOut() ? { reason: "timed_out" } : {}),
          });
        }
      }, req.signal);
    }
    if (path === "/api/v1/processes" && method === "POST") {
      const body = (await req.json()) as {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        working_dir?: string;
      };
      const p = this.startProcess(
        sb,
        body.command,
        body.args ?? [],
        body.env ?? {},
        body.working_dir
      );
      return this.json(201, {
        args: p.args,
        command: p.command,
        handle: 1,
        pid: p.pid,
        started_at: Date.now(),
        status: "running",
        stdin_writable: true,
      });
    }
    if (path === "/api/v1/processes" && method === "GET") {
      return this.json(200, {
        processes: [...sb.procs.values()].map((p) => ({
          args: p.args,
          command: p.command,
          pid: p.pid,
          status: p.status,
        })),
      });
    }
    let m = /^\/api\/v1\/processes\/(\d+)(\/[a-z/]+)?$/.exec(path);
    if (m) {
      const proc = sb.procs.get(Number(m[1]));
      if (!proc) {
        return this.json(404, { error: "Process not found" });
      }
      const sub = m[2];
      if (!sub && method === "GET") {
        return this.json(200, {
          args: proc.args,
          command: proc.command,
          exit_code: proc.exitCode ?? null,
          pid: proc.pid,
          signal: proc.signal ?? null,
          status: proc.status,
        });
      }
      if (!sub && method === "DELETE") {
        proc.ac.abort();
        return new Response(null, { status: 204 });
      }
      if (sub === "/signal" && method === "POST") {
        proc.ac.abort();
        return this.json(200, { success: true });
      }
      if (sub === "/stdin" && method === "POST") {
        return new Response(null, { status: 204 });
      }
      if (sub === "/output/follow" && method === "GET") {
        return this.sse(async (send) => {
          let i = 0;
          for (;;) {
            while (i < proc.events.length) {
              const e = proc.events[i++]!;
              send("output", {
                line: e.line,
                stream: e.stream,
                timestamp: Date.now(),
              });
            }
            if (proc.status !== "running") {
              break;
            }
            await new Promise<void>((r) => {
              const l = () => {
                proc.listeners.delete(l);
                r();
              };
              proc.listeners.add(l);
            });
          }
          send("eof", {});
        }, req.signal);
      }
    }
    if (path === "/api/v1/files" || path === "/api/v1/files/list") {
      const p = url.searchParams.get("path") ?? "";
      const n = MemFs.norm(p);
      if (path === "/api/v1/files/list") {
        const entries = sb.fs.list(n);
        if (!entries) {
          return this.json(404, { error: "Directory not found" });
        }
        return this.json(200, {
          entries: entries.map((e) => ({
            is_dir: e.type === "dir",
            name: e.name,
            size:
              e.type === "file"
                ? sb.fs.files.get(`${n === "/" ? "" : n}/${e.name}`)?.length
                : null,
          })),
          path: n,
        });
      }
      if (method === "GET") {
        if (sb.fs.dirs.has(n)) {
          return this.json(400, { error: "Path points to a directory" });
        }
        const data = sb.fs.files.get(n);
        return data
          ? new Response(data as BodyInit, {
              headers: { "Content-Type": "application/octet-stream" },
            })
          : this.json(404, { error: "File not found" });
      }
      if (method === "PUT") {
        sb.fs.write(n, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        return sb.fs.files.delete(n)
          ? new Response(null, { status: 204 })
          : this.json(404, { error: "File not found" });
      }
    }
    if (path === "/api/v1/pty" && method === "POST") {
      const body = (await req.json()) as { command: string };
      const sid = `pty${sb.ptys.size + 1}`;
      const token = `tok-${sid}`;
      sb.ptys.set(sid, { command: body.command, token });
      return this.json(201, { session_id: sid, token });
    }
    m = /^\/api\/v1\/pty\/([^/]+)$/.exec(path);
    if (m && method === "DELETE") {
      sb.ptys.delete(m[1]!);
      return new Response(null, { status: 204 });
    }
    if (path === "/api/v1/resource-usage") {
      sb.ticks += 100;
      return this.json(200, {
        clock_ticks_per_second: 100,
        cpu_idle_ticks: sb.ticks * 3,
        cpu_limit_cores: 1,
        cpu_total_ticks: sb.ticks * 4,
        memory_available_bytes: 768 * 1_048_576,
        memory_limit_bytes: 1024 * 1_048_576,
        memory_used_bytes: 256 * 1_048_576,
        observed_at_ms: Date.now(),
        source: "guest_procfs",
      });
    }
    return this.json(404, { error: `no proxy route ${method} ${path}` });
  }

  /** WebSocket class bound to this backend (PTY attach protocol). */
  webSocket(): TensorlakeWebSocketCtor {
    const backend = this;
    return class FakePtySocket implements TensorlakeWebSocket {
      binaryType = "blob";
      #listeners = new Map<string, ((ev: never) => void)[]>();
      #ready = false;
      #line = "";
      #closed = false;
      #shell: MiniShell;
      #sb: FakeSandbox;
      #chain = Promise.resolve();

      constructor(url: string, init: { headers: Record<string, string> }) {
        const u = new URL(url);
        const m = /^wss:\/\/([^.]+)\.sandbox\.tensorlake\.test$/.exec(u.origin);
        const sid = /\/api\/v1\/pty\/([^/]+)\/ws$/.exec(u.pathname)?.[1];
        const sb = m ? backend.byIdOrName(m[1]!) : undefined;
        const session = sid ? sb?.ptys.get(sid) : undefined;
        if (
          !sb ||
          !session ||
          init.headers["X-PTY-Token"] !== session.token ||
          init.headers.Authorization !== `Bearer ${KEY}`
        ) {
          throw new Error("403 INVALID_TOKEN");
        }
        this.#sb = sb;
        this.#shell = new MiniShell(sb.fs.shell());
        setTimeout(() => this.#emit("open", undefined as never), 0);
      }

      addEventListener(type: string, fn: (ev: never) => void): void {
        const arr = this.#listeners.get(type) ?? [];
        arr.push(fn);
        this.#listeners.set(type, arr);
      }

      #emit(type: string, ev: never): void {
        for (const fn of this.#listeners.get(type) ?? []) {
          fn(ev);
        }
      }

      #out(bytes: Uint8Array): void {
        const frame = new Uint8Array(bytes.length + 1);
        frame.set(bytes, 1);
        if (this.binaryType === "arraybuffer") {
          this.#emit("message", { data: frame.buffer } as never);
        }
      }

      send(data: Uint8Array): void {
        if (this.#closed) {
          return;
        }
        if (data[0] === 0x02) {
          this.#ready = true;
          return;
        }
        if (!this.#ready || data[0] === 0x01) {
          return; // resize: no-op
        }
        const text = dec.decode(data.slice(1));
        this.#out(enc.encode(text.replaceAll("\n", "\r\n")));
        this.#line += text;
        let nl = this.#line.indexOf("\n");
        while (nl !== -1) {
          const cmd = this.#line.slice(0, nl);
          this.#line = this.#line.slice(nl + 1);
          const exit = /^\s*exit\s*(\d*)/.exec(cmd);
          if (exit) {
            const code = Number(exit[1] || 0);
            this.#chain = this.#chain.then(() => {
              const frame = new Uint8Array(5);
              frame[0] = 0x03;
              new DataView(frame.buffer).setInt32(1, code);
              this.#emit("message", { data: frame.buffer } as never);
              this.close(1000, `exit:${code}`);
            });
          } else {
            this.#chain = this.#chain.then(async () => {
              await this.#shell.run(cmd, {
                cwd: "/",
                env: {},
                signal: new AbortController().signal,
                stderr: (d) => this.#out(d),
                stdin: new Uint8Array(),
                stdout: (d) => this.#out(d),
              });
            });
          }
          nl = this.#line.indexOf("\n");
        }
      }

      close(code = 1000, reason = ""): void {
        if (this.#closed) {
          return;
        }
        this.#closed = true;
        void this.#sb;
        this.#emit("close", { code, reason } as never);
      }
    };
  }
}

let backend: FakeTensorlake;

// --------------------------------------------------------------------------
// mocked `tensorlake` SDK (image builds + image catalog only)
// --------------------------------------------------------------------------

const sdkCalls = {
  create: [] as { path: string; options: unknown; envKey?: string }[],
  import: [] as { ref: string; options: unknown }[],
};

vi.mock("tensorlake", () => {
  const registry = () => backend.images;
  const createSandboxImage: TlModule["createSandboxImage"] = async (
    source,
    options = {},
    deps = {}
  ) => {
    const envKey = process.env.TENSORLAKE_API_KEY;
    await Promise.resolve();
    if (typeof source !== "string") {
      throw new TypeError("expected a Dockerfile path");
    }
    sdkCalls.create.push({ envKey, options, path: source });
    const dir = source.slice(0, source.lastIndexOf("/"));
    const text = await readFile(source, "utf-8");
    const fs = new MemFs();
    for (const line of text.split("\n")) {
      deps.emit?.({ message: line, type: "build_log" });
      const copy = /^COPY\s+(\S+)\s+(\S+)/.exec(line);
      if (copy) {
        fs.write(copy[2]!, new Uint8Array(await readFile(join(dir, copy[1]!))));
      }
    }
    void readdir;
    registry().set(options.registeredName ?? "default", fs);
    return { id: `image_${registry().size}`, name: options.registeredName };
  };
  const importSandboxImage: TlModule["importSandboxImage"] = async (
    ref,
    options = {}
  ) => {
    sdkCalls.import.push({ options, ref });
    registry().set(options.registeredName ?? ref, new MemFs());
    return { id: `image_${registry().size}`, name: options.registeredName };
  };
  class CloudClient {
    readonly options: { apiKey?: string; apiUrl?: string };
    constructor(options: { apiKey?: string; apiUrl?: string } = {}) {
      this.options = options;
    }
    async listSandboxImages() {
      return [...registry().keys()].map((name, i) => ({
        id: `image_${i}`,
        name,
      }));
    }
    async findSandboxImageByName(name: string) {
      return registry().has(name) ? { id: `image_x`, name } : null;
    }
    async deleteSandboxImage(name: string) {
      registry().delete(name);
    }
  }
  return { CloudClient, createSandboxImage, importSandboxImage };
});

// --------------------------------------------------------------------------
// tests
// --------------------------------------------------------------------------

const make = () =>
  tensorlake({
    apiKey: KEY,
    apiUrl: API,
    fetch: backend.fetch,
    readyTimeoutMs: 5000,
    volumesUrl: VOL,
    WebSocket: backend.webSocket(),
  });

beforeEach(() => {
  backend = new FakeTensorlake();
  sdkCalls.create.length = 0;
  sdkCalls.import.length = 0;
});

describe("tensorlake conformance (offline, fake HTTP API)", () => {
  it("passes the suite", async () => {
    const report = await runConformance(make(), {
      live: true,
      // Tensorlake sandboxes have no labels, so the metadata round-trip and
      // the metadata-filtered list checks cannot apply. Running-state and
      // list behaviour are covered by the unit tests below.
      skip: [
        "lifecycle: getInfo reports live running state",
        "client: list honors capability and filter",
        "lifecycle: destroyed sandbox is not listed as running",
      ],
      template: {
        source: {
          context: { "hello.txt": "from template" },
          dockerfile:
            "FROM tensorlake/ubuntu-minimal\nCOPY hello.txt /app/hello.txt\n",
        },
      },
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(JSON.stringify(failed, null, 2)).toBe("[]");
    expect(report.checks.length).toBeGreaterThan(30);
  }, 60_000);
});

describe("spec mapping", () => {
  it("maps a rich spec onto POST /sandboxes", () => {
    const { body, inlineSecretEnv } = toTensorlakeCreate(
      {
        env: { A: "1" },
        lifecycle: {
          autoResume: false,
          idleTimeoutMs: 90_500,
          onIdle: "pause",
        },
        metadata: { team: "x" },
        network: { deny: { domains: ["evil.com"] }, mode: "allow-all" },
        ports: [8080, 8080, 6080],
        resources: {
          diskMB: 20_480,
          gpu: "H100",
          gpuCount: 2,
          memoryMB: 4096,
          vcpus: 2,
        },
        secrets: [
          { name: "GH_TOKEN" },
          { name: "inline", value: "v", envVar: "INLINE" },
        ],
        template: "borat-desktop",
        volumes: [{ id: "skills", mountPath: "/mnt/skills", readOnly: true }],
      },
      "my-box"
    );
    expect(body).toEqual({
      allow_unauthenticated_access: true,
      auto_resume: false,
      exposed_ports: [8080, 6080],
      file_systems: [
        {
          file_system_id: "skills",
          mount_path: "/mnt/skills",
          read_only: true,
        },
      ],
      image: "borat-desktop",
      name: "my-box",
      network: {
        allow_internet_access: true,
        allow_out: [],
        deny_out: ["evil.com"],
      },
      resources: {
        cpus: 2,
        disk_mb: 20_480,
        gpus: [{ count: 2, model: "H100" }],
        memory_mb: 4096,
      },
      secret_names: ["GH_TOKEN"],
      timeout_secs: 91,
      wait: true,
    });
    expect(inlineSecretEnv).toEqual({ INLINE: "v" });
  });

  it("prefers fromSnapshot over template and rejects egress secrets", () => {
    expect(
      toTensorlakeCreate({ fromSnapshot: "snap1", template: "img" }, undefined)
        .body
    ).toEqual({ snapshot_id: "snap1", wait: true });
    expect(() =>
      toTensorlakeCreate(
        { secrets: [{ mode: "egress", name: "X" }] },
        undefined
      )
    ).toThrow(/egress/);
  });

  it("maps egress policies", () => {
    expect(toTensorlakeNetwork({ mode: "allow-all" })).toBeNull();
    expect(toTensorlakeNetwork({ mode: "block-all" })).toEqual({
      allow_internet_access: false,
      allow_out: [],
      deny_out: [],
    });
    expect(
      toTensorlakeNetwork({
        cidrs: ["10.0.0.0/8"],
        domains: ["a.com"],
        mode: "allow-list",
      })
    ).toEqual({
      allow_internet_access: true,
      allow_out: ["a.com", "10.0.0.0/8"],
      deny_out: [],
    });
    expect(() =>
      toTensorlakeNetwork({
        inject: [{ domains: ["x"], headers: {} }],
        mode: "allow-all",
      })
    ).toThrow(SandboxError);
  });

  it("sends name, env file and a derived idempotent name through the client", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create({
      env: { GREETING: "hi there" },
      idempotencyKey: "same-key",
      resources: { vcpus: 2 },
    });
    expect(backend.createBodies[0]?.name).toMatch(/^sbox-[0-9a-f]{16}$/);
    expect(backend.createBodies[0]?.resources).toEqual({ cpus: 2 });
    expect((await sb.commands.run("echo $GREETING")).stdout).toBe("hi there");
    // a reconnected handle reloads the persisted env
    const again = await client.connect(sb.id);
    expect((await again.commands.run("echo $GREETING")).stdout).toBe(
      "hi there"
    );
    // a retried create with the same key returns the same VM (409 → get)
    const dup = await client.create({ idempotencyKey: "same-key" });
    expect(dup.id).toBe(sb.id);
    expect(
      [...backend.sandboxes.values()].filter(
        (s) => s.info.status !== "terminated"
      )
    ).toHaveLength(1);
  });

  it("onIdle destroy without a name creates an ephemeral sandbox", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create({ lifecycle: { onIdle: "destroy" } });
    expect(backend.createBodies[0]?.name).toBeUndefined();
    await expect(sb.pause()).rejects.toMatchObject({ code: "Validation" });
  });
});

describe("state, errors, list", () => {
  it("maps every status", () => {
    expect(mapTensorlakeStatus("pending")).toBe("creating");
    expect(mapTensorlakeStatus("running")).toBe("running");
    expect(mapTensorlakeStatus("snapshotting")).toBe("running");
    expect(mapTensorlakeStatus("suspending")).toBe("suspending");
    expect(mapTensorlakeStatus("suspended")).toBe("paused");
    expect(mapTensorlakeStatus("terminated")).toBe("destroyed");
    expect(mapTensorlakeStatus("timeout")).toBe("destroyed");
    expect(mapTensorlakeStatus("failed")).toBe("error");
    expect(mapTensorlakeStatus("resume_failed")).toBe("error");
    expect(mapTensorlakeStatus("weird")).toBe("unknown");
  });

  it("maps HTTP errors", () => {
    const code = (s: number, c?: string) =>
      mapTensorlakeError(new TensorlakeHttpError(s, "x", c))?.code;
    expect(code(401)).toBe("Unauthorized");
    expect(code(403)).toBe("Unauthorized");
    expect(code(404)).toBe("NotFound");
    expect(code(409)).toBe("Conflict");
    expect(code(409, "SANDBOX_AUTO_RESUME_DISABLED")).toBe("Conflict");
    expect(code(429)).toBe("QuotaExceeded");
    expect(
      mapTensorlakeError(new TensorlakeHttpError(429, "x"))?.retryable
    ).toBe(true);
    expect(code(500, "QUOTA_EXCEEDED")).toBe("QuotaExceeded");
    expect(code(504)).toBe("Timeout");
    expect(code(422)).toBe("Validation");
    expect(code(502)).toBe("Provider");
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(mapTensorlakeError(abort)?.code).toBe("Timeout");
  });

  it("getInfo reports live state and list paginates with filters", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const a = await client.create({ name: "alpha" });
    await client.create({ name: "beta" });
    await client.create({ name: "gamma" });
    expect((await a.getInfo()).state).toBe("running");
    await a.pause();
    expect((await a.getInfo()).state).toBe("paused");
    const all: string[] = [];
    for await (const i of client.list()) {
      all.push(i.name ?? "");
    }
    expect(all.toSorted()).toEqual(["alpha", "beta", "gamma"]); // 2 pages
    const running: string[] = [];
    for await (const i of client.list({ state: "running" })) {
      running.push(i.name ?? "");
    }
    expect(running.toSorted()).toEqual(["beta", "gamma"]);
    let n = 0;
    for await (const _ of client.list({ limit: 1 })) {
      n++;
    }
    expect(n).toBe(1);
    const byName: string[] = [];
    for await (const i of client.list({ metadata: { "sbox-name": "beta" } })) {
      byName.push(i.name ?? "");
    }
    expect(byName).toEqual(["beta"]);
    await expect(
      (async () => {
        for await (const _ of client.list({ metadata: { team: "x" } })) {
          // unreachable
        }
      })()
    ).rejects.toMatchObject({ code: "NotSupported" });
  });

  it("verify fails with a bad key", async () => {
    const bad = createSandboxClient({
      provider: tensorlake({
        apiKey: "nope",
        apiUrl: API,
        fetch: backend.fetch,
      }),
      telemetry: false,
    });
    const res = await bad.verify();
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.error.code).toBe("Unauthorized");
  });
});

describe("previews", () => {
  it("returns subdomain previews with sandbox-wide visibility", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create();
    const pub = await sb.ports!.expose(6080);
    expect(pub.url).toBe(`https://6080-${sb.id}.sandbox.tensorlake.test`);
    expect(pub.wsUrl).toBe(`wss://6080-${sb.id}.sandbox.tensorlake.test`);
    expect(pub.auth).toEqual({ type: "public" });
    const priv = await sb.ports!.expose(9000, { visibility: "private" });
    expect(priv.auth).toEqual({
      headers: { Authorization: `Bearer ${KEY}` },
      type: "header",
    });
    expect(backend.patchBodies.at(-1)).toEqual({
      allow_unauthenticated_access: false,
      exposed_ports: [6080, 9000],
    });
    // loosening while another port is private would publish it: refused
    await expect(sb.ports!.expose(7000)).rejects.toMatchObject({
      code: "Conflict",
    });
    await sb.ports!.unexpose(9000);
    expect((await sb.ports!.list()).map((p) => p.port)).toEqual([6080]);
  });
});

describe("templates", () => {
  it("builds a Dockerfile template via the SDK with a scoped API key", async () => {
    process.env.TENSORLAKE_API_KEY = "someone-else";
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const events: string[] = [];
    const ref = await client.templates!.build(
      {
        env: { DISPLAY: ":1" },
        name: "Borat Desktop",
        source: {
          context: { "x.txt": "x" },
          dockerfile: "FROM debian:bookworm\nCOPY x.txt /x.txt",
        },
      },
      { onEvent: (e) => events.push(e.type === "log" ? e.line : e.status) }
    );
    expect(ref.id).toMatch(/^borat-desktop-[0-9a-f]{12}$/);
    expect(sdkCalls.create[0]?.envKey).toBe(KEY);
    expect(process.env.TENSORLAKE_API_KEY).toBe("someone-else");
    expect(sdkCalls.create[0]?.options).toMatchObject({
      isPublic: false,
      registeredName: ref.id,
    });
    expect(events).toContain('ENV DISPLAY=":1"');
    const again = await client.templates!.get(ref.cacheKey!);
    expect(again?.id).toBe(ref.id);
    delete process.env.TENSORLAKE_API_KEY;
  });

  it("imports a registry image with credentials, never public", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    await client.templates!.build({
      source: {
        image: "ghcr.io/acme/app:1",
        registryAuth: { password: "p", username: "u" },
      },
    });
    const opts = sdkCalls.import[0]?.options as {
      dockerConfigJson: string;
      isPublic: boolean;
    };
    expect(opts.isPublic).toBe(false);
    expect(JSON.parse(opts.dockerConfigJson)).toEqual({
      auths: { "ghcr.io": { auth: btoa("u:p") } },
    });
  });

  it("names templates after the cache key", () => {
    const key = "a".repeat(64);
    expect(tensorlakeTemplateName("sbox-aaaaaaaaaaaaaaaa", key)).toBe(
      "sbox-aaaaaaaaaaaaaaaa"
    );
    expect(tensorlakeTemplateName("My App!", key)).toBe("my-app-aaaaaaaaaaaa");
  });
});

describe("volumes, snapshots, fork, getOrCreate", () => {
  it("manages Cloud Volumes", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const v = await client.volumes!.create({ name: "skills" });
    expect(v.id).toBe("skills");
    expect((await client.volumes!.get("skills"))?.name).toBe("skills");
    const names: string[] = [];
    for await (const x of client.volumes!.list()) {
      names.push(x.id);
    }
    expect(names).toEqual(["skills"]);
    await client.volumes!.delete("skills");
    expect(await client.volumes!.get("skills")).toBeUndefined();
  });

  it("memory snapshots restore into a new sandbox", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create();
    await sb.files.write("/tmp/m.txt", "kept");
    const snap = await sb.snapshots!.create({ mode: "memory", name: "s" });
    expect(snap.includesMemory).toBe(true);
    expect((await sb.snapshots!.list()).map((s) => s.id)).toEqual([snap.id]);
    const restored = await client.create({ fromSnapshot: snap });
    expect(await (await restored.files.read("/tmp/m.txt")).text()).toBe("kept");
    await sb.snapshots!.delete(snap);
    expect(await sb.snapshots!.list()).toEqual([]);
  });

  it("getOrCreate resumes a suspended named sandbox", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const a = await client.getOrCreate({ name: "desk" });
    await a.pause();
    const b = await client.getOrCreate({ name: "desk" });
    expect(b.id).toBe(a.id);
    expect((await b.getInfo()).state).toBe("running");
  });

  it("forks count copies with unique names", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create({ name: "parent" });
    const kids = await sb.fork({ count: 2 });
    expect(kids).toHaveLength(2);
    expect(new Set(kids.map((k) => k.id)).size).toBe(2);
  });

  it("metrics computes CPU from two samples", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create();
    const m = await sb.metrics();
    expect(m.cpuPercent).toBeCloseTo(25);
    expect(m.memoryUsedMB).toBe(256);
    expect(m.memoryTotalMB).toBe(1024);
  });
});
