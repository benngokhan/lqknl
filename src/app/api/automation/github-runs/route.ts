import { NextResponse } from "next/server";
import { isMiraSessionCookie } from "@/lib/mira-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_UPLOADER_REPO = "benngokhan/yt_auto_uploader";
const DEFAULT_PANEL_REPO = "benngokhan/lqknl";
const RUNS_PER_REPO = 12;
const FETCH_TIMEOUT_MS = 12_000;

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
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "KartaL-Panel-Github-Runs",
  };
}

async function gh(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, headers: { ...apiHeaders(token), ...(init.headers || {}) }, cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface RepoBlock {
  key: string;
  repo: string;
  label: string;
  url: string;
  error?: string;
  workflows: Array<{ id: number; name: string; state: string; path: string }>;
  runs: Array<{
    id: number;
    runNumber: number;
    workflowName: string;
    event: string;
    conclusion: string | null;
    createdAt: string;
    durationSec: number | null;
    displayTitle: string;
    htmlUrl: string;
  }>;
}

async function loadRepo(key: string, repo: string, label: string, token: string): Promise<RepoBlock> {
  const block: RepoBlock = { key, repo, label, url: `https://github.com/${repo}`, workflows: [], runs: [] };
  try {
    const [wfRes, runsRes] = await Promise.all([
      gh(`https://api.github.com/repos/${repo}/actions/workflows?per_page=20`, token),
      gh(`https://api.github.com/repos/${repo}/actions/runs?per_page=${RUNS_PER_REPO}`, token),
    ]);
    if (wfRes.status === 403 || wfRes.status === 401) {
      block.error = "GitHub token'ı bu repoya erişemiyor (Actions yetkisi eksik olabilir).";
      return block;
    }
    if (!wfRes.ok) throw new Error(`workflows HTTP ${wfRes.status}`);
    const wfData = await wfRes.json();
    block.workflows = ((wfData as { workflows?: Array<{ id: number; name: string; state: string; path: string }> }).workflows || [])
      .filter((w) => w.path.includes(".github/workflows/"))
      .map((w) => ({ id: w.id, name: w.name, state: w.state, path: w.path }));

    if (runsRes.ok) {
      const runsData = (await runsRes.json()) as {
        workflow_runs?: Array<{
          id: number;
          run_number: number;
          name: string;
          event: string;
          conclusion: string | null;
          status: string;
          created_at: string;
          updated_at: string;
          run_started_at?: string | null;
          display_title?: string;
          html_url: string;
        }>;
      };
      block.runs = (runsData.workflow_runs || []).map((r) => {
        const started = Date.parse(r.run_started_at || r.created_at || "");
        const updated = Date.parse(r.updated_at || "");
        const durationSec = Number.isFinite(started) && Number.isFinite(updated) && updated >= started
          ? Math.round((updated - started) / 1000)
          : null;
        return {
          id: r.id,
          runNumber: r.run_number,
          workflowName: r.name || "Workflow",
          event: r.event,
          conclusion: r.status === "in_progress" || r.status === "queued" ? null : r.conclusion,
          createdAt: r.created_at,
          durationSec,
          displayTitle: (r.display_title || "").slice(0, 140),
          htmlUrl: r.html_url,
        };
      });
    } else {
      block.error = `Çalıştırmalar okunamadı (HTTP ${runsRes.status}).`;
    }
  } catch (error) {
    block.error = error instanceof Error ? error.message.slice(0, 200) : "Repo bilgisi çekilemedi.";
  }
  return block;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Mira oturumu veya otomasyon anahtarı gerekli." }, { status: 401 });
  }
  const token = githubToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "Sunucu tarafı GitHub token'ı tanımlı değil (GITHUB_PAT / YT_AUTO_GITHUB_TOKEN)." },
      { status: 503 },
    );
  }

  const uploaderRepo = (process.env.YT_AUTO_UPLOADER_REPO || DEFAULT_UPLOADER_REPO).trim();
  const panelRepo = (process.env.PANEL_REPO || DEFAULT_PANEL_REPO).trim();

  const [uploader, panel] = await Promise.all([
    loadRepo("uploader", uploaderRepo, "YouTube Drive Uploader · yayın işçisi", token),
    loadRepo("panel", panelRepo, "KartaL Panel · lqknl", token),
  ]);

  return NextResponse.json(
    { ok: true, fetchedAt: new Date().toISOString(), repos: [uploader, panel] },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Mira oturumu veya otomasyon anahtarı gerekli." }, { status: 401 });
  }
  const token = githubToken();
  if (!token) {
    return NextResponse.json({ ok: false, error: "Sunucu tarafı GitHub token'ı tanımlı değil." }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  const workflowId = Number(body.workflowId);
  const action = String(body.action || "").trim();

  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    return NextResponse.json({ ok: false, error: "Geçersiz repo adı." }, { status: 400 });
  }
  if (!Number.isFinite(workflowId) || workflowId <= 0) {
    return NextResponse.json({ ok: false, error: "Geçersiz workflow kimliği." }, { status: 400 });
  }
  if (action !== "enable" && action !== "disable") {
    return NextResponse.json({ ok: false, error: 'Geçersiz action (enable | disable).' }, { status: 400 });
  }

  const res = await gh(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflowId}/${action}`,
    token,
    { method: "PUT" },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const hint =
      res.status === 403 || res.status === 401
        ? "Token'ın Actions yetkisi (actions:write) eksik olabilir."
        : res.status === 404
          ? "Workflow bulunamadı."
          : "";
    return NextResponse.json(
      { ok: false, error: `GitHub hatası (HTTP ${res.status}). ${hint}`.trim(), detail: detail.slice(0, 200) },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    action,
    repo,
    workflowId,
    message: action === "enable" ? "Akış etkinleştirildi." : "Akış devre dışı bırakıldı.",
  });
}
