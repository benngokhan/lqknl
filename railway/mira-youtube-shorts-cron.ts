const now = new Date();
const slot = "shorts-noon" as const;
const mode = "immediate" as const;
const dryRun = false;

const baseUrl = (Bun.env.MIRA_BASE_URL || "https://qkn0.up.railway.app").replace(/\/$/, "");
const secret = Bun.env.MIRA_AUTOMATION_SECRET;
if (!secret) throw new Error("MIRA_AUTOMATION_SECRET is not configured");

console.log(JSON.stringify({
  event: "mira_cron_start",
  slot,
  mode,
  testMode: "live",
  dryRun,
  utc: now.toISOString(),
}));

const response = await fetch(`${baseUrl}/api/youtube/schedule-run`, {
  method: "POST",
  headers: { "x-mira-key": secret, "content-type": "application/json" },
  body: JSON.stringify({ confirm: true, slot, mode, dryRun }),
  signal: AbortSignal.timeout(280_000),
});
const raw = await response.text();
console.log(JSON.stringify({
  event: "mira_cron_response",
  slot,
  mode,
  testMode: "live",
  dryRun,
  status: response.status,
  body: raw,
}));
let result: any = null;
try { result = JSON.parse(raw); } catch {}
if (!response.ok || result?.ok !== true) {
  throw new Error(`Mira endpoint failed: HTTP ${response.status}`);
}
