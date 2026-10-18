import { spawn } from "node:child_process";

function prefixLines(stream, label, output) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) output.write(`[${label}] ${line}\n`);
  });
  stream.on("end", () => {
    if (pending) output.write(`[${label}] ${pending}\n`);
  });
}

export function runE2ePhase({
  label,
  command,
  args,
  cwd,
  env,
  timeoutMs = 40 * 60_000,
}) {
  return new Promise((resolvePhase) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePhase(status);
    };
    const timer = setTimeout(() => {
      process.stderr.write(
        `[${label}] exceeded the ${timeoutMs}ms phase deadline\n`,
      );
      child.kill("SIGKILL");
      // A descendant can retain an inherited pipe after the launcher exits.
      // Do not wait for close to enforce the failed phase's deadline.
      child.stdout.destroy();
      child.stderr.destroy();
      finish(1);
    }, timeoutMs);
    prefixLines(child.stdout, label, process.stdout);
    prefixLines(child.stderr, label, process.stderr);
    child.on("error", (error) => {
      process.stderr.write(`[${label}] ${error.message}\n`);
      finish(1);
    });
    child.on("close", (status, signal) => {
      if (signal) process.stderr.write(`[${label}] terminated by ${signal}\n`);
      finish(status ?? 1);
    });
  });
}
