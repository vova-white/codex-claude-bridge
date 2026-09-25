import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BridgeFixture, isAlive, waitFor } from "../support/bridge.ts";

let fixture: BridgeFixture;

afterEach(async () => {
  await fixture.cleanup();
});

async function servicePidFrom(client: Awaited<ReturnType<BridgeFixture["connect"]>>) {
  const result = await client.call("readiness");
  expect(result.isError).toBe(false);
  return result.data.service.pid as number;
}

describe("background service", () => {
  it("attaches concurrently starting clients to one service per state store", async () => {
    fixture = new BridgeFixture();
    const clients = await Promise.all([fixture.connect(), fixture.connect(), fixture.connect()]);
    const pids = await Promise.all(clients.map(servicePidFrom));

    expect(new Set(pids).size).toBe(1);
    expect(pids[0]).not.toBe(process.pid);
    expect(fixture.servicePid()).toBe(pids[0]);
  });

  it("starts while a concurrently starting service briefly reads the state store", async () => {
    fixture = new BridgeFixture();
    const database = join(fixture.stateDir, "state.db");
    // Another process holds the read lock a losing service takes for a moment before it gives up.
    const contender = spawn(
      process.execPath,
      [
        "-e",
        `const db = new (require("node:sqlite").DatabaseSync)(process.argv[1], { timeout: 0 });
         db.exec("BEGIN; SELECT count(*) FROM sqlite_master;");
         process.stdout.write("held");
         process.stdin.on("data", () => {}).on("end", () => db.exec("COMMIT"));`,
        database,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const exited = new Promise((resolve) => contender.once("exit", resolve));
    let probe: DatabaseSync | undefined;
    try {
      await new Promise((resolve) => contender.stdout.once("data", resolve));
      const client = await fixture.connect();
      // New readers are refused once the starting service has claimed the lock and waits for the contender.
      probe = new DatabaseSync(database, { timeout: 0 });
      const reader = probe;
      await waitFor(() => {
        try {
          reader.exec("BEGIN; SELECT count(*) FROM sqlite_master; COMMIT;");
          return undefined;
        } catch {
          return true;
        }
      });
      probe.close();
      probe = undefined;
      contender.stdin.end();
      await exited;

      expect(await servicePidFrom(client)).toBe(fixture.servicePid());
    } finally {
      // A failed step must not leave the contender, whose PID this test captured, waiting on stdin.
      probe?.close();
      if (contender.exitCode === null && contender.signalCode === null) contender.kill("SIGKILL");
    }
  });

  it("keeps running after the MCP client exits and serves the next client", async () => {
    fixture = new BridgeFixture();
    const first = await fixture.connect();
    const pid = await servicePidFrom(first);
    await first.close();

    expect(isAlive(pid)).toBe(true);
    const second = await fixture.connect();
    expect(await servicePidFrom(second)).toBe(pid);
  });

  it("replaces a service that died without cleaning up", async () => {
    fixture = new BridgeFixture();
    const pid = await servicePidFrom(await fixture.connect());
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid) || undefined);

    const replacement = await servicePidFrom(await fixture.connect());
    expect(replacement).not.toBe(pid);
  });

  it("rejects local callers that cannot read the service token", async () => {
    fixture = new BridgeFixture();
    await servicePidFrom(await fixture.connect());
    const socketPath = join(fixture.stateDir, "service.sock");

    expect(statSync(fixture.stateDir).mode & 0o077).toBe(0);
    expect(statSync(join(fixture.stateDir, "service.token")).mode & 0o077).toBe(0);

    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let received = "";
      socket.on("data", (chunk) => (received += chunk.toString()));
      socket.on("close", () => resolve(received));
      socket.on("error", reject);
      socket.write(
        `${JSON.stringify({ id: 1, method: "hello", params: { token: "guess", protocol: 2, caller: "codex" } })}\n`,
      );
      socket.write(`${JSON.stringify({ id: 2, method: "readiness", params: {} })}\n`);
    });

    expect(reply).toContain("unauthorized");
    expect(reply).not.toContain("credentials");
  });
});
