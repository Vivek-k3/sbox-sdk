// Reference "runner" for sbox-sdk's AWS Lambda MicroVMs adapter.
// Bake this into your MicroVM image (see Dockerfile). It exposes the small HTTP
// protocol the adapter calls over the microVM's dedicated endpoint, plus the
// required AWS lifecycle hooks. No external deps — Node stdlib only.
//
// Protocol (POST JSON unless noted), served on PORT (default 8080):
//   POST /sbox/exec      { cmd, cwd?, env?, timeoutMs? } -> { stdout, stderr, exitCode }
//   POST /sbox/fs/read   { path }                        -> { contentBase64 }   (404 if missing)
//   POST /sbox/fs/write  { path, contentBase64 }         -> { ok: true }
//   GET  /sbox/health                                    -> 200
//   POST /aws/lambda-microvms/runtime/v1/{run,resume,suspend,terminate} -> 200

import { exec } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });

const send = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(obj === undefined ? "" : JSON.stringify(obj));
};

const runCmd = (cmd, cwd, env, timeoutMs) =>
  new Promise((resolve) => {
    exec(
      cmd,
      {
        cwd,
        env: { ...process.env, ...env },
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs ?? 0,
      },
      (err, stdout, stderr) => {
        const exitCode =
          err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ exitCode, stderr: String(stderr), stdout: String(stdout) });
      }
    );
  });

createServer(async (req, res) => {
  try {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/sbox/health") {
      return send(res, 200, { ok: true });
    }

    if (url.startsWith("/aws/lambda-microvms/runtime/v1/")) {
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url === "/sbox/exec") {
      const { cmd, cwd, env, timeoutMs } = await readJson(req);
      return send(res, 200, await runCmd(cmd, cwd, env, timeoutMs));
    }
    if (req.method === "POST" && url === "/sbox/fs/read") {
      const { path } = await readJson(req);
      try {
        const buf = await readFile(path);
        return send(res, 200, { contentBase64: buf.toString("base64") });
      } catch {
        return send(res, 404, { error: "not found" });
      }
    }
    if (req.method === "POST" && url === "/sbox/fs/write") {
      const { path, contentBase64 } = await readJson(req);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(contentBase64, "base64"));
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "unknown route" });
  } catch (error) {
    return send(res, 500, { error: String(error?.message ?? error) });
  }
}).listen(PORT, () => console.log(`[sbox-runner] listening on :${PORT}`));
