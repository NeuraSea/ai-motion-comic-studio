import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const managerPath = resolve("scripts/local-server-manager.mjs");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function run(command, env, allowFailure = false) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [managerPath, command, "--json"], { env });
    return { code: 0, value: JSON.parse(stdout.trim()) };
  } catch (error) {
    if (!allowFailure) throw error;
    const output = String(error.stdout || error.stderr || "").trim();
    return { code: error.code, value: output ? JSON.parse(output) : null };
  }
}

test("detached server start, status, ensure and stop are idempotent", async () => {
  const directory = await mkdtemp(resolve(os.tmpdir(), "manju-server-manager-"));
  const entry = resolve(directory, "fake-server.mjs");
  const port = await freePort();
  const env = {
    ...process.env,
    MANJU_RUNTIME_DIR: directory,
    MANJU_SERVER_ENTRY: entry,
    MANJU_PORT: String(port),
  };
  await writeFile(
    entry,
    `import http from "node:http";\nconst server=http.createServer((req,res)=>{if(req.url==="/api/health"){res.setHeader("content-type","application/json");res.end(JSON.stringify({status:"ok"}));return;}res.statusCode=404;res.end();});\nserver.listen(Number(process.env.PORT),"127.0.0.1");\nprocess.on("SIGTERM",()=>server.close(()=>process.exit(0)));\n`,
  );

  try {
    const started = await run("start", env);
    assert.equal(started.value.action, "started");
    assert.equal(started.value.healthy, true);
    assert.equal(started.value.managed, true);
    assert.ok(started.value.pid > 0);

    const status = await run("status", env);
    assert.equal(status.value.pid, started.value.pid);
    assert.equal(status.value.healthy, true);
    assert.equal(status.value.managed, true);

    const ensured = await run("ensure", env);
    assert.equal(ensured.value.action, "already-running");
    assert.equal(ensured.value.pid, started.value.pid);

    process.kill(started.value.pid, "SIGTERM");
    const recovered = await run("ensure", env);
    assert.equal(recovered.value.action, "started");
    assert.equal(recovered.value.healthy, true);
    assert.equal(recovered.value.managed, true);
    assert.notEqual(recovered.value.pid, started.value.pid);

    const stopped = await run("stop", env);
    assert.equal(stopped.value.action, "stopped");
    assert.equal(stopped.value.stopped, true);

    const unavailable = await run("status", env, true);
    assert.equal(unavailable.code, 1);
    assert.equal(unavailable.value.healthy, false);
  } finally {
    await run("stop", env, true);
    await rm(directory, { recursive: true, force: true });
  }
});
