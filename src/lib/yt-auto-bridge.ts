import * as XLSX from "xlsx";

export type YoutubeAutoVideoType = "short" | "long" | "auto";

export interface QueuedVideoPreview {
  fileName: string;
  title: string;
  category: string;
  row: number;
  videoType: "short" | "long";
}

export interface UploadedVideoInfo {
  driveFileId: string;
  fileName: string;
  title: string;
  youtubeUrl: string;
  uploadedAt: string;
}

export interface LiveAutomationStock {
  ok: true;
  repo: string;
  branch: string;
  fetchedAt: string;
  dailyUploadRate: number;
  remainingShortsCount: number;
  remainingLongsCount: number;
  totalRemainingCount: number;
  unfilledTemplateCount: number;
  estimatedDaysRemaining: number;
  estimatedDaysFormatted: string;
  shortsRange: string | null;
  longsRange: string | null;
  badgeText: string;
  summary: string;
  voiceSummaryTr: string;
  nextShort: QueuedVideoPreview | null;
  nextLong: QueuedVideoPreview | null;
  lastUploaded: UploadedVideoInfo | null;
  recentUploaded: UploadedVideoInfo[];
}

export interface TriggerYoutubeUploadResult {
  ok: true;
  dispatched: true;
  repo: string;
  workflow: string;
  ref: string;
  videoType: YoutubeAutoVideoType;
  dryRun: boolean;
  dispatchedAt: string;
  actionsUrl: string;
  targetPreview: QueuedVideoPreview | null;
  message: string;
}

const DEFAULT_REPO = "benngokhan/yt_auto_uploader";
const DEFAULT_BRANCH = "main";
const DEFAULT_WORKFLOW = "youtube-drive-uploader.yml";
const DEFAULT_DAILY_RATE = 3;
const MIN_SHORTS_NUMBER = 31;
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 10_000;

let cachedStock: { expiresAt: number; data: LiveAutomationStock } | null = null;

function resolveRepoConfig() {
  const repo = process.env.YT_AUTO_UPLOADER_REPO?.trim() || DEFAULT_REPO;
  const branch = process.env.YT_AUTO_UPLOADER_BRANCH?.trim() || DEFAULT_BRANCH;
  const workflow = process.env.YT_AUTO_UPLOADER_WORKFLOW?.trim() || DEFAULT_WORKFLOW;
  const token = (
    process.env.YT_AUTO_GITHUB_TOKEN ||
    process.env.GITHUB_PAT ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    ""
  ).trim();
  const dailyRateRaw = Number(process.env.YT_DAILY_UPLOAD_RATE || DEFAULT_DAILY_RATE);
  const dailyUploadRate = Number.isFinite(dailyRateRaw) && dailyRateRaw > 0 ? dailyRateRaw : DEFAULT_DAILY_RATE;

  return { repo, branch, workflow, token, dailyUploadRate };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRepoFileBuffer(filePath: string): Promise<Buffer> {
  const { repo, branch, token } = resolveRepoConfig();
  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  // 1) Token varsa GitHub Contents API (CDN gecikmesi olmadan anlık veri)
  if (token) {
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
    const apiRes = await fetchWithTimeout(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.raw",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Mira-Assistant-YT-Bridge",
      },
    }).catch(() => null);

    if (apiRes?.ok) {
      const ab = await apiRes.arrayBuffer();
      return Buffer.from(ab);
    }
  }

  // 2) Public Raw GitHub fallback (token olmasa da veya API rate-limit anında çalışır)
  const rawUrl = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${encodedPath}?t=${Date.now()}`;
  const rawRes = await fetchWithTimeout(rawUrl, {
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": "Mira-Assistant-YT-Bridge",
    },
  });

  if (!rawRes.ok) {
    throw new Error(`${repo}/${filePath} okunamadı (HTTP ${rawRes.status}).`);
  }

  const ab = await rawRes.arrayBuffer();
  return Buffer.from(ab);
}

function isLongFilename(fileName: string): boolean {
  return fileName.trim().toLowerCase().startsWith("uzun_");
}

function extractVideoNumber(fileName: string): number {
  const match = fileName.match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 999_999;
}

function isSkippedByFloor(fileName: string): boolean {
  const lower = fileName.trim().toLowerCase();
  if (lower.startsWith("video_") && extractVideoNumber(lower) < MIN_SHORTS_NUMBER) {
    return true;
  }
  if (lower === "uzun_video_1.mp4" || lower === "uzun_video_2.mp4") {
    return true;
  }
  return false;
}

function isDoneStatus(status: string): boolean {
  const up = status.toLocaleUpperCase("tr-TR");
  const asciiUp = status.toUpperCase();
  return (
    up.includes("YÜKLENDİ") ||
    asciiUp.includes("YUKLENDI") ||
    up.includes("YAYINLANDI") ||
    asciiUp.includes("UPLOADED") ||
    asciiUp.includes("PUBLISHED") ||
    up.includes("TAMAM")
  );
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .toLocaleLowerCase("tr-TR")
    .replace(/[^a-z0-9]+/g, "");
}

function fixSheetJsEmojiTruncation(value: unknown): string {
  // SheetJS 0.18.x decodes &#NNNNN; XML entities with String.fromCharCode,
  // truncating supplementary emoji (U+1F000..U+1FBFF) into U+F000..U+FBFF.
  return String(value ?? "").replace(/[\uF000-\uFBFF]/g, (ch) =>
    String.fromCodePoint(ch.charCodeAt(0) + 0x10000),
  );
}

function normalizeYoutubeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return `https://youtu.be/${trimmed}`;
  return trimmed;
}

function isDirectYoutubeVideoUrl(url: string): boolean {
  return /(?:youtu\.be\/[A-Za-z0-9_-]{6,}|youtube\.com\/(?:watch\?v=|shorts\/)[A-Za-z0-9_-]{6,})/i.test(url);
}

interface ParsedUploadedLog {
  uploadedFileNames: Set<string>;
  uploadedDriveIds: Set<string>;
  entries: UploadedVideoInfo[];
}

function parseUploadedTxt(rawText: string): ParsedUploadedLog {
  const uploadedFileNames = new Set<string>();
  const uploadedDriveIds = new Set<string>();
  const entries: UploadedVideoInfo[] = [];

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split("|").map((p) => p.trim());
    const driveFileId = parts[0] ?? "";
    const fileName = parts[1] ?? "";
    const youtubeUrl = normalizeYoutubeUrl(parts[2] ?? "");
    const uploadedAt = parts[3] ?? "";
    const inlineTitle = parts.slice(4).join(" | ").trim();

    if (driveFileId) uploadedDriveIds.add(driveFileId);
    if (fileName) uploadedFileNames.add(fileName.toLowerCase());

    entries.push({
      driveFileId,
      fileName,
      title: inlineTitle,
      youtubeUrl,
      uploadedAt,
    });
  }

  return { uploadedFileNames, uploadedDriveIds, entries };
}

interface ParsedWorkbookRow {
  row: number;
  status: string;
  fileName: string;
  title: string;
  category: string;
  isLong: boolean;
  isDone: boolean;
  hasTitle: boolean;
}

function parseWorkbookRows(xlsxBuffer: Buffer): {
  rows: ParsedWorkbookRow[];
  byFileName: Map<string, ParsedWorkbookRow>;
} {
  const workbook = XLSX.read(xlsxBuffer, { type: "buffer", cellDates: false });
  const targetSheetName =
    workbook.SheetNames.find((name) => name.trim().toLowerCase() === "drive") ?? workbook.SheetNames[0];

  if (!targetSheetName || !workbook.Sheets[targetSheetName]) {
    throw new Error("bilgidozu_yukleme_tablosu.xlsx içinde DRIVE sayfası bulunamadı.");
  }

  const sheet = workbook.Sheets[targetSheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  if (!matrix.length) {
    return { rows: [], byFileName: new Map() };
  }

  const headerRow = matrix[0] ?? [];
  let statusCol = -1;
  let fileCol = -1;
  let titleCol = -1;
  let categoryCol = -1;

  headerRow.forEach((cellVal, idx) => {
    const h = normalizeHeader(cellVal);
    if (!h) return;
    if (statusCol === -1 && (h.includes("durum") || h === "status")) statusCol = idx;
    else if (fileCol === -1 && (h.includes("dosya") || h.includes("filename") || h === "file")) fileCol = idx;
    else if (titleCol === -1 && (h.includes("baslik") || h.includes("title"))) titleCol = idx;
    else if (categoryCol === -1 && (h.includes("kategori") || h.includes("konu") || h.includes("category"))) {
      categoryCol = idx;
    }
  });

  if (statusCol === -1) statusCol = 0;
  if (fileCol === -1) fileCol = 1;
  if (titleCol === -1) titleCol = 2;
  if (categoryCol === -1) categoryCol = 7;

  const rows: ParsedWorkbookRow[] = [];
  const byFileName = new Map<string, ParsedWorkbookRow>();

  for (let i = 1; i < matrix.length; i++) {
    const r = matrix[i] ?? [];
    const excelRowNum = i + 1;
    const fileName = String(r[fileCol] ?? "").trim();
    if (!fileName || !/^(?:video_\d+|uzun_video_\d+)\.mp4$/i.test(fileName)) {
      continue;
    }

    const status = fixSheetJsEmojiTruncation(r[statusCol]).trim();
    const title = fixSheetJsEmojiTruncation(r[titleCol]).trim();
    const category = fixSheetJsEmojiTruncation(r[categoryCol]).trim();
    const isLong = isLongFilename(fileName);
    const isDone = isDoneStatus(status) || isSkippedByFloor(fileName);
    const hasTitle = Boolean(title);

    const parsed: ParsedWorkbookRow = {
      row: excelRowNum,
      status: status || "BEKLEMEDE",
      fileName,
      title,
      category,
      isLong,
      isDone,
      hasTitle,
    };

    rows.push(parsed);
    byFileName.set(fileName.toLowerCase(), parsed);
  }

  return { rows, byFileName };
}

function formatRangeLabel(items: ParsedWorkbookRow[], prefix: "video_" | "uzun_video_"): string | null {
  if (!items.length) return null;
  const firstNum = extractVideoNumber(items[0].fileName);
  const lastNum = extractVideoNumber(items[items.length - 1].fileName);
  if (firstNum === lastNum) return `${prefix}${firstNum}`;
  return `${prefix}${firstNum}..${lastNum}`;
}

export function normalizeVideoType(input: unknown): YoutubeAutoVideoType {
  const val = String(input ?? "auto").trim().toLowerCase();
  if (val === "short" || val === "shorts" || val === "kisa" || val === "kısa") return "short";
  if (val === "long" || val === "uzun") return "long";
  if (val === "auto" || val === "" || val === "otomatik") return "auto";
  throw new Error(`Geçersiz videoType: "${String(input)}". Beklenen: "short" | "long" | "auto".`);
}

/**
 * `benngokhan/yt_auto_uploader` reposundaki canlı `uploaded.txt` ve
 * `bilgidozu_yukleme_tablosu.xlsx` dosyalarını okuyup anlık stok durumunu hesaplar.
 */
export async function getLiveAutomationStock(options?: { forceRefresh?: boolean }): Promise<LiveAutomationStock> {
  const forceRefresh = options?.forceRefresh === true;
  if (!forceRefresh && cachedStock && Date.now() < cachedStock.expiresAt) {
    return cachedStock.data;
  }

  const { repo, branch, dailyUploadRate } = resolveRepoConfig();

  const [uploadedBuf, xlsxBuf] = await Promise.all([
    fetchRepoFileBuffer("uploaded.txt").catch(() => Buffer.from("", "utf-8")),
    fetchRepoFileBuffer("bilgidozu_yukleme_tablosu.xlsx").catch(() => fetchRepoFileBuffer("baslik.xlsx")),
  ]);

  const uploadedLog = parseUploadedTxt(uploadedBuf.toString("utf-8"));
  const { rows, byFileName } = parseWorkbookRows(xlsxBuf);

  const readyShorts: ParsedWorkbookRow[] = [];
  const readyLongs: ParsedWorkbookRow[] = [];
  let unfilledTemplateCount = 0;

  for (const row of rows) {
    const alreadyInTxt = uploadedLog.uploadedFileNames.has(row.fileName.toLowerCase());
    if (row.isDone || alreadyInTxt) continue;
    if (!row.hasTitle) {
      unfilledTemplateCount++;
      continue;
    }
    if (row.isLong) {
      readyLongs.push(row);
    } else {
      readyShorts.push(row);
    }
  }

  readyShorts.sort((a, b) => extractVideoNumber(a.fileName) - extractVideoNumber(b.fileName));
  readyLongs.sort((a, b) => extractVideoNumber(a.fileName) - extractVideoNumber(b.fileName));

  // uploaded.txt kayıtlarını tablo başlığı ile zenginleştir; kilit satırlarını (LOCKED_ / MANUAL_SKIP) ayıkla
  const realUploadedEntries: UploadedVideoInfo[] = uploadedLog.entries
    .filter((entry) => {
      const idUp = entry.driveFileId.toUpperCase();
      if (idUp.startsWith("LOCKED_") || idUp.startsWith("MANUAL_SKIP")) return false;
      return isDirectYoutubeVideoUrl(entry.youtubeUrl) || Boolean(entry.fileName);
    })
    .map((entry) => {
      const sheetRow = byFileName.get(entry.fileName.toLowerCase());
      return {
        driveFileId: entry.driveFileId,
        fileName: entry.fileName,
        title: entry.title || sheetRow?.title || entry.fileName,
        youtubeUrl: entry.youtubeUrl,
        uploadedAt: entry.uploadedAt,
      };
    });

  const recentUploaded = realUploadedEntries.slice().reverse();
  const lastUploaded =
    recentUploaded.find((item) => isDirectYoutubeVideoUrl(item.youtubeUrl)) ?? recentUploaded[0] ?? null;

  const remainingShortsCount = readyShorts.length;
  const remainingLongsCount = readyLongs.length;
  const totalRemainingCount = remainingShortsCount + remainingLongsCount;

  const rawDays = totalRemainingCount / dailyUploadRate;
  const estimatedDaysRemaining = Math.round((rawDays + Number.EPSILON) * 10) / 10;
  const estimatedDaysFormatted = rawDays.toFixed(1);

  const shortsRange = formatRangeLabel(readyShorts, "video_");
  const longsRange = formatRangeLabel(readyLongs, "uzun_video_");

  const nextShort: QueuedVideoPreview | null = readyShorts[0]
    ? {
        fileName: readyShorts[0].fileName,
        title: readyShorts[0].title,
        category: readyShorts[0].category,
        row: readyShorts[0].row,
        videoType: "short",
      }
    : null;

  const nextLong: QueuedVideoPreview | null = readyLongs[0]
    ? {
        fileName: readyLongs[0].fileName,
        title: readyLongs[0].title,
        category: readyLongs[0].category,
        row: readyLongs[0].row,
        videoType: "long",
      }
    : null;

  const badgeText = `📦 Kalan Stok: ${remainingShortsCount} Shorts · ${remainingLongsCount} Uzun (~${estimatedDaysFormatted} Gün)`;

  const voiceParts = [
    `Şu anda kuyrukta yayına hazır ${remainingShortsCount} adet Shorts ve ${remainingLongsCount} adet uzun video olmak üzere toplam ${totalRemainingCount} video var; günde ${dailyUploadRate} videodan yaklaşık ${estimatedDaysFormatted} günlük stoğumuz bulunuyor.`,
  ];
  if (nextShort) {
    voiceParts.push(`Sıradaki Shorts: ${nextShort.fileName}, "${nextShort.title}".`);
  }
  if (nextLong) {
    voiceParts.push(`Sıradaki uzun video: ${nextLong.fileName}, "${nextLong.title}".`);
  }

  const result: LiveAutomationStock = {
    ok: true,
    repo,
    branch,
    fetchedAt: new Date().toISOString(),
    dailyUploadRate,
    remainingShortsCount,
    remainingLongsCount,
    totalRemainingCount,
    unfilledTemplateCount,
    estimatedDaysRemaining,
    estimatedDaysFormatted,
    shortsRange,
    longsRange,
    badgeText,
    summary: badgeText,
    voiceSummaryTr: voiceParts.join(" "),
    nextShort,
    nextLong,
    lastUploaded,
    recentUploaded: recentUploaded.slice(0, 10),
  };

  cachedStock = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    data: result,
  };

  return result;
}

/**
 * GitHub Actions `workflow_dispatch` API'sini tetikleyerek `benngokhan/yt_auto_uploader`
 * üzerinde anında Shorts (`short`), Uzun Video (`long`) veya Otomatik (`auto`) yükleme başlatır.
 */
export async function triggerYoutubeAutoUpload(
  videoType: YoutubeAutoVideoType = "auto",
  dryRun = false,
): Promise<TriggerYoutubeUploadResult> {
  const normalizedType = normalizeVideoType(videoType);
  const isDryRun = Boolean(dryRun);
  const { repo, branch, workflow, token } = resolveRepoConfig();

  if (!token) {
    throw new Error(
      "GitHub Actions tetiklemek için YT_AUTO_GITHUB_TOKEN, GITHUB_PAT veya GITHUB_TOKEN ortam değişkeni tanımlanmalıdır.",
    );
  }

  const dispatchUrl = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Mira-Assistant-YT-Bridge",
  };

  let res = await fetchWithTimeout(dispatchUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ref: branch,
      inputs: {
        video_type: normalizedType,
        dry_run: isDryRun,
      },
    }),
  });

  // Eski/alternatif workflow şemalarında boolean input string olarak beklenirse otomatik yedek deneme
  if (res.status === 422) {
    res = await fetchWithTimeout(dispatchUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ref: branch,
        inputs: {
          video_type: normalizedType,
          dry_run: String(isDryRun),
        },
      }),
    });
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `GitHub Actions workflow_dispatch hatası (HTTP ${res.status}): ${errBody.slice(0, 280) || res.statusText}`,
    );
  }

  const stock = await getLiveAutomationStock({ forceRefresh: false }).catch(() => null);
  const targetPreview =
    normalizedType === "long"
      ? (stock?.nextLong ?? stock?.nextShort ?? null)
      : normalizedType === "short"
        ? (stock?.nextShort ?? stock?.nextLong ?? null)
        : (stock?.nextShort ?? stock?.nextLong ?? null);

  // Yeni yükleme tetiklendiği için önbelleği temizle
  cachedStock = null;

  const actionsUrl = `https://github.com/${repo}/actions/workflows/${workflow}`;
  const modeLabel =
    normalizedType === "short" ? "Shorts" : normalizedType === "long" ? "Uzun Video" : "Otomatik (Prime Time)";

  const message = isDryRun
    ? `🧪 ${modeLabel} için GitHub Actions Dry-Run doğrulama akışı başlatıldı.`
    : targetPreview
      ? `🚀 ${modeLabel} yüklemesi başlatıldı! Sıradaki aday: ${targetPreview.fileName} — "${targetPreview.title}"`
      : `🚀 ${modeLabel} için YouTube otomatik yükleme iş akışı tetiklendi.`;

  return {
    ok: true,
    dispatched: true,
    repo,
    workflow,
    ref: branch,
    videoType: normalizedType,
    dryRun: isDryRun,
    dispatchedAt: new Date().toISOString(),
    actionsUrl,
    targetPreview,
    message,
  };
}
