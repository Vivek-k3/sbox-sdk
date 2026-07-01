/**
 * `sbox-sdk/beam` — adapter for Beam Cloud sandboxes (`@beamcloud/beam-js`).
 * A "sandbox" is a Beam sandboxed container (real Linux + coreutils), with
 * first-class GPU. exec uses `instance.exec(cmd, { cwd, env })` and buffers the
 * process streams (`streaming` emulated). The SDK's filesystem helpers are
 * local-path based, so `readFile`/`writeFile` go through exec + base64 (binary
 * safe, portable). Ports are public SSL endpoints (`exposePort`). `snapshot()`
 * maps to `instance.snapshot()` and `fork()` snapshots then boots N sandboxes
 * from it. `setTimeout()` maps to `updateTtl`. Requires the optional peer
 * dependency `@beamcloud/beam-js`.
 */
import {
  AsyncQueue,
  base64ToBytes,
  bytesToBase64,
  defineProvider,
  SandboxError,
  shellQuote as sq,
} from "../adapter/index.js";
import type {
  CapabilityFlags,
  CapabilityMap,
  DriverExec,
  DriverHandle,
  ExecOptions,
  OutputEvent,
  Preview,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
  SnapshotRef,
} from "../adapter/index.js";

export interface BeamOptions {
  /** Beam API token (falls back to the SDK's standard environment). */
  token?: string;
  /** Beam workspace id (falls back to the SDK's standard environment). */
  workspaceId?: string;
  /** Default base image when a spec omits `template`. */
  image?: string;
  /** Default vCPUs for new sandboxes. */
  cpu?: number;
  /** Default memory (e.g. "1Gi") for new sandboxes. */
  memory?: string;
}

export const BEAM_CAPS = {
  background: "unsupported",
  codeInterpreter: "unsupported",
  egressControl: "unsupported",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "native",
  gpu: "native",
  killProcess: "unsupported",
  list: "unsupported",
  metrics: "unsupported",
  pause: "unsupported",
  privatePreview: "unsupported",
  proxiedFetch: "unsupported",
  pty: "unsupported",
  region: "unsupported",
  secretsVault: "unsupported",
  setTimeout: "native",
  snapshot: "native",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "unsupported",
  streaming: "emulated",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type BeamCaps = typeof BEAM_CAPS;

const BEAM_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true, // exec accepts { cwd, env }
  preservesDiskOnStop: false,
  preservesMemoryOnPause: false,
  previewModel: "subdomain",
};

// Structural views of the `@beamcloud/beam-js` surface.
interface BeamStream {
  read?(): Promise<string | Uint8Array | null>;
  [Symbol.asyncIterator]?(): AsyncIterator<string | Uint8Array>;
}
interface BeamProcess {
  pid?: number;
  stdout?: BeamStream | string;
  stderr?: BeamStream | string;
  wait(): Promise<number>;
  kill(): Promise<void>;
}
interface BeamInstance {
  exec(
    command: string | string[],
    opts?: { cwd?: string; env?: Record<string, string> }
  ): Promise<BeamProcess>;
  exposePort(port: number): Promise<string>;
  snapshot(): Promise<string>;
  updateTtl(ttl: number): Promise<void>;
  terminate(): Promise<boolean>;
  sandboxId(): string;
}
interface BeamSandboxCtor {
  new (opts: Record<string, unknown>): { create(): Promise<BeamInstance> };
  connect(id: string): Promise<BeamInstance>;
  createFromSnapshot(snapshotId: string): Promise<BeamInstance>;
}
interface BeamModule {
  Sandbox: BeamSandboxCtor;
  Image?: new (opts: Record<string, unknown>) => unknown;
  beamOpts: { token?: string; workspaceId?: string };
}

let cached: BeamModule | null = null;
async function loadBeam(): Promise<BeamModule> {
  if (!cached) {
    cached = (await import("@beamcloud/beam-js")) as unknown as BeamModule;
  }
  return cached;
}

async function readAll(
  stream: BeamStream | string | undefined
): Promise<string> {
  if (!stream) {
    return "";
  }
  if (typeof stream === "string") {
    return stream;
  }
  const decode = (c: string | Uint8Array) =>
    typeof c === "string" ? c : new TextDecoder().decode(c);
  if (typeof stream[Symbol.asyncIterator] === "function") {
    let s = "";
    for await (const c of stream as AsyncIterable<string | Uint8Array>) {
      s += decode(c);
    }
    return s;
  }
  if (typeof stream.read === "function") {
    let s = "";
    for (;;) {
      const c = await stream.read();
      if (c === null || c === undefined) {
        break;
      }
      s += decode(c);
    }
    return s;
  }
  return "";
}

export const beam = defineProvider<BeamCaps, BeamInstance, BeamOptions>(
  (opts) => {
    const configure = async (): Promise<BeamModule> => {
      const mod = await loadBeam();
      if (opts.token) {
        mod.beamOpts.token = opts.token;
      }
      if (opts.workspaceId) {
        mod.beamOpts.workspaceId = opts.workspaceId;
      }
      return mod;
    };

    // Buffered exec: run the command, drain stdout/stderr, then resolve the code.
    const runBuffered = async (
      inst: BeamInstance,
      cmd: string,
      options: ExecOptions
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      const proc = await inst.exec(cmd, {
        cwd: options.cwd,
        env: options.env,
      });
      const [stdout, stderr] = await Promise.all([
        readAll(proc.stdout),
        readAll(proc.stderr),
      ]);
      const exitCode = await proc.wait();
      return { stdout, stderr, exitCode: exitCode ?? 0 };
    };

    const makeHandle = (inst: BeamInstance): DriverHandle<BeamInstance> => {
      const id = inst.sandboxId();
      // base64 fs uses a bare exec (no cwd/env) so it is independent of options.
      const fsExec = (cmd: string) => runBuffered(inst, cmd, {});

      return {
        id,
        raw: inst,

        getInfo(): SandboxInfo {
          return {
            id,
            state: "running",
            provider: "beam",
            metadata: {},
            raw: inst,
          };
        },
        async destroy(): Promise<void> {
          await inst.terminate();
        },
        async setTimeout(ttlMs: number): Promise<void> {
          await inst.updateTtl(Math.max(1, Math.ceil(ttlMs / 1000)));
        },

        exec(cmd: string, options: ExecOptions): DriverExec {
          const queue = new AsyncQueue<OutputEvent>();
          void runBuffered(inst, cmd, options)
            .then((r) => {
              if (r.stdout) {
                queue.push({ type: "stdout", data: r.stdout });
              }
              if (r.stderr) {
                queue.push({ type: "stderr", data: r.stderr });
              }
              queue.push({ type: "exit", exitCode: r.exitCode });
              queue.close();
            })
            .catch((error) =>
              queue.fail(
                error instanceof SandboxError
                  ? error
                  : SandboxError.wrap(error, "beam")
              )
            );
          return {
            pid: Promise.resolve(""),
            async kill() {
              /* buffered exec; use the native process API for control */
            },
            [Symbol.asyncIterator]: () => queue.iterator(),
          };
        },

        async readFile(path: string): Promise<Uint8Array> {
          const r = await fsExec(`base64 ${sq(path)}`);
          if (r.exitCode !== 0) {
            throw new SandboxError("NotFound", `no such file: '${path}'`, {
              provider: "beam",
            });
          }
          return base64ToBytes(r.stdout);
        },
        async writeFile(path: string, data: Uint8Array): Promise<void> {
          const b64 = bytesToBase64(data);
          const r = await fsExec(
            `mkdir -p "$(dirname ${sq(path)})" && printf %s ${sq(b64)} | base64 -d > ${sq(path)}`
          );
          if (r.exitCode !== 0) {
            throw new SandboxError("Provider", `write failed: '${path}'`, {
              provider: "beam",
            });
          }
        },

        async exposePort(port: number): Promise<Preview> {
          return { url: await inst.exposePort(port), port };
        },

        async snapshot(snapOpts: { name?: string }): Promise<SnapshotRef> {
          const snapshotId = await inst.snapshot();
          return {
            id: snapshotId,
            name: snapOpts.name,
            provider: "beam",
            raw: snapshotId,
          };
        },
        async fork(count: number): Promise<DriverHandle<BeamInstance>[]> {
          const snapshotId = await inst.snapshot();
          const mod = await configure();
          const forks = await Promise.all(
            Array.from({ length: count }, () =>
              mod.Sandbox.createFromSnapshot(snapshotId)
            )
          );
          return forks.map((f) => makeHandle(f));
        },
      };
    };

    const provider: SandboxProvider<BeamCaps, BeamInstance> = {
      name: "beam",
      capabilities: BEAM_CAPS,
      flags: BEAM_FLAGS,

      async create(spec: SandboxSpec): Promise<DriverHandle<BeamInstance>> {
        const mod = await configure();
        const image = spec.template ?? opts.image;
        const sandbox = new mod.Sandbox({
          name: spec.name,
          cpu: spec.resources?.vcpus ?? opts.cpu ?? 1,
          memory:
            (spec.resources?.memoryMB
              ? `${spec.resources.memoryMB}Mi`
              : undefined) ??
            opts.memory ??
            "1Gi",
          gpu: spec.resources?.gpu,
          ports: spec.ports,
          keepWarmSeconds: spec.ttlMs
            ? Math.ceil(spec.ttlMs / 1000)
            : undefined,
          image:
            image && mod.Image
              ? new mod.Image({ baseImage: image })
              : undefined,
        });
        return makeHandle(await sandbox.create());
      },

      async connect(id: string): Promise<DriverHandle<BeamInstance>> {
        const mod = await configure();
        return makeHandle(await mod.Sandbox.connect(id));
      },
    };
    return provider;
  }
);
