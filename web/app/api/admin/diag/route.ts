import type { NextRequest } from "next/server";
import { spawn } from "node:child_process";
import { getSessionUserId } from "@/lib/auth";
import { getUserById } from "@/lib/users";

export const runtime = "nodejs";

/**
 * Owner-only diagnostic. Returns:
 *   - presence + length of every env var the analyze pipeline depends on
 *     (length only, never the value itself — safe to share in screenshots)
 *   - smoke test of the Claude Code CLI binary (`--version`)
 *   - basic process info (uid, cwd, HOME, Node version)
 *
 * Hit it in a browser while signed in as the OWNER_EMAIL user:
 *   GET /api/admin/diag
 */

const ENV_VARS_TO_CHECK = [
  "ANTHROPIC_API_KEY",
  "OWNER_SESSION_SECRET",
  "OWNER_EMAIL",
  "APP_URL",
  "IS_SANDBOX",
  "CLAUDE_CODE_EXECUTABLE",
  "HOME",
  "DB_PATH",
  "SAVED_ANALYSES_DIR",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "ANALYZE_MODEL",
] as const;

function envPresence(name: string): { present: boolean; length: number; sample: string | null } {
  const v = process.env[name];
  if (!v) return { present: false, length: 0, sample: null };
  // Show a tiny prefix-only sample for keys so the user can sanity-check
  // without exposing the secret. Only safe-to-display vars get a sample.
  const SAFE_TO_PEEK = new Set(["OWNER_EMAIL", "APP_URL", "IS_SANDBOX", "CLAUDE_CODE_EXECUTABLE", "HOME", "DB_PATH", "SAVED_ANALYSES_DIR", "EMAIL_FROM", "ANALYZE_MODEL"]);
  return {
    present: true,
    length: v.length,
    sample: SAFE_TO_PEEK.has(name) ? v : null,
  };
}

async function spawnCheck(cmd: string, args: string[], timeoutMs = 5000): Promise<{
  ok: boolean; exitCode: number | null; stdout: string; stderr: string; error: string | null;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: Parameters<typeof resolve>[0]) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(cmd, args, { timeout: timeoutMs });
    } catch (e) {
      finish({ ok: false, exitCode: null, stdout: "", stderr: "", error: e instanceof Error ? e.message : String(e) });
      return;
    }
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => {
      finish({ ok: false, exitCode: null, stdout, stderr, error: e.message });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, exitCode: code, stdout: stdout.trim(), stderr: stderr.trim(), error: null });
    });
  });
}

export async function GET(req: NextRequest) {
  // Owner gate: only the OWNER_EMAIL user can read diag.
  const userId = getSessionUserId(req);
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const user = getUserById(userId);
  if (!user) return new Response("Unauthorized", { status: 401 });
  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!ownerEmail || user.email !== ownerEmail) {
    return new Response("Forbidden", { status: 403 });
  }

  const env: Record<string, ReturnType<typeof envPresence>> = {};
  for (const name of ENV_VARS_TO_CHECK) env[name] = envPresence(name);

  // CLI smoke test — `--version` doesn't trigger the
  // --dangerously-skip-permissions root check, so it isolates "is the
  // binary present and runnable" from "is the sandbox flag set".
  const cliPath = process.env.CLAUDE_CODE_EXECUTABLE || "claude";
  const cliVersion = await spawnCheck(cliPath, ["--version"], 5000);

  // node check — confirms PATH-based spawn works (sanity).
  const nodeVersion = await spawnCheck("node", ["--version"], 3000);

  return Response.json({
    user: { email: user.email, isOwner: true },
    env,
    cliVersion,
    nodeVersion,
    runtime: {
      cwd: process.cwd(),
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      gid: typeof process.getgid === "function" ? process.getgid() : null,
      home: process.env.HOME ?? null,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    note: "If IS_SANDBOX.present is false → analyze fails with 'cannot be used with root/sudo'. If cliVersion.exitCode is null → CLI binary missing or wrong path. If ANTHROPIC_API_KEY.present is false → query() will reject. Paste this whole JSON if you need help debugging.",
  });
}
