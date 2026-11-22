import type { LiveConfig } from "../live/types.js";
import { docker } from "./index.js";
import type { DockerTransport } from "./index.js";
import {
  createNodeTransport,
  discoverEndpoint,
  nodeSocketProbe,
} from "./transport.js";

/** Template the live run builds (and deletes afterwards). */
const TEMPLATE_NAME = "sbox-live-conformance";

async function transport(): Promise<DockerTransport> {
  const os = await import("node:os");
  return createNodeTransport(
    await discoverEndpoint({
      env: process.env,
      home: os.homedir(),
      probe: nodeSocketProbe,
    })
  );
}

async function call(
  t: DockerTransport,
  method: "GET" | "DELETE",
  path: string,
  query?: Record<string, string | boolean>
): Promise<unknown> {
  const res = await t.request({ method, path, query });
  const chunks: Uint8Array[] = [];
  for await (const c of res.body) {
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return res.status < 300 && text ? JSON.parse(text) : undefined;
}

/** Remove everything a conformance run leaves behind (containers, snapshots, template). */
async function cleanup(): Promise<void> {
  const t = await transport();
  try {
    const containers = (await call(t, "GET", "/containers/json", {
      all: true,
      filters: JSON.stringify({ label: ["sbox.meta.sbox-conformance"] }),
    })) as { Id: string }[];
    for (const c of containers ?? []) {
      await call(t, "DELETE", `/containers/${c.Id}`, { force: true, v: true });
    }
    const images = (await call(t, "GET", "/images/json", {
      filters: JSON.stringify({
        label: ["sbox.snapshot.meta.sbox-conformance"],
      }),
    })) as { Id: string; RepoTags?: string[] | null }[];
    for (const img of images ?? []) {
      for (const tag of img.RepoTags ?? []) {
        await call(t, "DELETE", `/images/${encodeURIComponent(tag)}`);
      }
    }
    await call(
      t,
      "DELETE",
      `/images/${encodeURIComponent(`sbox/${TEMPLATE_NAME}:latest`)}`
    );
  } finally {
    t.dispose?.();
  }
}

export const live: LiveConfig = {
  async available() {
    try {
      const t = await transport();
      try {
        const res = await t.request({ method: "GET", path: "/_ping" });
        for await (const _c of res.body) {
          // drain
        }
        return res.status === 200;
      } finally {
        t.dispose?.();
      }
    } catch {
      return false;
    }
  },
  conformance: {
    // Ports must be published at create time on Docker.
    spec: { ports: [8080] },
    template: {
      name: TEMPLATE_NAME,
      source: {
        context: { "hello.txt": "hi" },
        dockerfile:
          "FROM debian:bookworm-slim\nCOPY hello.txt /app/hello.txt\n",
      },
    },
  },
  env: [],
  make: () => {
    const p = docker();
    return {
      ...p,
      async dispose() {
        try {
          await cleanup();
        } finally {
          await p.dispose?.();
        }
      },
    };
  },
  name: "docker",
};
