/**
 * Demo-bot configuration — no side effects at import time (main.ts drives).
 *
 * Env (loaded from ../../.env if present; real environment variables win):
 *   TELEGRAM_BOT_TOKEN   required — bot token from BotFather
 *   SESSION_PATH         optional — where the session snapshot lives
 *   GRAM_DEMO_REPO_URL   optional — the "Source" button on the home screen
 *   TYPESAFE_API_KEY / GRAM_RENDER_API_KEY — needed for renders (not for screens)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Tiny .env loader (no dependency); never overrides real env vars. */
export function loadDotEnv(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return; // no .env file — rely on real environment variables
  }
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1]!;
    if (process.env[key] === undefined) process.env[key] = match[2]!;
  }
}

export interface BotConfig {
  token: string;
  sessionPath: string;
  repoUrl: string;
}

export function readConfig(configPath?: string): BotConfig {
  const token = process.env["TELEGRAM_BOT_TOKEN"] ?? "";
  const sessionPath =
    process.env["SESSION_PATH"] ??
    fileURLToPath(new URL(configPath ?? "../../.bot-sessions.json", import.meta.url));
  const repoUrl =
    process.env["GRAM_DEMO_REPO_URL"] ?? "https://www.npmjs.com/package/gram-render";
  return { token, sessionPath, repoUrl };
}
