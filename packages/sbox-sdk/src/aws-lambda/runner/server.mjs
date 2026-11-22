// Reference "runner" for sbox-sdk's AWS Lambda MicroVMs adapter.
// Bake this into your MicroVM image (see Dockerfile + README). It serves the
// small HTTP protocol the adapter calls over the microVM's endpoint, plus the
// AWS lifecycle hooks. No external deps — Node stdlib only (Node >= 18).
//
// Data plane, on PORT (default 8080):
//   POST /sbox/exec   { id?, cmd, cwd?, env?, timeoutMs?, stream? }
//        stream=true  -> NDJSON lines: {"type":"stdout"|"stderr","data"} ...
//                        then {"type":"exit","exitCode","signal"?,"timedOut"?}
//        stream=false -> { stdout, stderr, exitCode, timedOut? }
//   POST /sbox/kill   { id, signal? }             -> { ok }   (404 if unknown)
//   GET  /sbox/ps                                 -> [{ id, cmd, pid }]
//   GET  /sbox/files?path=/abs                    -> raw bytes (404 if missing)
//   PUT  /sbox/files?path=/abs   <raw bytes>      -> { ok }  (mkdir -p parent)
//   GET  /sbox/info                               -> { microvmId, name, metadata }
//   GET  /sbox/health                             -> 200
//   (legacy) POST /sbox/fs/read {path} / /sbox/fs/write {path, contentBase64}
//
// Lifecycle hooks, on HOOKS_PORT (default 9000) — and on PORT too, for images
// built without a separate hooks port:
//   POST /aws/lambda-microvms/runtime/v1/run      body { microvmId, runHookPayload }
//        runHookPayload (from RunMicrovm) is JSON { env?, metadata?, name? }:
//        `env` is applied to every later exec (request env wins).
//   POST /aws/lambda-microvms/runtime/v1/{ready,validate,resume,suspend,terminate} -> 200
//
// The runner executes arbitrary commands on purpose: it runs INSIDE the
// isolated MicroVM (that is the sandbox). Never run it on a host. Keep the hooks
// port out of the auth tokens you hand to callers.

import { exec, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const HOOKS_PORT = Number(process.env.HOOKS_PORT ?? 9000);
const HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1/";

/** Per-MicroVM state delivered by the /run hook. */
const state = { env: {}, metadata: {}, microvmId: undefined, name: undefined };
/** Running execs by id, for /sbox/kill and /sbox/ps. */
const running = new Map();
let seq = 0;

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const readJson = async (req) => {
  const buf = await readBody(req);
  return buf.length ? JSON.parse(buf.toString("utf8")) : {};
};

const send = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(obj === undefined ? "" : JSON.stringify(obj));
};

/** Apply the /run hook payload (JSON { env, metadata, name }; ignore other shapes). */
function applyRunHook(body) {
  state.microvmId = body.microvmId ?? state.microvmId;
  if (typeof body.runHookPayload !== "string" || !body.runHookPayload) {
    return;
  }
  try {
    const payload = JSON.parse(body.runHookPayload);
    if (payload && typeof payload === "object") {
      state.env = { ...payload.env };
      state.metadata = { ...payload.metadata };
      state.name = payload.name;
    }
  } catch {
    // Not ours (a plain-string payload): leave state alone.
  }
}

async function handleHook(name, req, res) {
  if (name === "run") {
    applyRunHook(await readJson(req).catch(() => ({})));
  }
  return send(res, 200, { ok: true });
}

/** Kill a process group (the command and everything it started). */
function killGroup(child, signal = "SIGKILL") {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function startExec({ id, cmd, cwd, env, timeoutMs }) {
  const child = spawn("sh", ["-c", cmd], {
    cwd: cwd || undefined,
    detached: true, // own process group, so kill reaches grandchildren
    env: { ...process.env, ...state.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entry = { child, cmd, id, timedOut: false };
  running.set(id, entry);
  if (timeoutMs > 0) {
    entry.timer = setTimeout(() => {
      entry.timedOut = true;
      killGroup(child);
    }, timeoutMs);
  }
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(entry.timer);
      running.delete(id);
      resolve({ exitCode, signal, timedOut: entry.timedOut });
    };
    child.on("error", () => finish(127, undefined));
    child.on("close", (code, signal) =>
      finish(
        code ?? (signal ? 128 + (signalNumber(signal) ?? 9) : 1),
        signal ?? undefined
      )
    );
  });
  return { child, done };
}

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15, SIGQUIT: 3 };
const signalNumber = (s) => SIGNALS[s];

async function handleExec(req, res) {
  const body = await readJson(req);
  const id = String(body.id ?? `x${++seq}`);
  if (!body.stream) {
    // Buffered (legacy) mode.
    const r = await new Promise((resolve) => {
      exec(
        body.cmd,
        {
          cwd: body.cwd || undefined,
          env: { ...process.env, ...state.env, ...body.env },
          maxBuffer: 64 * 1024 * 1024,
          timeout: body.timeoutMs ?? 0,
        },
        (err, stdout, stderr) => {
          const exitCode =
            err && typeof err.code === "number" ? err.code : err ? 1 : 0;
          resolve({
            exitCode,
            stderr: String(stderr),
            stdout: String(stdout),
            timedOut: Boolean(err?.killed && body.timeoutMs),
          });
        }
      );
    });
    return send(res, 200, r);
  }
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  const line = (obj) => res.write(`${JSON.stringify(obj)}\n`);
  const { child, done } = startExec({ ...body, id });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data) => line({ data, type: "stdout" }));
  child.stderr.on("data", (data) => line({ data, type: "stderr" }));
  // Client went away (adapter kill/abort): stop the command too.
  res.on("close", () => {
    if (running.has(id)) killGroup(child);
  });
  const result = await done;
  line({ type: "exit", ...result });
  res.end();
}

async function handleData(req, res, url) {
  const path = url.pathname;
  if (req.method === "GET" && path === "/sbox/health") {
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && path === "/sbox/info") {
    return send(res, 200, {
      metadata: state.metadata,
      microvmId: state.microvmId,
      name: state.name,
    });
  }
  if (req.method === "POST" && path === "/sbox/exec") {
    return handleExec(req, res);
  }
  if (req.method === "POST" && path === "/sbox/kill") {
    const { id, signal } = await readJson(req);
    const entry = running.get(String(id));
    if (!entry) return send(res, 404, { error: "no such process" });
    killGroup(entry.child, signal || "SIGKILL");
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && path === "/sbox/ps") {
    return send(
      res,
      200,
      [...running.values()].map((e) => ({
        cmd: e.cmd,
        id: e.id,
        pid: e.child.pid,
      }))
    );
  }
  if (path === "/sbox/files") {
    const file = url.searchParams.get("path");
    if (!file) return send(res, 400, { error: "path required" });
    if (req.method === "GET") {
      try {
        const buf = await readFile(file);
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(buf);
      } catch (error) {
        return send(res, error?.code === "EISDIR" ? 400 : 404, {
          error: String(error?.code),
        });
      }
    }
    if (req.method === "PUT") {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, await readBody(req));
      return send(res, 200, { ok: true });
    }
  }
  // Legacy JSON file routes.
  if (req.method === "POST" && path === "/sbox/fs/read") {
    const { path: file } = await readJson(req);
    try {
      return send(res, 200, {
        contentBase64: (await readFile(file)).toString("base64"),
      });
    } catch {
      return send(res, 404, { error: "not found" });
    }
  }
  if (req.method === "POST" && path === "/sbox/fs/write") {
    const { path: file, contentBase64 } = await readJson(req);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(contentBase64, "base64"));
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: "unknown route" });
}

function makeServer(withData) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://runner");
      if (req.method === "POST" && url.pathname.startsWith(HOOK_PREFIX)) {
        return await handleHook(
          url.pathname.slice(HOOK_PREFIX.length),
          req,
          res
        );
      }
      if (!withData) return send(res, 404, { error: "hooks port" });
      return await handleData(req, res, url);
    } catch (error) {
      if (!res.headersSent)
        return send(res, 500, { error: String(error?.message ?? error) });
      res.end();
    }
  });
}

makeServer(true).listen(PORT, () =>
  console.log(`[sbox-runner] data plane on :${PORT}`)
);
if (HOOKS_PORT !== PORT) {
  makeServer(false).listen(HOOKS_PORT, () =>
    console.log(`[sbox-runner] lifecycle hooks on :${HOOKS_PORT}`)
  );
}
