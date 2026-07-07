import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { failing } from "../testing/index.js";
import { createSandboxClient } from "./client.js";
import { SandboxError } from "./errors.js";

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
  const originalEnv = {
    DO_NOT_TRACK: process.env.DO_NOT_TRACK,
    SBOX_DISABLE_TELEMETRY: process.env.SBOX_DISABLE_TELEMETRY,
    SBOX_TELEMETRY: process.env.SBOX_TELEMETRY,
    SBOX_TELEMETRY_DISABLED: process.env.SBOX_TELEMETRY_DISABLED,
  };

  beforeEach(() => {
    process.env.SBOX_TELEMETRY = "1";
    delete process.env.DO_NOT_TRACK;
    delete process.env.SBOX_DISABLE_TELEMETRY;
    delete process.env.SBOX_TELEMETRY_DISABLED;
  });

  afterEach(() => {
    if (originalEnv.DO_NOT_TRACK === undefined) {
      delete process.env.DO_NOT_TRACK;
    } else {
      process.env.DO_NOT_TRACK = originalEnv.DO_NOT_TRACK;
    }
    if (originalEnv.SBOX_DISABLE_TELEMETRY === undefined) {
      delete process.env.SBOX_DISABLE_TELEMETRY;
    } else {
      process.env.SBOX_DISABLE_TELEMETRY = originalEnv.SBOX_DISABLE_TELEMETRY;
    }
    if (originalEnv.SBOX_TELEMETRY === undefined) {
      delete process.env.SBOX_TELEMETRY;
    } else {
      process.env.SBOX_TELEMETRY = originalEnv.SBOX_TELEMETRY;
    }
    if (originalEnv.SBOX_TELEMETRY_DISABLED === undefined) {
      delete process.env.SBOX_TELEMETRY_DISABLED;
    } else {
      process.env.SBOX_TELEMETRY_DISABLED = originalEnv.SBOX_TELEMETRY_DISABLED;
    }
  });

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

  it("does not send events when telemetry is disabled by environment", async () => {
    process.env.DO_NOT_TRACK = "1";
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

    await client.dispose();

    expect(bodies).toEqual([]);
  });

  it("captures failure outcomes without leaking provider error details", async () => {
    const bodies: unknown[] = [];
    const client = createSandboxClient({
      fetch: fakeFetch(bodies),
      provider: failing({
        error: new SandboxError("Provider", "secret failure detail", {
          provider: "failing",
        }),
      }),
      retry: { retries: 0 },
      telemetry: {
        distinctId: "anon-test",
        flushAt: 1,
        projectKey: "phc_test",
      },
    });

    await expect(client.create()).rejects.toThrow("secret failure detail");
    await client.dispose();

    const event = eventsFrom(bodies).find(
      (item) => item.event === "sbox_sdk_sandbox_create"
    );
    expect(event?.properties).toMatchObject({
      error_code: "Provider",
      ok: false,
      provider: "failing",
    });
    expect(JSON.stringify(bodies)).not.toContain("secret failure detail");
  });
});
