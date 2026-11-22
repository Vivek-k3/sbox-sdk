/**
 * Docker-specific live checks beyond the shared conformance suite. Runs only
 * with `SBOX_LIVE=docker` (or `SBOX_LIVE` containing it) and a reachable
 * daemon. Everything it creates is labelled `sbox-docker-live` and removed.
 */
import { afterAll, describe, expect, it } from "vitest";

import { createSandboxClient } from "../index.js";
import type { Sandbox } from "../index.js";
import { docker } from "./index.js";
import { live } from "./live.js";

const ENABLED = (process.env.SBOX_LIVE ?? "").split(",").includes("docker");
const RUN = `${Date.now().toString(36)}`;
const meta = { "sbox-docker-live": RUN };

describe.runIf(ENABLED)("docker live extras", async () => {
  const available = ENABLED && (await live.available!());
  const provider = docker();
  const client = createSandboxClient({ provider, telemetry: false });
  const cleanup: (() => Promise<unknown>)[] = [];
  const track = <T extends Sandbox>(s: T): T => {
    cleanup.push(() => s.destroy());
    return s;
  };

  afterAll(async () => {
    for (const fn of cleanup.toReversed()) {
      await fn().catch(() => {});
    }
    // Belt and braces: anything still labelled from this run.
    for await (const info of client.list({ metadata: meta })) {
      await (await client.connect(info.id)).destroy().catch(() => {});
    }
    await client.dispose();
  });

  it.runIf(available)("verify reports the engine", async () => {
    const v = await client.verify();
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.account).toMatch(/Engine|Docker|Podman/);
    }
  });

  it.runIf(available)(
    "desktop-style template: startCmd, readyCmd, shm, env, ports",
    async () => {
      const tpl = await client.templates!.build({
        name: `sbox-live-desktop-${RUN}`,
        readyCmd: "test -f /tmp/ready",
        resources: { shmMB: 256 },
        source: {
          context: { "server.sh": "touch /tmp/ready\nexec sleep infinity\n" },
          dockerfile:
            "FROM debian:bookworm-slim\nCOPY server.sh /opt/server.sh\n",
        },
        startCmd: "sh /opt/server.sh",
        env: { DISPLAY: ":1", GREETING: 'a $b "c"' },
      });
      cleanup.push(() => client.templates!.delete(tpl));
      const sb = track(
        await client.create({
          metadata: meta,
          ports: [6080, 7000],
          template: tpl,
        })
      );
      const shm = await sb.commands.run("df -m /dev/shm | tail -1");
      expect(shm.stdout).toMatch(/\s256\s/);
      const env = await sb.commands.run('echo "$DISPLAY|$GREETING"');
      expect(env.stdout.trim()).toBe(':1|a $b "c"');
      const ports = await sb.ports!.list();
      expect(ports.map((p) => p.port).toSorted()).toEqual([6080, 7000]);
      const p = await sb.ports!.expose(7000);
      expect(p.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(p.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
      await expect(sb.ports!.expose(9999)).rejects.toMatchObject({
        code: "Validation",
      });
    }
  );

  it.runIf(available)(
    "egress: block-all at create, then allow-all",
    async () => {
      const sb = track(
        await client.create({ metadata: meta, network: { mode: "block-all" } })
      );
      const ifaces = async () =>
        (await sb.commands.run("cat /proc/net/dev")).stdout.includes("eth0");
      expect(await ifaces()).toBe(false);
      await sb.network!.setEgressPolicy({ mode: "allow-all" });
      expect(await ifaces()).toBe(true);
      await sb.network!.setEgressPolicy({ mode: "block-all" });
      expect(await ifaces()).toBe(false);
      await expect(
        sb.network!.setEgressPolicy({ domains: ["x.com"], mode: "allow-list" })
      ).rejects.toMatchObject({ code: "Validation" });
    }
  );

  it.runIf(available)(
    "declared ports are published once the network is enabled",
    async () => {
      const sb = track(
        await client.create({
          metadata: meta,
          network: { mode: "block-all" },
          ports: [8080],
        })
      );
      expect(await sb.ports!.list()).toEqual([]);
      await expect(sb.ports!.expose(8080)).rejects.toMatchObject({
        code: "Conflict",
      });
      await sb.network!.setEgressPolicy({ mode: "allow-all" });
      expect((await sb.ports!.expose(8080)).url).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+$/
      );
    }
  );

  it.runIf(available)("proxied fetch to a published port", async () => {
    const sb = track(await client.create({ metadata: meta, ports: [8000] }));
    // python isn't in bookworm-slim; serve with perl, which is.
    await sb.files.write(
      "/tmp/srv.pl",
      'use IO::Socket::INET; my $s = IO::Socket::INET->new(LocalPort=>8000, Listen=>5, ReuseAddr=>1) or die; while (my $c = $s->accept) { my $l = <$c>; print $c "HTTP/1.1 200 OK\\r\\nContent-Length: 5\\r\\nConnection: close\\r\\n\\r\\nhello"; close $c; }'
    );
    await sb.commands.spawn("perl /tmp/srv.pl");
    let body = "";
    for (let i = 0; i < 40 && body !== "hello"; i++) {
      try {
        body = await (await sb.ports!.fetch(8000, "/")).text();
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    expect(body).toBe("hello");
  });

  it.runIf(available)("interactive stdin with EOF", async () => {
    const sb = track(await client.create({ metadata: meta }));
    const h = sb.commands.run("cat | tr a-z A-Z");
    await h.writeStdin("hello ");
    await h.writeStdin("world");
    await h.writeStdin(new Uint8Array()); // EOF
    const r = await h;
    expect(r.stdout).toBe("HELLO WORLD");
    // A command that reads stdin without any input sees EOF, not a hang.
    const r2 = await sb.commands.run("cat; echo done", { timeoutMs: 5000 });
    expect(r2.stdout.trim()).toBe("done");
    // spawn keeps stdin open for later writes.
    const p = await sb.commands.spawn("head -n1");
    await p.writeStdin("line one\nline two\n");
    expect((await p.wait()).stdout).toBe("line one\n");
  });

  it.runIf(available)(
    "snapshots: list, boot from, delete; stop/start keeps disk",
    async () => {
      const sb = track(await client.create({ metadata: meta }));
      await sb.files.write("/root/state.txt", "v1");
      const snap = await sb.snapshots!.create({ name: `live-${RUN}` });
      expect(snap.includesMemory).toBe(false);
      expect(snap.id).toContain(`sbox-snapshot/`);
      const listed = await sb.snapshots!.list();
      expect(listed.map((s) => s.id)).toContain(snap.id);
      const child = track(
        await client.create({ fromSnapshot: snap, metadata: meta })
      );
      expect(await (await child.files.read("/root/state.txt")).text()).toBe(
        "v1"
      );
      await child.destroy();
      await sb.snapshots!.delete(snap);
      expect(await sb.snapshots!.list()).toEqual([]);

      await sb.stop();
      expect((await sb.getInfo()).state).toBe("stopped");
      await sb.resume();
      expect((await sb.getInfo()).state).toBe("running");
      expect(await (await sb.files.read("/root/state.txt")).text()).toBe("v1");

      let stopped = 0;
      for await (const _ of client.list({ metadata: meta, state: "stopped" })) {
        stopped++;
      }
      expect(stopped).toBe(0);
    }
  );

  it.runIf(available)(
    "idempotency key returns the same container",
    async () => {
      const key = `live-idem-${RUN}`;
      const a = track(
        await client.create({ idempotencyKey: key, metadata: meta })
      );
      const b = await client.create({ idempotencyKey: key, metadata: meta });
      expect(b.id).toBe(a.id);
    }
  );

  it.runIf(available)("setTimeout stops the container", async () => {
    const sb = track(await client.create({ metadata: meta }));
    await sb.setTimeout(1000);
    let state = "running";
    for (let i = 0; i < 40 && state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      state = (await sb.getInfo()).state;
    }
    expect(state).toBe("stopped");
  });

  it.runIf(available)("volumes: create, mount, share, delete", async () => {
    const name = `sbox-live-vol-${RUN}`;
    const vol = await client.volumes!.create({ name });
    cleanup.push(() => client.volumes!.delete(vol));
    expect((await client.volumes!.get(name))?.id).toBe(name);
    const a = track(
      await client.create({
        metadata: meta,
        volumes: [{ id: name, mountPath: "/data" }],
      })
    );
    await a.files.write("/data/shared.txt", "from-a");
    const b = track(
      await client.create({
        metadata: meta,
        volumes: [{ id: name, mountPath: "/data", readOnly: true }],
      })
    );
    expect(await (await b.files.read("/data/shared.txt")).text()).toBe(
      "from-a"
    );
    const ro = await b.commands.run("touch /data/x");
    expect(ro.exitCode).not.toBe(0);
    const names: string[] = [];
    for await (const v of client.volumes!.list()) {
      names.push(v.id);
    }
    expect(names).toContain(name);
    await a.destroy();
    await b.destroy();
  });

  it.runIf(available)("pty resize is visible to the program", async () => {
    const sb = track(await client.create({ metadata: meta }));
    const t = await sb.pty!.create({ cmd: "sh", cols: 90, rows: 20 });
    let out = "";
    const reader = (async () => {
      for await (const c of t) {
        out += new TextDecoder().decode(c);
      }
    })();
    await t.resize(132, 43);
    await new Promise((r) => setTimeout(r, 100));
    await t.write("stty size; exit 0\n");
    expect((await t.wait()).exitCode).toBe(0);
    await reader;
    expect(out).toContain("43 132");
    expect(out).not.toContain("SBOXPID");
  });

  it.runIf(available)("metrics report cpu and memory", async () => {
    const sb = track(
      await client.create({ metadata: meta, resources: { memoryMB: 256 } })
    );
    const m = await sb.metrics();
    expect(m.memoryTotalMB).toBeCloseTo(256, 0);
    expect(typeof m.cpuPercent).toBe("number");
  });
});
