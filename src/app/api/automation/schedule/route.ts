import { NextResponse } from "next/server";
import { isMiraSessionCookie } from "@/lib/mira-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const REPO = process.env.YT_AUTO_UPLOADER_REPO?.trim() || "benngokhan/yt_auto_uploader";
const BRANCH = process.env.YT_AUTO_UPLOADER_BRANCH?.trim() || "main";
const WORKFLOW_PATH = ".github/workflows/youtube-drive-uploader.yml";
const FETCH_TIMEOUT_MS = 12_000;

type Slots = { sabah: string; ogle: string; aksam: string };

function authorized(req: Request): boolean {
  const expected = (process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET || "").trim();
  if (expected) {
    const headerKey = (req.headers.get("x-mira-key") || "").trim();
    if (headerKey && headerKey === expected) return true;
    const authHeader = (req.headers.get("authorization") || "").trim();
    if (authHeader.toLowerCase().startsWith("bearer ") && authHeader.slice(7).trim() === expected) return true;
  }
  if (isMiraSessionCookie(req.headers.get("cookie"))) return true;
  const entryPassword = (process.env.MIRA_ENTRY_PASSWORD || "").trim();
  if (!expected && !entryPassword && process.env.NODE_ENV !== "production") return true;
  return false;
}

function githubToken(): string {
  return (
    process.env.YT_AUTO_GITHUB_TOKEN ||
    process.env.GITHUB_PAT ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    ""
  ).trim();
}

function apiHeaders(token: string): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "KartaL-Panel-Plan",
  };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Workflow dosyasini ham metin olarak oku (token ile API, olmazsa public raw). */
async function readWorkflow(): Promise<{ text: string; sha?: string }> {
  const token = githubToken();
  if (token) {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${REPO}/contents/${WORKFLOW_PATH}?ref=${encodeURIComponent(BRANCH)}`,
      { headers: { ...apiHeaders(token), Accept: "application/vnd.github.raw+json" } },
    );
    if (res.ok) {
      const text = await res.text();
      // sha'yi ikinci cagriyla al (raw yaniti sha icermeyebilir)
      const metaRes = await fetchWithTimeout(
        `https://api.github.com/repos/${REPO}/contents/${WORKFLOW_PATH}?ref=${encodeURIComponent(BRANCH)}`,
        { headers: apiHeaders(token) },
      ).catch(() => null);
      let sha: string | undefined;
      if (metaRes?.ok) {
        const meta = (await metaRes.json()) as { sha?: string };
        sha = meta.sha;
      }
      return { text, sha };
    }
  }
  const rawRes = await fetchWithTimeout(
    `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${WORKFLOW_PATH}?t=${Date.now()}`,
    { headers: { "Cache-Control": "no-cache" } },
  );
  if (!rawRes.ok) throw new Error(`Workflow dosyasi okunamadi (HTTP ${rawRes.status}).`);
  return { text: await rawRes.text() };
}

function parseCrons(text: string): string[] {
  const scheduleBlock = text.match(/schedule:\s*\n([\s\S]*?)\n\s*\n(?!\s*- cron:)/);
  const scope = scheduleBlock ? scheduleBlock[1] : text;
  const crons = Array.from(scope.matchAll(/-\s*cron:\s*"([^"]+)"/g), (m) => m[1]);
  if (crons.length < 3) {
    const all = Array.from(text.matchAll(/-\s*cron:\s*"([^"]+)"/g), (m) => m[1]);
    if (all.length >= 3) return all.slice(0, 3);
    throw new Error("Workflow icinde 3 adet cron bulunamadi.");
  }
  return crons.slice(0, 3);
}

function utcToTr(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isFinite(minute) || !Number.isFinite(hour)) return "--:--";
  const trHour = (hour + 3) % 24;
  return `${String(trHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function trToUtcCron(time: string): string {
  const m = time.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw new Error(`Gecersiz saat: "${time}" (bicim: 14:30)`);
  const hour = ((Number(m[1]) - 3) % 24 + 24) % 24;
  const minute = Number(m[2]);
  return `${minute} ${hour} * * *`;
}

/** Dosya sirasi: [0]=slot1/ogle, [1]=slot2/aksam, [2]=telafi/sabah */
function slotsFromCrons(crons: string[]): Slots {
  return { ogle: utcToTr(crons[0]), aksam: utcToTr(crons[1]), sabah: utcToTr(crons[2]) };
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Mira oturumu gerekli." }, { status: 401 });
  }
  try {
    const { text } = await readWorkflow();
    const slots = slotsFromCrons(parseCrons(text));
    return NextResponse.json({ ok: true, slots, repo: REPO, branch: BRANCH }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : "Plan okunamadi.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Mira oturumu gerekli." }, { status: 401 });
  }
  const token = githubToken();
  if (!token) {
    return NextResponse.json({ ok: false, error: "Sunucu taraf GitHub token'ı tanimli degil." }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const slots = (body.slots || {}) as Partial<Slots>;
  const sabah = String(slots.sabah || "").trim();
  const ogle = String(slots.ogle || "").trim();
  const aksam = String(slots.aksam || "").trim();
  for (const [label, value] of [["Sabah", sabah], ["Öğle", ogle], ["Akşam", aksam]] as const) {
    if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(value)) {
      return NextResponse.json({ ok: false, error: `${label} saati gecersiz: "${value}" (bicim 14:30)` }, { status: 400 });
    }
  }
  if (new Set([sabah, ogle, aksam]).size !== 3) {
    return NextResponse.json({ ok: false, error: "Uc saat de farkli olmali." }, { status: 400 });
  }

  try {
    const { text, sha } = await readWorkflow();
    if (!sha) {
      return NextResponse.json(
        { ok: false, error: "Dosya surumu (sha) alinamadi; token yetkisi eksik olabilir." },
        { status: 502 },
      );
    }
    const oldCrons = parseCrons(text);
    const newCrons = [trToUtcCron(ogle), trToUtcCron(aksam), trToUtcCron(sabah)];

    // 1) uc cron satirini sirayla degistir
    let updated = text;
    let matchIndex = 0;
    updated = updated.replace(/(-\s*cron:\s*")([^"]+)(")/g, (_full, pre, _old, post) => {
      if (matchIndex > 2) return `${pre}${_old}${post}`;
      const next = `${pre}${newCrons[matchIndex]}${post}`;
      matchIndex += 1;
      return next;
    });
    if (matchIndex < 3) throw new Error("Cron satirlari beklenen formatta degil, yazma iptal.");

    // 2) telafi guard: run.startswith("5 7 ") -> yeni sabah cron'unun ilk iki alani
    const oldTelafi = oldCrons[2].trim().split(/\s+/).slice(0, 2).join(" ");
    const newTelafi = newCrons[2].trim().split(/\s+/).slice(0, 2).join(" ");
    const guardNeedle = `run.startswith("${oldTelafi} ")`;
    if (updated.includes(guardNeedle)) {
      updated = updated.replace(guardNeedle, `run.startswith("${newTelafi} ")`);
    }

    // 3) yorum satirlarindaki saatleri guncelle (best-effort, 3 eslesme varsa)
    const commentTimes = Array.from(updated.matchAll(/(\d{1,2}:\d{2}) TR \((\d{1,2}:\d{2}) UTC\)/g));
    if (commentTimes.length === 3) {
      const newPairs = [
        { tr: ogle, utc: fmtUtc(newCrons[0]) },
        { tr: aksam, utc: fmtUtc(newCrons[1]) },
        { tr: sabah, utc: fmtUtc(newCrons[2]) },
      ];
      let i = 0;
      updated = updated.replace(
        /(\d{1,2}:\d{2}) TR \((\d{1,2}:\d{2}) UTC\)/g,
        () => {
          const pair = newPairs[i] || { tr: "--:--", utc: "--:--" };
          i += 1;
          return `${pair.tr} TR (${pair.utc} UTC)`;
        },
      );
    }

    if (updated === text) {
      return NextResponse.json({ ok: false, error: "Degisiklik yok; ayni saatler zaten kayitli." }, { status: 400 });
    }

    const putRes = await fetchWithTimeout(
      `https://api.github.com/repos/${REPO}/contents/${WORKFLOW_PATH}`,
      {
        method: "PUT",
        headers: { ...apiHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `chore(plan): yayin plani guncellendi — sabah ${sabah}, ogle ${ogle}, aksam ${aksam} (panel)`,
          content: Buffer.from(updated, "utf-8").toString("base64"),
          sha,
          branch: BRANCH,
        }),
      },
    );
    if (!putRes.ok) {
      const detail = await putRes.text().catch(() => "");
      const hint = putRes.status === 403 || putRes.status === 401 ? " Token contents:write yetkisiz olabilir." : "";
      return NextResponse.json(
        { ok: false, error: `GitHub'a kaydedilemedi (HTTP ${putRes.status}).${hint}`, detail: detail.slice(0, 200) },
        { status: 502 },
      );
    }
    const putData = (await putRes.json().catch(() => ({}))) as { commit?: { sha?: string } };

    return NextResponse.json({
      ok: true,
      slots: { sabah, ogle, aksam },
      commitSha: putData.commit?.sha?.slice(0, 7) || "",
      message: "Plan GitHub'a kaydedildi; yeni saatlerden itibaren calisir.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : "Plan kaydedilemedi.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

function fmtUtc(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  return `${String(Number(parts[1])).padStart(2, "0")}:${String(Number(parts[0])).padStart(2, "0")}`;
}
