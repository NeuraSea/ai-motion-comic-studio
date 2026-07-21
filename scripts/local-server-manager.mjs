#!/usr/bin/env node

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(process.env.MANJU_RUNTIME_DIR || resolve(rootDir, "runtime"));
const entryPath = resolve(process.env.MANJU_SERVER_ENTRY || resolve(rootDir, "dist-server/index.cjs"));
const port = Number.parseInt(process.env.MANJU_PORT || process.env.PORT || "5173", 10);
const healthPath = process.env.MANJU_HEALTH_PATH || "/api/health";
const statePath = resolve(runtimeDir, "server-process.json");
const legacyPidPath = resolve(runtimeDir, "server.pid");
const lockPath = resolve(runtimeDir, "server-manager.lock");
const logPath = resolve(runtimeDir, "server.log");
const jsonOutput = process.argv.includes("--json");

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readCommand(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function isManagedCommand(pid, expectedEntry = entryPath) {
  if (!isPidAlive(pid)) return false;
  const command = readCommand(pid);
  return command.length > 0 && command.includes(resolve(expectedEntry));
}

function readState() {
  if (!existsSync(statePath)) return null;
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8"));
    return value && Number.isInteger(value.pid) ? value : null;
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(runtimeDir, { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, statePath);
  writeFileSync(legacyPidPath, `${state.pid}\n`);
}

function clearState() {
  rmSync(statePath, { force: true });
  rmSync(legacyPidPath, { force: true });
}

async function probeHealth(timeoutMs = 1200) {
  return await new Promise((resolveProbe) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: healthPath, timeout: timeoutMs },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          let payload = null;
          try {
            payload = JSON.parse(body);
          } catch {
            // A 200 response without the expected JSON is not our health endpoint.
          }
          const serviceStatus = payload?.status;
          resolveProbe({
            healthy: response.statusCode === 200 && (serviceStatus === "ok" || serviceStatus === "degraded"),
            httpStatus: response.statusCode ?? null,
            serviceStatus: serviceStatus ?? null,
          });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("health timeout")));
    request.on("error", () => resolveProbe({ healthy: false, httpStatus: null, serviceStatus: null }));
  });
}

function acquireLock() {
  mkdirSync(runtimeDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      closeSync(fd);
      return () => rmSync(lockPath, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let ownerPid = null;
      try {
        ownerPid = JSON.parse(readFileSync(lockPath, "utf8")).pid;
      } catch {
        // Invalid lock files are treated as stale.
      }
      if (isPidAlive(ownerPid)) {
        throw new Error(`服务管理操作正在执行（PID ${ownerPid}）`);
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error("无法取得服务管理锁");
}

async function getStatus() {
  const state = readState();
  const health = await probeHealth();
  const processAlive = Boolean(state && isPidAlive(state.pid));
  const commandMatches = Boolean(state && processAlive && isManagedCommand(state.pid, state.entryPath || entryPath));
  return {
    healthy: health.healthy,
    serviceStatus: health.serviceStatus,
    httpStatus: health.httpStatus,
    managed: Boolean(state && processAlive && commandMatches),
    pid: state?.pid ?? null,
    processAlive,
    commandMatches,
    port,
    healthUrl: `http://127.0.0.1:${port}${healthPath}`,
    startedAt: state?.startedAt ?? null,
    logPath,
  };
}

async function waitForHealth(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeHealth();
    if (health.healthy) return health;
    if (!isPidAlive(pid)) throw new Error(`服务进程提前退出；请查看 ${logPath}`);
    await sleep(200);
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪；请查看 ${logPath}`);
}

async function startServer() {
  const releaseLock = acquireLock();
  try {
    const current = await getStatus();
    if (current.healthy) {
      return { ...current, action: current.managed ? "already-running" : "already-running-unmanaged" };
    }

    const staleState = readState();
    if (staleState?.pid && isPidAlive(staleState.pid)) {
      if (!isManagedCommand(staleState.pid, staleState.entryPath || entryPath)) {
        clearState();
        throw new Error(`状态文件中的 PID ${staleState.pid} 已被其他进程复用；未执行终止操作`);
      }
      process.kill(staleState.pid, "SIGTERM");
      for (let attempt = 0; attempt < 25 && isPidAlive(staleState.pid); attempt += 1) await sleep(100);
      if (isPidAlive(staleState.pid)) throw new Error(`旧服务 PID ${staleState.pid} 未能安全停止`);
    }
    clearState();

    if (!existsSync(entryPath)) {
      throw new Error(`服务构建不存在：${entryPath}；请先运行 npm run build`);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`无效端口：${port}`);

    mkdirSync(runtimeDir, { recursive: true });
    const logFd = openSync(logPath, "a");
    const child = spawn(process.execPath, [entryPath], {
      cwd: rootDir,
      detached: true,
      env: { ...process.env, SERVE_WEB: "1", PORT: String(port) },
      stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    child.unref();

    writeState({
      pid: child.pid,
      entryPath,
      rootDir,
      port,
      healthPath,
      startedAt: new Date().toISOString(),
    });

    try {
      await waitForHealth(child.pid);
    } catch (error) {
      if (!isPidAlive(child.pid)) clearState();
      throw error;
    }
    return { ...(await getStatus()), action: "started" };
  } finally {
    releaseLock();
  }
}

async function stopServer() {
  const releaseLock = acquireLock();
  try {
    const state = readState();
    if (!state) return { action: "not-managed", stopped: false, port };
    if (!isPidAlive(state.pid)) {
      clearState();
      return { action: "cleared-stale-state", stopped: false, pid: state.pid, port };
    }
    if (!isManagedCommand(state.pid, state.entryPath || entryPath)) {
      clearState();
      throw new Error(`PID ${state.pid} 的命令与本项目服务不匹配；已清理陈旧状态但未终止该进程`);
    }

    process.kill(state.pid, "SIGTERM");
    for (let attempt = 0; attempt < 50 && isPidAlive(state.pid); attempt += 1) await sleep(100);
    if (isPidAlive(state.pid)) {
      process.kill(state.pid, "SIGKILL");
      for (let attempt = 0; attempt < 20 && isPidAlive(state.pid); attempt += 1) await sleep(100);
    }
    if (isPidAlive(state.pid)) throw new Error(`无法停止服务 PID ${state.pid}`);
    clearState();
    return { action: "stopped", stopped: true, pid: state.pid, port };
  } finally {
    releaseLock();
  }
}

async function ensureServer() {
  const status = await getStatus();
  if (status.healthy) return { ...status, action: status.managed ? "already-running" : "already-running-unmanaged" };
  return await startServer();
}

function printResult(result) {
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.healthy) {
    const ownership = result.managed ? `受管 PID ${result.pid}` : "非受管进程";
    process.stdout.write(`漫剧服务可用：${result.healthUrl}（${ownership}，${result.action || "status"}）\n`);
  } else {
    process.stdout.write(`漫剧服务不可用：http://127.0.0.1:${port}${healthPath}\n`);
  }
}

export { ensureServer, getStatus, startServer, stopServer };

async function main() {
  const command = process.argv.slice(2).find((argument) => !argument.startsWith("--")) || "status";
  let result;
  if (command === "start") result = await startServer();
  else if (command === "ensure") result = await ensureServer();
  else if (command === "status") result = await getStatus();
  else if (command === "stop") result = await stopServer();
  else if (command === "restart") {
    await stopServer();
    result = await startServer();
    result.action = "restarted";
  } else {
    throw new Error("用法：local-server-manager.mjs <start|ensure|status|restart|stop> [--json]");
  }
  printResult(result);
  if (command === "status" && !result.healthy) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const result = { error: error instanceof Error ? error.message : String(error), port, logPath };
    if (jsonOutput) process.stderr.write(`${JSON.stringify(result)}\n`);
    else process.stderr.write(`服务管理失败：${result.error}\n`);
    process.exitCode = 1;
  });
}
