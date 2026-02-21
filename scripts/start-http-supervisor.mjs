import { spawn } from "node:child_process";

const PORT = process.env.MCP_PORT || "9000";
const MAX_RESTARTS = Number(process.env.MCP_MAX_RESTARTS || "0");
const BASE_DELAY_MS = Number(process.env.MCP_RESTART_DELAY_MS || "1200");

let restartCount = 0;
let stopping = false;
let child = null;

function scheduleRestart() {
  if (MAX_RESTARTS > 0 && restartCount >= MAX_RESTARTS) {
    console.error(
      `[Supervisor] Max restarts reached (${MAX_RESTARTS}). Exiting.`,
    );
    process.exit(1);
  }

  restartCount += 1;
  const delay = Math.min(BASE_DELAY_MS * restartCount, 10000);
  console.error(
    `[Supervisor] Restarting server in ${delay}ms (attempt ${restartCount})...`,
  );

  setTimeout(() => {
    if (!stopping) {
      startChild();
    }
  }, delay);
}

function startChild() {
  const env = {
    ...process.env,
    MCP_TRANSPORT: "http",
    MCP_PORT: PORT,
  };

  console.error(`[Supervisor] Starting HTTP server on port ${PORT}...`);

  child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error("[Supervisor] Child process failed to start:", error);
    if (!stopping) {
      scheduleRestart();
    }
  });

  child.on("exit", (code, signal) => {
    if (stopping) {
      process.exit(0);
      return;
    }

    if (code === 0) {
      console.error("[Supervisor] Server exited cleanly.");
      process.exit(0);
      return;
    }

    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`[Supervisor] Server exited unexpectedly (${reason}).`);
    scheduleRestart();
  });
}

function stopSupervisor(signal) {
  if (stopping) {
    return;
  }

  stopping = true;
  console.error(`[Supervisor] Received ${signal}, shutting down...`);

  if (child && !child.killed) {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child && !child.killed) {
        child.kill("SIGKILL");
      }
    }, 3000);
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => stopSupervisor("SIGINT"));
process.on("SIGTERM", () => stopSupervisor("SIGTERM"));

startChild();
