import { describe, expect, it } from "vitest";

import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../internal/client.js";
import { SandboxError } from "../internal/errors.js";
import type { SandboxProvider } from "../internal/types.js";
import { memory } from "../memory/index.js";
import { failing } from "../testing/index.js";
import { memoryStatsStore, routeOf, router } from "./index.js";
import type { RouteEvent, RouteStatsStore } from "./index.js";

/** A memory-capable provider whose create() always throws `err`. */
function broken(name: string, err: SandboxError): SandboxProvider {
  return {
    ...memory(),
    create() {
      throw err;
    },
    name,
  };
}

describe("router: conformance", () => {
  it("passes the shared suite when routing to memory providers", async () => {
    const report = await runConformance(
      router({
        candidates: [
          { name: "a", provider: memory({ idPrefix: "a" }) },
          { name: "b", provider: memory({ bareFs: true, idPrefix: "b" }) },
        ],
      }),
      { live: true }
    );
    const failed = report.checks.filter((c) => !c.ok);
    expect(JSON.stringify(failed, null, 2)).toBe("[]");
  });
});

describe("router: capabilities", () => {
  it("drops candidates that lack a required capability", () => {
    const r = router({
      candidates: [failing({ name: "weak" }), memory()],
      requires: ["snapshot"],
    });
    expect(r.routes).toEqual(["memory"]);
    expect(r.capabilities.snapshot).toBe("native");
  });

  it("promises only what every route shares", () => {
    const r = router({
      candidates: [memory(), failing({ name: "weak" })],
    });
    expect(r.capabilities.pause).toBe("unsupported");
    expect(r.capabilities.templateBuild).toBe("unsupported");
  });

  it("rejects an unsatisfiable requirement up front", () => {
    expect(() =>
      router({ candidates: [failing()], requires: ["gpu"] })
    ).toThrow(/no candidate provides/);
  });

  it("rejects duplicate route names", () => {
    expect(() => router({ candidates: [memory(), memory()] })).toThrow(
      /duplicate route/
    );
  });
});

describe("router: routing", () => {
  it("prefixes ids with the route and connects back by id", async () => {
    const client = createSandboxClient({
      provider: router({
        candidates: [{ name: "local", provider: memory() }],
      }),
      telemetry: false,
    });
    const sb = await client.create();
    expect(routeOf(sb)?.route).toBe("local");
    await sb.files.write("/tmp/x.txt", "hi");
    const again = await client.connect(sb.id);
    expect(await (await again.files.read("/tmp/x.txt")).text()).toBe("hi");
    await sb.destroy();
  });

  it("cheapest picks the lowest costPerHour", async () => {
    const events: RouteEvent[] = [];
    const client = createSandboxClient({
      provider: router({
        candidates: [
          { costPerHour: 0.2, name: "pricey", provider: memory() },
          { costPerHour: 0.05, name: "cheap", provider: memory() },
        ],
        onRoute: (e) => events.push(e),
        strategy: "cheapest",
      }),
      telemetry: false,
    });
    const sb = await client.create();
    expect(routeOf(sb)?.route).toBe("cheap");
    expect(events[0]).toEqual({ order: ["cheap", "pricey"], type: "selected" });
  });

  it("round-robin rotates across routes", async () => {
    const client = createSandboxClient({
      provider: router({
        candidates: [
          { name: "a", provider: memory() },
          { name: "b", provider: memory() },
        ],
        strategy: "round-robin",
      }),
      telemetry: false,
    });
    const routes = [];
    for (let i = 0; i < 4; i++) {
      routes.push(routeOf(await client.create())?.route);
    }
    expect(routes).toEqual(["a", "b", "a", "b"]);
  });

  it("filters by region and applies the route's template", async () => {
    const seen: (string | undefined)[] = [];
    const eu = memory();
    const spy: SandboxProvider = {
      ...eu,
      create(spec, ctx) {
        seen.push(spec.template);
        return eu.create({ ...spec, template: undefined }, ctx);
      },
    };
    const client = createSandboxClient({
      provider: router({
        candidates: [
          { name: "us", provider: memory(), regions: ["us-east"] },
          {
            name: "eu",
            provider: spy,
            regions: ["eu-west"],
            template: "eu-base",
          },
        ],
      }),
      telemetry: false,
    });
    const sb = await client.create({ region: "eu-west" });
    expect(routeOf(sb)?.route).toBe("eu");
    expect(seen).toEqual(["eu-base"]);
  });

  it("custom strategy functions decide the order", async () => {
    const client = createSandboxClient({
      provider: router({
        candidates: [
          { name: "a", provider: memory() },
          { name: "b", provider: memory() },
        ],
        strategy: (routes) => routes.toReversed(),
      }),
      telemetry: false,
    });
    expect(routeOf(await client.create())?.route).toBe("b");
  });
});

describe("router: stats store", () => {
  it("shares health across router instances through the store", async () => {
    const backing = memoryStatsStore();
    const saves: string[] = [];
    const store: RouteStatsStore = {
      load: (names) => backing.load(names),
      save: (name, stat) => {
        saves.push(name);
        return backing.save(name, stat);
      },
    };
    const orders: string[][] = [];
    const make = () =>
      router({
        candidates: [
          broken("down", new SandboxError("QuotaExceeded", "no")),
          { name: "ok", provider: memory() },
        ],
        onRoute: (e) => {
          if (e.type === "selected") {
            orders.push(e.order);
          }
        },
        statsStore: store,
        unhealthyAfter: 1,
      });
    // Instance 1 (think: one serverless invocation) records the failure...
    await createSandboxClient({ provider: make(), telemetry: false }).create();
    expect(saves).toEqual(["down", "ok"]);
    // ...and a fresh instance routes around it immediately.
    await createSandboxClient({ provider: make(), telemetry: false }).create();
    expect(orders[1]).toEqual(["ok", "down"]);
  });

  it("a failing store never breaks a create", async () => {
    const r = router({
      candidates: [{ name: "ok", provider: memory() }],
      statsStore: {
        load: () => ({}),
        save: () => {
          throw new Error("redis down");
        },
      },
    });
    const sb = await createSandboxClient({
      provider: r,
      telemetry: false,
    }).create();
    expect(routeOf(sb)?.route).toBe("ok");
  });
});

describe("router: snapshots", () => {
  it("booting from a snapshot pins the route that holds it", async () => {
    const client = createSandboxClient({
      provider: router({
        candidates: [
          { name: "a", provider: memory({ idPrefix: "a" }) },
          { name: "b", provider: memory({ idPrefix: "b" }) },
        ],
        strategy: "round-robin",
      }),
      telemetry: false,
    });
    await client.create(); // lands on "a"; next would be "b"
    const src = await client.create();
    expect(routeOf(src)?.route).toBe("b");
    await src.files.write("/tmp/s.txt", "snap");
    const ref = await src.snapshots!.create();
    expect(routeOf(ref.id)?.route).toBe("b");
    const restored = await client.create({ fromSnapshot: ref });
    expect(routeOf(restored)?.route).toBe("b");
    expect(await (await restored.files.read("/tmp/s.txt")).text()).toBe("snap");
  });
});

describe("router: failover", () => {
  it("fails over on errors that prove no VM was created", async () => {
    const client = createSandboxClient({
      provider: router({
        candidates: [
          broken("nokey", new SandboxError("Unauthorized", "bad key")),
          { name: "ok", provider: memory() },
        ],
      }),
      telemetry: false,
    });
    expect(routeOf(await client.create())?.route).toBe("ok");
  });

  it("does NOT fail over on ambiguous errors without an idempotency key", async () => {
    const client = createSandboxClient({
      provider: router({
        candidates: [
          broken(
            "flaky",
            new SandboxError("Timeout", "slow", { retryable: false })
          ),
          { name: "ok", provider: memory() },
        ],
      }),
      retry: { retries: 0 },
      telemetry: false,
    });
    await expect(client.create()).rejects.toMatchObject({ code: "Timeout" });
  });

  it("fails over on ambiguous errors when an idempotency key is given", async () => {
    const client = createSandboxClient({
      provider: router({
        candidates: [
          broken(
            "flaky",
            new SandboxError("Timeout", "slow", { retryable: false })
          ),
          { name: "ok", provider: memory() },
        ],
      }),
      telemetry: false,
    });
    const sb = await client.create({ idempotencyKey: "job-1" });
    expect(routeOf(sb)?.route).toBe("ok");
  });

  it("demotes a route after repeated failures", async () => {
    const orders: string[][] = [];
    const r = router({
      candidates: [
        broken("down", new SandboxError("QuotaExceeded", "out of credit")),
        { name: "ok", provider: memory() },
      ],
      onRoute: (e) => {
        if (e.type === "selected") {
          orders.push(e.order);
        }
      },
      unhealthyAfter: 2,
    });
    const client = createSandboxClient({ provider: r, telemetry: false });
    await client.create();
    await client.create();
    expect((await r.stats()).find((s) => s.name === "down")?.unhealthy).toBe(
      true
    );
    await client.create();
    expect(orders).toEqual([
      ["down", "ok"],
      ["down", "ok"],
      ["ok", "down"],
    ]);
  });

  it("reports every attempt when all routes fail", async () => {
    const client = createSandboxClient({
      provider: router({
        candidates: [
          broken("x", new SandboxError("Unauthorized", "no")),
          broken("y", new SandboxError("QuotaExceeded", "no")),
        ],
      }),
      telemetry: false,
    });
    await expect(client.create()).rejects.toMatchObject({
      code: "AllProvidersFailed",
    });
  });
});
