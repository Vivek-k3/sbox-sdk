/**
 * Offline tests for the (deprecated) CodeSandbox adapter. `@codesandbox/sdk` is
 * replaced by a fake modelled on the 2.4.2 `.d.ts`, backed by `MiniShell` over
 * an in-memory filesystem per sandbox. Like the real SDK, command output is
 * one merged PTY stream and a non-zero exit rejects with a `CommandError`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../index.js";
import { MiniShell } from "../memory/shell.js";
import type { ShellFs } from "../memory/shell.js";
// The SDK's own declarations don't resolve under NodeNext (see index.ts), so
// the fake is typed against the adapter's views of the 2.4.2 `.d.ts`.
import type {
  CsbClient as SandboxClient,
  CsbCommand as Command,
  CsbInfo,
  CsbSandbox,
  CsbSdk,
} from "./index.js";
import {
  CODESANDBOX_CAPS,
  codesandbox,
  mapCsbError,
  mapCsbState,
  metadataToTags,
  tagsToMetadata,
} from "./index.js";

// ---------------------------------------------------------------------------
// in-memory VM filesystem
// ---------------------------------------------------------------------------

const norm = (p: string): string => {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "..") {
      out.pop();
    } else if (seg && seg !== ".") {
      out.push(seg);
    }
  }
  return `/${out.join("/")}`;
};
const parent = (p: string) => norm(p).slice(0, norm(p).lastIndexOf("/")) || "/";

class FakeFs implements ShellFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set(["/", "/tmp", "/project", "/project/sandbox"]);
  #mkp(d: string) {
    for (let c = norm(d); !this.dirs.has(c); c = parent(c)) {
      this.dirs.add(c);
    }
  }
  read(p: string) {
    return this.files.get(norm(p)) ?? null;
  }
  write(p: string, d: Uint8Array) {
    this.#mkp(parent(p));
    this.files.set(norm(p), d);
  }
  isDir(p: string) {
    return this.dirs.has(norm(p));
  }
  list(d: string) {
    const dir = norm(d);
    if (!this.dirs.has(dir)) {
      return null;
    }
    const out = new Map<string, "file" | "dir">();
    for (const x of this.dirs) {
      if (x !== dir && parent(x) === dir) {
        out.set(x.slice(x.lastIndexOf("/") + 1), "dir");
      }
    }
    for (const x of this.files.keys()) {
      if (parent(x) === dir) {
        out.set(x.slice(x.lastIndexOf("/") + 1), "file");
      }
    }
    return [...out].map(([name, type]) => ({ name, type }));
  }
  mkdir(p: string, recursive: boolean) {
    if (this.dirs.has(norm(p))) {
      return recursive ? null : `mkdir: ${p}: File exists`;
    }
    if (!recursive && !this.dirs.has(parent(p))) {
      return `mkdir: ${p}: No such file or directory`;
    }
    this.#mkp(p);
    return null;
  }
  remove(p: string, recursive: boolean, force: boolean) {
    const n = norm(p);
    if (this.files.delete(n)) {
      return null;
    }
    if (this.dirs.has(n)) {
      if (!recursive) {
        return `rm: ${p}: Is a directory`;
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
    return force ? null : `rm: ${p}: No such file or directory`;
  }
  rename(a: string, b: string) {
    const data = this.files.get(norm(a));
    if (!data) {
      return `mv: cannot stat '${a}'`;
    }
    this.files.delete(norm(a));
    this.write(b, data);
    return null;
  }
  stat(p: string) {
    const n = norm(p);
    if (this.dirs.has(n)) {
      return { size: 0, type: "dir" as const };
    }
    const f = this.files.get(n);
    return f ? { size: f.length, type: "file" as const } : null;
  }
}

// ---------------------------------------------------------------------------
// fake SDK
// ---------------------------------------------------------------------------

interface Rec {
  id: string;
  fs: FakeFs;
  tags: string[];
  title?: string;
  state: "running" | "hibernated" | "shutdown";
  createdAt: Date;
}
let seq = 0;
const world = {
  calls: [] as { method: string; args: unknown }[],
  sandboxes: new Map<string, Rec>(),
};
const record = (method: string, args: unknown) =>
  world.calls.push({ args, method });
const callsOf = (m: string) =>
  world.calls.filter((c) => c.method === m).map((c) => c.args);
const notFound = (what: string) =>
  new Error(`Failed to ${what}: Sandbox not found`);
const rec = (id: string, what: string): Rec => {
  const r = world.sandboxes.get(id);
  if (!r) {
    throw notFound(what);
  }
  return r;
};
const enoent = (p: string) =>
  new Error(`ENOENT: no such file or directory '${p}'`);
const dec = new TextDecoder();

function fakeCommand(
  r: Rec,
  cmd: string,
  opts?: { cwd?: string; env?: Record<string, string> }
) {
  const listeners = new Set<(s: string) => void>();
  const ac = new AbortController();
  let output = "";
  const emit = (d: Uint8Array) => {
    const s = dec.decode(d).replaceAll("\n", "\r\n"); // PTY line endings
    output += s;
    for (const l of listeners) {
      l(s);
    }
  };
  // Start on the next macrotask, as output arrives over the socket.
  const done = new Promise<number>((res) => setTimeout(res, 0)).then(() =>
    new MiniShell(r.fs).run(cmd, {
      cwd: opts?.cwd ?? "/project/sandbox",
      env: { HOME: "/root", ...opts?.env },
      signal: ac.signal,
      stderr: emit,
      stdin: new Uint8Array(),
      stdout: emit,
    })
  );
  const command = {
    command: cmd,
    kill: async () => {
      record("command.kill", cmd);
      ac.abort();
    },
    onOutput: (l: (s: string) => void) => {
      listeners.add(l);
      return { dispose: () => listeners.delete(l) };
    },
    waitUntilComplete: async () => {
      const code = await done;
      if (code !== 0) {
        throw Object.assign(
          new Error(`Command failed with exit code ${code}`),
          {
            exitCode: code,
            name: "CommandError",
            output,
          }
        );
      }
      return output;
    },
  } satisfies Command & { command: string };
  return command;
}

function fakeClient(r: Rec): SandboxClient {
  let disposed = false;
  const assertRunning = () => {
    if (disposed || r.state !== "running") {
      throw new Error("Sandbox client is disconnected");
    }
  };
  const client = {
    commands: {
      runBackground: async (cmd, opts) => {
        assertRunning();
        record("runBackground", { cmd, opts });
        return fakeCommand(
          r,
          Array.isArray(cmd) ? cmd.join(" && ") : cmd,
          opts
        );
      },
    } satisfies Pick<SandboxClient["commands"], "runBackground">,
    dispose: () => {
      disposed = true;
    },
    fs: {
      readFile: async (p) => {
        assertRunning();
        const d = r.fs.read(p);
        if (!d) {
          throw enoent(p);
        }
        return d;
      },
      readdir: async (p) => {
        const l = r.fs.list(p);
        if (!l) {
          throw enoent(p);
        }
        return l.map((e) => ({
          isSymlink: false,
          name: e.name,
          type: e.type === "dir" ? ("directory" as const) : ("file" as const),
        }));
      },
      remove: async (p, recursive) => {
        r.fs.remove(p, recursive ?? false, true);
      },
      rename: async (a, b) => {
        if (r.fs.rename(a, b)) {
          throw enoent(a);
        }
      },
      stat: async (p) => {
        const s = r.fs.stat(p);
        if (!s) {
          throw enoent(p);
        }
        return {
          atime: 0,
          ctime: 0,
          isSymlink: false,
          mtime: 0,
          size: s.size,
          type: s.type === "dir" ? ("directory" as const) : ("file" as const),
        };
      },
      writeFile: async (p, content, o) => {
        record("fs.writeFile", { o, p });
        r.fs.write(p, content);
      },
    } satisfies Pick<
      SandboxClient["fs"],
      "readFile" | "readdir" | "remove" | "rename" | "stat" | "writeFile"
    >,
    hosts: {
      getUrl: (port: number, protocol = "https") =>
        `${protocol}://${r.id}-${port}.csb.app`,
    },
    get state() {
      if (disposed) {
        return "DISCONNECTED" as const;
      }
      return r.state === "running"
        ? ("CONNECTED" as const)
        : r.state === "hibernated"
          ? ("HIBERNATED" as const)
          : ("DISCONNECTED" as const);
    },
  };
  return client satisfies SandboxClient;
}

function fakeSandbox(r: Rec) {
  return {
    connect: async () => fakeClient(r),
    id: r.id,
    updateHibernationTimeout: async (s: number) => {
      record("updateHibernationTimeout", s);
    },
  } satisfies CsbSandbox;
}

const info = (r: Rec): CsbInfo => ({
  createdAt: r.createdAt,
  id: r.id,
  tags: r.tags,
  title: r.title,
});

const sandboxes = {
  create: async (o = {}) => {
    record("create", o);
    const r: Rec = {
      createdAt: new Date(),
      fs: new FakeFs(),
      id: `csb${++seq}`,
      state: "running",
      tags: o.tags ?? [],
      title: o.title,
    };
    world.sandboxes.set(r.id, r);
    return fakeSandbox(r);
  },
  delete: async (id) => {
    record("delete", id);
    rec(id, "delete sandbox");
    world.sandboxes.delete(id);
  },
  get: async (id) => info(rec(id, "get sandbox")),
  hibernate: async (id) => {
    rec(id, "hibernate").state = "hibernated";
  },
  list: async (o = {}) => {
    record("list", o);
    const page = o.pagination?.page ?? 1;
    const size = o.pagination?.pageSize ?? o.limit ?? 50;
    const all = [...world.sandboxes.values()].filter(
      (r) =>
        (!o.status || r.state === "running") &&
        (o.tags ?? []).every((t) => r.tags.includes(t))
    );
    const slice = all.slice((page - 1) * size, page * size);
    const nextPage = page * size < all.length ? page + 1 : null;
    return {
      hasMore: nextPage !== null,
      pagination: { currentPage: page, nextPage, pageSize: size },
      sandboxes: slice.map(info),
      totalCount: all.length,
    };
  },
  listRunning: async () => {
    const vms = [...world.sandboxes.values()]
      .filter((r) => r.state === "running")
      .map((r) => ({
        creditBasis: undefined,
        id: r.id,
        lastActiveAt: undefined,
        sessionStartedAt: undefined,
        specs: undefined,
      }));
    return { concurrentVmCount: vms.length, concurrentVmLimit: 10, vms };
  },
  resume: async (id) => {
    const r = rec(id, "resume sandbox");
    r.state = "running";
    return fakeSandbox(r);
  },
  shutdown: async (id) => {
    rec(id, "shutdown").state = "shutdown";
  },
} satisfies Pick<
  CsbSdk["sandboxes"] & { shutdown(id: string): Promise<void> },
  | "create"
  | "delete"
  | "get"
  | "hibernate"
  | "list"
  | "listRunning"
  | "resume"
  | "shutdown"
>;

const hosts = {
  createToken: async (sandboxId: string, o: { expiresAt: Date }) => ({
    expiresAt: o.expiresAt,
    lastUsedAt: null,
    sandboxId,
    token: `tok-${sandboxId}`,
    tokenId: "t1",
  }),
} satisfies CsbSdk["hosts"];

vi.mock("@codesandbox/sdk", () => ({
  CodeSandbox: class {
    sandboxes = sandboxes;
    hosts = hosts;
  },
}));

beforeEach(() => {
  world.calls.length = 0;
});

describe("codesandbox adapter (deprecated)", () => {
  it("declares truthful caps", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = codesandbox({ apiKey: "k" });
    expect(p.capabilities).toBe(CODESANDBOX_CAPS);
    expect(p.capabilities.streaming).toBe("native");
    expect(typeof p.verify).toBe("function");
    warn.mockRestore();
  });

  it("passes offline conformance (live checks on)", async () => {
    const report = await runConformance(codesandbox({ apiKey: "k" }), {
      live: true,
      // CodeSandbox commands run in a PTY: stdout and stderr are one stream.
      skip: ["exec: stdout and stderr are separate"],
    });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(25);
  }, 60_000);

  it("destroy deletes (not just shuts down) the sandbox", async () => {
    const client = createSandboxClient({
      provider: codesandbox({ apiKey: "k" }),
      telemetry: false,
    });
    const sb = await client.create();
    await sb.destroy();
    expect(callsOf("delete")).toEqual([sb.id]);
    expect(world.sandboxes.has(sb.id)).toBe(false);
  });

  it("encodes metadata as key=value tags and maps the spec", async () => {
    const client = createSandboxClient({
      provider: codesandbox({ apiKey: "k" }),
      telemetry: false,
    });
    const sb = await client.create({
      lifecycle: { idleTimeoutMs: 120_000 },
      metadata: { env: "dev", team: "a" },
      name: "box",
      template: "tpl123",
    });
    expect(callsOf("create")[0]).toEqual({
      hibernationTimeoutSeconds: 120,
      id: "tpl123",
      tags: ["env=dev", "team=a"],
      title: "box",
    });
    const i = await sb.getInfo();
    expect(i.metadata).toEqual({ env: "dev", team: "a" });
    expect(i.name).toBe("box");
    await sb.destroy();
  });

  it("getInfo reflects live state; resume reconnects after hibernate", async () => {
    const client = createSandboxClient({
      provider: codesandbox({ apiKey: "k" }),
      telemetry: false,
    });
    const sb = await client.create();
    expect((await sb.getInfo()).state).toBe("running");
    await sb.pause();
    expect((await sb.getInfo()).state).toBe("paused");
    await sb.resume();
    expect((await sb.commands.run("echo back")).stdout).toBe("back\n");
    // Shut down out-of-band: no longer reported as running.
    world.sandboxes.get(sb.id)!.state = "shutdown";
    expect((await sb.getInfo()).state).toBe("stopped");
    await sb.destroy();
  });

  it("non-zero exit is data; kill() kills the command", async () => {
    const client = createSandboxClient({
      provider: codesandbox({ apiKey: "k" }),
      telemetry: false,
    });
    const sb = await client.create();
    const bad = await sb.commands.run("echo boom >&2; exit 3");
    expect(bad.exitCode).toBe(3);
    expect(bad.stdout).toBe("boom\n"); // merged PTY stream
    const h = sb.commands.run("sleep 30");
    setTimeout(() => void h.kill(), 20);
    expect((await h).exitCode).toBe(137);
    expect(callsOf("command.kill")).toHaveLength(1);
    await sb.destroy();
  });

  it("private previews mint a query-string host token", async () => {
    const client = createSandboxClient({
      provider: codesandbox({ apiKey: "k" }),
      telemetry: false,
    });
    const sb = await client.create();
    const p = await sb.ports!.expose(3000, { visibility: "private" });
    expect(p.url).toBe(`https://${sb.id}-3000.csb.app`);
    expect(p.auth).toEqual({
      param: "preview_token",
      token: `tok-${sb.id}`,
      type: "query",
    });
    expect((await sb.ports!.expose(3001)).auth).toEqual({ type: "public" });
    await sb.destroy();
  });

  it("list paginates every page and reports status", async () => {
    const client = createSandboxClient({
      provider: codesandbox({ apiKey: "k" }),
      telemetry: false,
    });
    const made: Awaited<ReturnType<typeof client.create>>[] = [];
    for (let i = 0; i < 55; i++) {
      made.push(await client.create({ metadata: { grp: "p" } }));
    }
    await made[0]!.pause();
    world.calls.length = 0;
    const seen = [];
    for await (const i of client.list({ metadata: { grp: "p" } })) {
      seen.push(i);
    }
    expect(seen).toHaveLength(55);
    expect(seen.find((s) => s.id === made[0]!.id)?.state).toBe("stopped");
    expect(seen.find((s) => s.id === made[1]!.id)?.state).toBe("running");
    const pages = callsOf("list") as {
      pagination: { page: number };
      tags: string[];
    }[];
    expect(pages.some((c) => c.pagination.page === 2)).toBe(true);
    expect(pages[0]?.tags).toEqual(["grp=p"]);

    const limited = [];
    for await (const i of client.list({ limit: 3, metadata: { grp: "p" } })) {
      limited.push(i);
    }
    expect(limited).toHaveLength(3);
    for (const s of made) {
      await s.destroy();
    }
  });

  it("maps tags, states and errors", () => {
    expect(metadataToTags({ a: "1", b: "x=y" })).toEqual(["a=1", "b=x=y"]);
    expect(tagsToMetadata(["a=1", "b=x=y", "loose"])).toEqual({
      a: "1",
      b: "x=y",
    });
    expect(mapCsbState("CONNECTED", false)).toBe("running");
    expect(mapCsbState("HIBERNATED", false)).toBe("paused");
    expect(mapCsbState("DISCONNECTED", true)).toBe("running");
    expect(mapCsbState("DISCONNECTED", false)).toBe("stopped");

    const code = (e: Error) => mapCsbError(e)?.code;
    expect(code(new Error("Failed to get sandbox: Sandbox not found"))).toBe(
      "NotFound"
    );
    expect(code(new Error("ENOENT: no such file"))).toBe("NotFound");
    expect(code(new Error("Failed to list: Unauthorized"))).toBe(
      "Unauthorized"
    );
    expect(
      code(Object.assign(new Error("slow down"), { type: "rate-limit" }))
    ).toBe("QuotaExceeded");
    expect(code(new Error("weird"))).toBeUndefined();
  });
});
