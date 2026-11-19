/** One Codex CLI run (`codex exec`, ChatGPT login, no API key) in `cwd` with the given images attached; log in cwd/codex.log. */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

export function codex(cwd: string, images: string[], prompt: string, timeoutMs = 900_000): Promise<void> {
  return new Promise((resolve) => {
    const log = openSync(join(cwd, "codex.log"), "w");
    const p = spawn("codex", ["exec", "--skip-git-repo-check", ...(process.env.CODEX_MODEL ? ["-m", process.env.CODEX_MODEL] : []), "-s", "workspace-write", "-C", cwd, ...images.flatMap((f) => ["-i", f]), "-"],
      { stdio: ["pipe", log, log] });
    const timer = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
    p.on("close", () => { clearTimeout(timer); closeSync(log); resolve(); });
    p.stdin!.end(prompt);
  });
}
