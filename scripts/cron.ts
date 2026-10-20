const slot = "shorts-noon" as const;
const mode = "immediate" as const;

// Safe default: this repository-managed runner never performs a live upload.
const dryRun = true;

const baseUrl = process.env.MIRA_BASE_URL?.replace(/\/$/, "");
const secret = process.env.MIRA_AUTOMATION_SECRET;

if (!baseUrl) {
  throw new Error("MIRA_BASE_URL is not configured");
}
if (!secret) {
  throw new Error("MIRA_AUTOMATION_SECRET is not configured");
}

console.log(
  JSON.stringify({
    event: "mira_cron_start",
    slot,
    mode,
    dryRun,
    utc: new Date().toISOString(),
  }),
);

const response = await fetch(`${baseUrl}/api/youtube/schedule-run`, {
  method: "POST",
  headers: {
    "x-mira-key": secret,
    "content-type": "application/json",
  },
  body: JSON.stringify({ confirm: true, slot, mode, dryRun }),
  signal: AbortSignal.timeout(280_000),
});

const raw = await response.text();
console.log(
  JSON.stringify({
    event: "mira_cron_response",
    slot,
    mode,
    dryRun,
    status: response.status,
    body: raw,
  }),
);

let result: { ok?: boolean } | null = null;
try {
  result = JSON.parse(raw) as { ok?: boolean };
} catch {
  // The response body is included in the structured log above.
}

if (!response.ok || result?.ok !== true) {
  throw new Error(`Mira endpoint failed: HTTP ${response.status}`);
}
