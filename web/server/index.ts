process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { createRoutes } from "./routes.js";
import { CliLauncher } from "./cli-launcher.js";
import { WsBridge } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import type { SocketData } from "./ws-bridge.js";
import type { ServerWebSocket } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.__VIBE_PACKAGE_ROOT || resolve(__dirname, "..");

const port = Number(process.env.PORT) || 3456;
const sessionStore = new SessionStore();
const wsBridge = new WsBridge();
const launcher = new CliLauncher(port);

// ── Restore persisted sessions from disk ────────────────────────────────────
wsBridge.setStore(sessionStore);
launcher.setStore(sessionStore);
launcher.restoreFromDisk();
wsBridge.restoreFromDisk();
console.log(`[server] Session persistence: ${sessionStore.directory}`);

const app = new Hono();

app.use("/api/*", cors());
app.route("/api", createRoutes(launcher, wsBridge));

// In production, serve built frontend using absolute path (works when installed as npm package)
if (process.env.NODE_ENV === "production") {
  const distDir = resolve(packageRoot, "dist");
  app.use("/*", serveStatic({ root: distDir }));
  app.get("/*", serveStatic({ path: resolve(distDir, "index.html") }));
}

const server = Bun.serve<SocketData>({
  port,
  fetch(req, server) {
    const url = new URL(req.url);

    // ── CLI WebSocket — Claude Code CLI connects here via --sdk-url ────
    const cliMatch = url.pathname.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
    if (cliMatch) {
      const sessionId = cliMatch[1];
      
      // Validate session exists before accepting WebSocket
      const session = launcher.getSession(sessionId);
      if (!session) {
        console.warn(`[server] Rejected CLI connection for unknown session: ${sessionId}`);
        return new Response("Session not found", { status: 404 });
      }
      
      const upgraded = server.upgrade(req, {
        data: { kind: "cli" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // ── Browser WebSocket — connects to a specific session ─────────────
    const browserMatch = url.pathname.match(/^\/ws\/browser\/([a-f0-9-]+)$/);
    if (browserMatch) {
      const sessionId = browserMatch[1];
      
      // For browser connections, we allow connecting to sessions that might
      // not be registered yet in launcher (for restored sessions from disk)
      // but we validate the UUID format
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sessionId)) {
        console.warn(`[server] Rejected browser connection for invalid session ID: ${sessionId}`);
        return new Response("Invalid session ID format", { status: 400 });
      }
      
      const upgraded = server.upgrade(req, {
        data: { kind: "browser" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Hono handles the rest
    return app.fetch(req, server);
  },
  websocket: {
    open(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIOpen(ws, data.sessionId);
        launcher.markConnected(data.sessionId);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserOpen(ws, data.sessionId);
      }
    },
    message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIMessage(ws, msg);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserMessage(ws, msg);
      }
    },
    close(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIClose(ws);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserClose(ws);
      }
    },
  },
});

console.log(`Server running on http://localhost:${server.port}`);
console.log(`  CLI WebSocket:     ws://localhost:${server.port}/ws/cli/:sessionId`);
console.log(`  Browser WebSocket: ws://localhost:${server.port}/ws/browser/:sessionId`);

if (process.env.NODE_ENV !== "production") {
  console.log("Dev mode: frontend at http://localhost:5174");
}

// Graceful shutdown handling
function shutdown(signal: string) {
  console.log(`\n[server] Received ${signal}, shutting down gracefully...`);
  
  // Clean up debounce timers
  sessionStore.cleanup();
  
  // Close all WebSocket connections
  // Note: Bun's server.stop() will handle closing WebSocket connections
  
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
