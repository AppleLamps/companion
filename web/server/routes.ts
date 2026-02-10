import { Hono } from "hono";
import { readdir } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";

export function createRoutes(launcher: CliLauncher, wsBridge: WsBridge) {
  const api = new Hono();

  // ─── SDK Sessions (--sdk-url) ─────────────────────────────────────

  api.post("/sessions/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      // Validate and sanitize inputs
      const validatedOptions: {
        model?: string;
        permissionMode?: string;
        cwd?: string;
        claudeBinary?: string;
        allowedTools?: string[];
        env?: Record<string, string>;
      } = {};
      
      // Validate model (if provided)
      if (body.model !== undefined) {
        if (typeof body.model !== "string" || body.model.length === 0 || body.model.length > 100) {
          return c.json({ error: "Invalid model parameter" }, 400);
        }
        validatedOptions.model = body.model;
      }
      
      // Validate permissionMode (if provided)
      if (body.permissionMode !== undefined) {
        const validModes = ["bypass-all", "accept-edits", "plan-only", "default"];
        if (typeof body.permissionMode !== "string" || !validModes.includes(body.permissionMode)) {
          return c.json({ error: "Invalid permissionMode parameter" }, 400);
        }
        validatedOptions.permissionMode = body.permissionMode;
      }
      
      // Validate cwd (if provided)
      if (body.cwd !== undefined) {
        if (typeof body.cwd !== "string" || body.cwd.length === 0) {
          return c.json({ error: "Invalid cwd parameter" }, 400);
        }
        // Security: Ensure cwd is within home directory
        const resolvedCwd = resolve(body.cwd);
        const allowedBase = homedir();
        if (!resolvedCwd.startsWith(allowedBase + sep) && resolvedCwd !== allowedBase) {
          return c.json({ error: "cwd must be within home directory" }, 403);
        }
        validatedOptions.cwd = resolvedCwd;
      }
      
      // Validate claudeBinary (if provided)
      if (body.claudeBinary !== undefined) {
        if (typeof body.claudeBinary !== "string" || !/^[a-zA-Z0-9_\-\/\.]+$/.test(body.claudeBinary)) {
          return c.json({ error: "Invalid claudeBinary parameter" }, 400);
        }
        validatedOptions.claudeBinary = body.claudeBinary;
      }
      
      // Validate allowedTools (if provided)
      if (body.allowedTools !== undefined) {
        if (!Array.isArray(body.allowedTools)) {
          return c.json({ error: "allowedTools must be an array" }, 400);
        }
        if (!body.allowedTools.every((t: unknown) => typeof t === "string" && t.length > 0 && t.length < 100)) {
          return c.json({ error: "Invalid allowedTools array" }, 400);
        }
        validatedOptions.allowedTools = body.allowedTools;
      }
      
      // Validate env (if provided) - whitelist specific environment variables
      if (body.env !== undefined) {
        if (typeof body.env !== "object" || body.env === null || Array.isArray(body.env)) {
          return c.json({ error: "env must be an object" }, 400);
        }
        // Only allow specific safe environment variables
        const allowedEnvVars = ["LANG", "LC_ALL", "TZ"];
        const validatedEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(body.env)) {
          if (!allowedEnvVars.includes(key)) {
            return c.json({ error: `Environment variable ${key} is not allowed` }, 400);
          }
          if (typeof value !== "string") {
            return c.json({ error: `Environment variable ${key} must be a string` }, 400);
          }
          validatedEnv[key] = value;
        }
        validatedOptions.env = validatedEnv;
      }
      
      const session = launcher.launch(validatedOptions);
      return c.json(session);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[routes] Failed to create session:", msg);
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/sessions", (c) => {
    return c.json(launcher.listSessions());
  });

  api.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  api.post("/sessions/:id/kill", async (c) => {
    const id = c.req.param("id");
    const killed = await launcher.kill(id);
    if (!killed) return c.json({ error: "Session not found or already exited" }, 404);
    return c.json({ ok: true });
  });

  api.delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    await launcher.kill(id);
    launcher.removeSession(id);
    wsBridge.closeSession(id);
    return c.json({ ok: true });
  });

  // ─── Filesystem browsing ─────────────────────────────────────

  api.get("/fs/list", async (c) => {
    const rawPath = c.req.query("path") || homedir();
    const basePath = resolve(rawPath);
    
    try {
      // Security: Validate the path is within safe boundaries
      // Resolve to real path to prevent symlink attacks
      const realPath = await realpath(basePath).catch(() => basePath);
      
      // Only allow access to user's home directory and subdirectories
      const allowedBase = homedir();
      if (!realPath.startsWith(allowedBase + sep) && realPath !== allowedBase) {
        return c.json({ 
          error: "Access denied: Path must be within home directory", 
          path: basePath, 
          dirs: [], 
          home: homedir() 
        }, 403);
      }
      
      const entries = await readdir(realPath, { withFileTypes: true });
      const dirs: { name: string; path: string }[] = [];
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          dirs.push({ name: entry.name, path: join(realPath, entry.name) });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      return c.json({ path: realPath, dirs, home: homedir() });
    } catch (err) {
      console.error("[routes] fs/list error:", err);
      return c.json({ error: "Cannot read directory", path: basePath, dirs: [], home: homedir() }, 400);
    }
  });

  api.get("/fs/home", (c) => {
    return c.json({ home: homedir(), cwd: process.cwd() });
  });

  return api;
}
