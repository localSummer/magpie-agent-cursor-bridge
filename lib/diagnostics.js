import fs from "node:fs";

const phases = new Set([
  "retry",
  "no_progress",
  "retry_budget",
  "cancelled",
  "completed",
]);
const reasons = new Set([
  "gateway_unavailable",
  "provider_transient",
  "no_progress",
  "retry_budget",
  "cancelled",
  "completed",
]);
export function recordLatency(file, event) {
  if (
    event?.event !== "latency" ||
    !phases.has(event.phase) ||
    typeof event.call_id !== "string" ||
    !/^[a-zA-Z0-9:_-]{1,160}$/.test(event.call_id) ||
    !Number.isInteger(event.attempt) ||
    event.attempt < 0 ||
    event.attempt > 1
  )
    return;
  const row = {
    t: new Date().toISOString(),
    call_id: event.call_id,
    attempt: event.attempt,
    phase: event.phase,
  };
  if (reasons.has(event.reason)) row.reason = event.reason;
  for (const key of ["elapsed_ms", "idle_ms", "remaining_ms"]) {
    if (Number.isSafeInteger(event[key]) && event[key] >= 0)
      row[key] = event[key];
  }
  try {
    const line = JSON.stringify(row) + "\n";
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    fs.writeFileSync(file, line, {
      flag: size + Buffer.byteLength(line) > 1024 * 1024 ? "w" : "a",
      mode: 0o600,
    });
  } catch {
    /* 诊断失败不得影响正常请求。 */
  }
}
