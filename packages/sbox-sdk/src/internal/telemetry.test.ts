import { describe, expect, it } from "vitest";

import { createSandboxClient } from "./client.js";

function fakeFetch(bodies: unknown[]): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      bodies.push(JSON.parse(init.body));
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

function eventsFrom(bodies: unknown[]): Array<{
  event: string;
  properties: Record<string, unknown>;
}> {
  return bodies.flatMap((body) => {
    const batch = (body as { batch?: unknown[] }).batch ?? [];
    return batch as Array<{
      event: string;
      properties: Record<string, unknown>;
    }>;
  });
}

describe("telemetry", () => {
  it("captures anonymous lifecycle and command events when enabled", async () => {
    const bodies: unknown[] = [];
    const client = createSandboxClient({
      fetch: fakeFetch(bodies),
      telemetry: {
        distinctId: "anon-test",
        enabled: true,
        flushAt: 1,
        projectKey: "phc_test",
      },
    });

    const sandbox = await client.create();
    await sandbox.commands.run("echo do-not-send-this");
    await sandbox.destroy();
    await client.dispose();

    const events = eventsFrom(bodies);
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "sbox_sdk_client_initialized",
        "sbox_sdk_sandbox_create",
        "sbox_sdk_command_run",
        "sbox_sdk_sandbox_destroy",
        "sbox_sdk_client_dispose",
      ])
    );

    const serialized = JSON.stringify(bodies);
    expect(serialized).not.toContain("do-not-send-this");
    expect(serialized).not.toContain(sandbox.id);
    expect(
      events.every(
        (event) => event.properties.$process_person_profile === false
      )
    ).toBe(true);
  });

  it("captures by default with the bundled project key", async () => {
    const bodies: unknown[] = [];
    const client = createSandboxClient({
      fetch: fakeFetch(bodies),
      telemetry: {
        distinctId: "anon-test",
        flushAt: 1,
      },
    });

    await client.dispose();

    expect((bodies[0] as { api_key?: string }).api_key).toMatch(/^phc_/);
    expect(eventsFrom(bodies).map((event) => event.event)).toContain(
      "sbox_sdk_client_initialized"
    );
  });

  it("does not send events when telemetry is disabled", async () => {
    const bodies: unknown[] = [];
    const client = createSandboxClient({
      fetch: fakeFetch(bodies),
      telemetry: false,
    });

    const sandbox = await client.create();
    await sandbox.commands.run("echo hi");
    await sandbox.destroy();
    await client.dispose();

    expect(bodies).toEqual([]);
  });
});
