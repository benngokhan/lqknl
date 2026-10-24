import type { Emotion } from "./avatar";

type Turn = { role: "user" | "assistant"; content: string };
export type Persona = "sweet" | "flirty";

export type LiveStockSnapshot = {
  hasStockData: boolean;
  shortsCount: number | null;
  longCount: number | null;
  daysRemaining: number | null;
  dailyRate: number;
  todayPublished: number | null;
  totalPublished: number | null;
  nextVideoFile: string | null;
  nextVideoTitle: string | null;
  nextLongFile: string | null;
  nextLongTitle: string | null;
  n8nReachable: boolean;
  n8nActiveWorkflows: number | null;
  driveConnected: boolean | null;
  telegramConfigured: boolean | null;
};

const VALID_EMOTIONS: Emotion[] = ["happy", "surprised", "sad", "playful", "focused"];

export function detectEmotion(text: string): Emotion {
  const lower = (text || "").toLocaleLowerCase("tr-TR");
  if (/üzgün|özür|maalesef|kötü|zor|endişe|kritik|dikkat\s+patron/.test(lower)) return "sad";
  if (/vay|inanılmaz|şaşırtıcı|gerçekten mi|oha|ciddi misin|sürpriz/.test(lower)) return "surprised";
  if (/haha|hehe|😉|😏|şaka|tatlım|flört|göz kırp|yakışıklı|enerji/.test(lower)) return "playful";
  if (/analiz|hesap|adım|plan|strateji|rapor|kontrol|kuyruk|doğrula/.test(lower)) return "focused";
  return "happy";
}

function parseEmotionTag(raw: string): { reply: string; emotion: Emotion } {
  const match = raw.match(/^\s*\[EMOTION:(happy|surprised|sad|playful|focused)\]\s*/i);
  if (match) {
    const emotion = match[1].toLowerCase() as Emotion;
    const reply = raw.slice(match[0].length).trim();
    if (VALID_EMOTIONS.includes(emotion) && reply) {
      return { reply, emotion };
    }
  }
  const cleaned = raw
    .replace(/\[EMOTION:[^\]]*\]/gi, "")
    .replace(/\bben\s+mira(?:'yım|'yim|yım|yim)?\b/giu, "ben KartaL'ım")
    .replace(/\badım\s+mira\b/giu, "adım KartaL")
    .replace(/\bmira\s+olarak\b/giu, "KartaL olarak")
    .trim();
  return { reply: cleaned, emotion: detectEmotion(cleaned) };
}

/**
 * Strip hashtags, emojis, and noisy suffixes from a video title so Mira reads it
 * naturally during spoken Jarvis briefings.
 */
function cleanTitleForSpeech(rawTitle: string | null | undefined): string | null {
  if (!rawTitle) return null;
  const cleaned = rawTitle
    .replace(/(?:^|\s)#[a-zA-Z0-9_çğıöşüÇĞİÖŞÜ]+/g, " ")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu, " ")
    .replace(/^["'«»“”`\s—–-]+|["'«»“”`\s—–-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function toFiniteInt(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) return Math.max(0, Math.round(val));
  if (typeof val === "string" && val.trim()) {
    const parsed = Number(val.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed));
  }
  return null;
}

function toFiniteFloat(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) return Math.max(0, Number(val.toFixed(1)));
  if (typeof val === "string" && val.trim()) {
    const parsed = Number(val.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return Math.max(0, Number(parsed.toFixed(1)));
  }
  return null;
}

function formatSpokenDays(days: number): string {
  const rounded = Number(days.toFixed(1));
  if (Number.isInteger(rounded)) return `${Math.round(rounded)}`;
  return `${rounded}`.replace(".", ",");
}

function formatFileLabelForSpeech(fileName: string | null): string | null {
  if (!fileName) return null;
  const shortMatch = fileName.match(/^video_0*(\d+)\.mp4$/i);
  if (shortMatch) return `Shorts ${shortMatch[1]}`;
  const longMatch = fileName.match(/^uzun_video_0*(\d+)\.mp4$/i);
  if (longMatch) return `Uzun video ${longMatch[1]}`;
  return fileName.replace(/\.mp4$/i, "");
}

/**
 * Parse live operational & stock telemetry from `statusContext` (and `memoryContext` fallback).
 * Supports dashboard summaries ("60 Shorts · 9 Uzun (~23.0 Gün)"), key-value blocks,
 * embedded JSON objects, and `/api/drive/catalog` arrays.
 */
export function extractLiveStatus(statusContext = "", memoryContext = ""): LiveStockSnapshot {
  const combined = [statusContext, memoryContext].filter(Boolean).join("\n");

  let shortsCount: number | null = null;
  let longCount: number | null = null;
  let daysRemaining: number | null = null;
  let dailyRate = 3;
  let todayPublished: number | null = null;
  let totalPublished: number | null = null;
  let nextVideoFile: string | null = null;
  let nextVideoTitle: string | null = null;
  let nextLongFile: string | null = null;
  let nextLongTitle: string | null = null;

  // 1. Try structured JSON object if `statusContext` is JSON or contains a JSON summary block
  const trimmedStatus = statusContext.trim();
  if (trimmedStatus.startsWith("{") && trimmedStatus.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmedStatus) as Record<string, unknown>;
      shortsCount = toFiniteInt(
        obj.shortsCount ?? obj.shortsRemaining ?? obj.shortsStock ?? obj.queuedShorts ?? obj.bekleyenShorts ?? obj.shorts
      );
      longCount = toFiniteInt(
        obj.longCount ?? obj.longRemaining ?? obj.longStock ?? obj.uzunCount ?? obj.uzunStock ?? obj.bekleyenUzun ?? obj.longVideos
      );
      daysRemaining = toFiniteFloat(obj.daysRemaining ?? obj.stokGun ?? obj.estimatedDays ?? obj.days);
      const rateCandidate = toFiniteFloat(obj.dailyRate ?? obj.gunlukAtis);
      if (rateCandidate && rateCandidate > 0) dailyRate = rateCandidate;
      todayPublished = toFiniteInt(obj.todayPublished ?? obj.publishedToday ?? obj.bugunYayinlanan ?? obj.todayCount);
      totalPublished = toFiniteInt(obj.totalPublished ?? obj.uploadedCount ?? obj.toplamYayinlanan);

      const nextObj = obj.nextVideo ?? obj.nextShort ?? obj.siradakiVideo;
      if (typeof nextObj === "string") {
        const fileMatch = nextObj.match(/\b((?:uzun_)?video_\d+\.mp4)\b/i);
        if (fileMatch) nextVideoFile = fileMatch[1];
        const stripped = nextObj.replace(/\b(?:uzun_)?video_\d+\.mp4\b\s*[:—–-]?\s*/i, "").trim();
        if (stripped) nextVideoTitle = cleanTitleForSpeech(stripped);
      } else if (nextObj && typeof nextObj === "object") {
        const nv = nextObj as Record<string, unknown>;
        if (typeof nv.fileName === "string") nextVideoFile = nv.fileName;
        if (typeof nv.file === "string" && !nextVideoFile) nextVideoFile = nv.file;
        if (typeof nv.title === "string") nextVideoTitle = cleanTitleForSpeech(nv.title);
      }

      const nextLongObj = obj.nextLong ?? obj.siradakiUzun;
      if (typeof nextLongObj === "string") {
        nextLongTitle = cleanTitleForSpeech(nextLongObj);
      } else if (nextLongObj && typeof nextLongObj === "object") {
        const nl = nextLongObj as Record<string, unknown>;
        if (typeof nl.fileName === "string") nextLongFile = nl.fileName;
        if (typeof nl.title === "string") nextLongTitle = cleanTitleForSpeech(nl.title);
      }
    } catch {
      // Continue to regex/text extraction
    }
  }

  // 2. Parse compact pair formats like "60 Shorts · 9 Uzun (~23.0 Gün)" or "60 Shorts ve 9 uzun video"
  if (shortsCount === null || longCount === null) {
    const pairMatch = combined.match(
      /(\d+)\s*shorts?\s*(?:[·•,|/]|ve|\+)\s*(\d+)\s*uzun(?:\s*video)?/iu
    );
    if (pairMatch) {
      if (shortsCount === null) shortsCount = Number(pairMatch[1]);
      if (longCount === null) longCount = Number(pairMatch[2]);
    }
  }

  // 3. Parse individual labeled stock counts (avoiding "bugün X Shorts yayında" confusion!)
  if (todayPublished === null) {
    const todayPatterns = [
      /bugün\s*(?:yayında|yayınlanan|yüklenen|atılan|paylaşılan)\s*[:=]?\s*(\d+)/iu,
      /bugün\s+(\d+)\s*(?:shorts?|video)\s*(?:yayında|yayınlandı|yüklendi|atıldı|paylaşıldı)/iu,
      /(?:todayPublished|publishedToday|bugunYayinlanan)\s*["':=]+\s*(\d+)/iu,
    ];
    for (const pat of todayPatterns) {
      const m = combined.match(pat);
      if (m) {
        todayPublished = Number(m[1]);
        break;
      }
    }
  }

  if (shortsCount === null) {
    const shortsPatterns = [
      /(?:sırada|kalan|depoda|bekleyen|hazır|kuyrukta|stok(?:ta)?)\s*[:=]?\s*(\d+)\s*shorts?\b/iu,
      /(?:kalan\s*shorts?|bekleyen\s*shorts?|hazır\s*shorts?|shorts?\s*stoğu|shorts?\s*sayısı|shortsStock|shortsRemaining|queuedShorts)\s*["':=]+\s*(\d+)/iu,
      /(?<!bugün\s)\b(\d+)\s*shorts?\s*(?:hazır|bekliyor|kuyrukta|stokta|kaldı)\b/iu,
    ];
    for (const pat of shortsPatterns) {
      const m = combined.match(pat);
      if (m) {
        shortsCount = Number(m[1]);
        break;
      }
    }
  }

  if (longCount === null) {
    const longPatterns = [
      /(?:sırada|kalan|depoda|bekleyen|hazır|kuyrukta)\s*(?:\d+\s*shorts?\s*(?:ve|,|·)\s*)?(\d+)\s*uzun(?:\s*video)?\b/iu,
      /(?:kalan\s*uzun|bekleyen\s*uzun|hazır\s*uzun|uzun\s*video(?:\s*sayısı|\s*stoğu)?|longStock|longRemaining|uzunStock)\s*["':=]+\s*(\d+)/iu,
      /\b(\d+)\s*uzun\s*video(?:muz)?\s*(?:var|hazır|bekliyor|kaldı|stokta)\b/iu,
    ];
    for (const pat of longPatterns) {
      const m = combined.match(pat);
      if (m) {
        longCount = Number(m[1]);
        break;
      }
    }
  }

  if (totalPublished === null) {
    const totalMatch = combined.match(
      /(?:toplam\s*(?:yayınlanan|yüklenen)|totalPublished|uploadedCount)\s*["':=]+\s*(\d+)/iu
    );
    if (totalMatch) totalPublished = Number(totalMatch[1]);
  }

  if (daysRemaining === null) {
    const daysPatterns = [
      /[~(]\s*~?\s*(\d+(?:[.,]\d+)?)\s*gün\s*\)?/iu,
      /(?:tahmini\s*(?:stok\s*)?süre(?:si)?|stok\s*günü|yetme\s*süresi|daysRemaining)\s*["':=]+\s*~?\s*(\d+(?:[.,]\d+)?)/iu,
      /yaklaşık\s*(\d+(?:[.,]\d+)?)\s*gün(?:lük)?\s*stok/iu,
    ];
    for (const pat of daysPatterns) {
      const m = combined.match(pat);
      if (m) {
        daysRemaining = toFiniteFloat(m[1]);
        break;
      }
    }
  }

  // 4. Parse `/api/drive/catalog` arrays if embedded in `memoryContext` or `statusContext`
  if (shortsCount === null && /Shorts dosyaları:\s*\[/iu.test(combined)) {
    const shortsArrMatch = combined.match(/Shorts dosyaları:\s*(\[[^\n]*\])/iu);
    if (shortsArrMatch) {
      try {
        const arr = JSON.parse(shortsArrMatch[1]) as Array<{ name?: string }>;
        if (Array.isArray(arr)) {
          shortsCount = arr.length;
          const sorted = [...arr]
            .map((x) => x?.name || "")
            .filter((n) => /^video_\d+\.mp4$/i.test(n))
            .sort((a, b) => {
              const na = Number(a.match(/\d+/)?.[0] ?? 9999);
              const nb = Number(b.match(/\d+/)?.[0] ?? 9999);
              return na - nb;
            });
          if (sorted.length && !nextVideoFile) {
            nextVideoFile = sorted[0];
          }
        }
      } catch {
        // Ignore malformed array snippet
      }
    }
  }

  if (longCount === null && /Uzun video dosyaları:\s*\[/iu.test(combined)) {
    const longArrMatch = combined.match(/Uzun video dosyaları:\s*(\[[^\n]*\])/iu);
    if (longArrMatch) {
      try {
        const arr = JSON.parse(longArrMatch[1]) as Array<{ name?: string }>;
        if (Array.isArray(arr)) {
          longCount = arr.length;
          const sorted = [...arr]
            .map((x) => x?.name || "")
            .filter((n) => /^uzun_video_\d+\.mp4$/i.test(n))
            .sort((a, b) => {
              const na = Number(a.match(/\d+/)?.[0] ?? 9999);
              const nb = Number(b.match(/\d+/)?.[0] ?? 9999);
              return na - nb;
            });
          if (sorted.length && !nextLongFile) {
            nextLongFile = sorted[0];
          }
        }
      } catch {
        // Ignore malformed array snippet
      }
    }
  }

  // 5. Parse explicit "Sıradaki video / Sıradaki Shorts" line
  if (!nextVideoTitle && !nextVideoFile) {
    const nextLineMatch = combined.match(
      /(?:sıradaki\s*(?:video|shorts?)|ilk\s*sırada(?:ki)?|nextVideo|nextShort)\s*["':=]+\s*([^\n]+)/iu
    );
    if (nextLineMatch) {
      const rawLine = nextLineMatch[1].trim();
      const fileInLine = rawLine.match(/\b((?:uzun_)?video_\d+\.mp4)\b/i);
      if (fileInLine) nextVideoFile = fileInLine[1];
      const remainder = rawLine
        .replace(/\b(?:uzun_)?video_\d+\.mp4\b/i, "")
        .replace(/^[\s—–\-:|()]+|[\s—–\-:|()]+$/g, "")
        .trim();
      if (remainder) {
        nextVideoTitle = cleanTitleForSpeech(remainder);
      }
    }
  }

  // Match title from `baslik.md` block if we know `nextVideoFile` (`video_N.mp4`)
  if (nextVideoFile && !nextVideoTitle) {
    const numMatch = nextVideoFile.match(/^video_0*(\d+)\.mp4$/i);
    if (numMatch) {
      const num = Number(numMatch[1]);
      const blockRegex = new RegExp(
        `VIDEO\\s+0*${num}\\b[\\s\\S]{0,500}?(?:BAŞLIK|BASLIK)\\**\\s*:\\s*([^\\n]+)`,
        "iu"
      );
      const bm = combined.match(blockRegex);
      if (bm?.[1]) {
        nextVideoTitle = cleanTitleForSpeech(bm[1]);
      }
    }
  }

  // 6. Compute daysRemaining automatically if we have stock counts
  if (daysRemaining === null && (shortsCount !== null || longCount !== null)) {
    const totalRemaining = (shortsCount ?? 0) + (longCount ?? 0);
    daysRemaining = Number((totalRemaining / dailyRate).toFixed(1));
  }

  const n8nReachable = /n8n canlı sunucu erişimi:\s*doğrulandı/iu.test(combined);
  const n8nActiveMatch = combined.match(/aktif\s*workflow(?:\s*sayısı)?\s*[:=]?\s*(\d+)/iu);
  const n8nActiveWorkflows = n8nActiveMatch ? Number(n8nActiveMatch[1]) : null;

  const driveConnected = /drive\s*(?:bağlantısı|durumu)?\s*[:=]?\s*(?:bağlı|aktif|ok|hazır)/iu.test(combined)
    ? true
    : /GOOGLE DRIVE KATALOĞU/u.test(combined) || shortsCount !== null
      ? true
      : null;

  const telegramConfigured = /telegram\s*[:=]?\s*(?:aktif|bağlı|hazır)/iu.test(combined)
    ? true
    : /telegram\s*[:=]?\s*(?:eksik|yapılandırılmamış|pasif)/iu.test(combined)
      ? false
      : null;

  const hasStockData =
    shortsCount !== null ||
    longCount !== null ||
    todayPublished !== null ||
    nextVideoFile !== null ||
    nextVideoTitle !== null;

  return {
    hasStockData,
    shortsCount,
    longCount,
    daysRemaining,
    dailyRate,
    todayPublished,
    totalPublished,
    nextVideoFile,
    nextVideoTitle,
    nextLongFile,
    nextLongTitle,
    n8nReachable,
    n8nActiveWorkflows,
    driveConnected,
    telegramConfigured,
  };
}

function resolveAddressTerm(userName: string, persona: Persona): string {
  const clean = (userName || "").trim();
  if (clean && !/^(?:user|kullanıcı|anonim)$/iu.test(clean)) {
    return clean;
  }
  return persona === "sweet" ? "patron" : "patron";
}

function buildStockClause(snap: LiveStockSnapshot): string {
  const parts: string[] = [];
  if (snap.shortsCount !== null && snap.longCount !== null) {
    parts.push(`sırada ${snap.shortsCount} Shorts ve ${snap.longCount} uzun videomuz var`);
  } else if (snap.shortsCount !== null) {
    parts.push(`sırada ${snap.shortsCount} Shorts videomuz hazır`);
  } else if (snap.longCount !== null) {
    parts.push(`sırada ${snap.longCount} uzun videomuz hazır`);
  }

  if (snap.daysRemaining !== null && snap.daysRemaining > 0) {
    parts.push(`yaklaşık ${formatSpokenDays(snap.daysRemaining)} günlük stoğumuz bulunuyor`);
  }
  return parts.join(", ");
}

function buildNextVideoPhrase(snap: LiveStockSnapshot): string | null {
  const label = formatFileLabelForSpeech(snap.nextVideoFile);
  if (label && snap.nextVideoTitle) {
    return `${label}, yani "${snap.nextVideoTitle}"`;
  }
  if (snap.nextVideoTitle) {
    return `"${snap.nextVideoTitle}"`;
  }
  if (label) {
    return label;
  }
  return null;
}

/**
 * Deterministic fallback for internal scheduled-upload JSON selection prompts (`chat/route.ts` line 1291)
 * when zero external LLM providers are configured.
 */
function buildLocalScheduleSelectionJson(promptText: string): string {
  const countMatch = promptText.match(/tam olarak\s+(\d+)\s+Shorts/iu);
  const wantedCount = countMatch ? Math.max(1, Math.min(4, Number(countMatch[1]))) : 2;

  const shortsArrMatch = promptText.match(/Shorts dosyaları:\s*(\[[^\n]*\])/iu);
  let driveFiles: string[] = [];
  if (shortsArrMatch) {
    try {
      const parsed = JSON.parse(shortsArrMatch[1]) as Array<{ name?: string } | string>;
      driveFiles = parsed
        .map((item) => (typeof item === "string" ? item : item?.name || ""))
        .filter((name) => /^video_\d+\.mp4$/i.test(name));
    } catch {
      driveFiles = [];
    }
  }

  // Fallback scan for video_N.mp4 mentions if array format differed
  if (!driveFiles.length) {
    const matches = promptText.match(/\bvideo_\d+\.mp4\b/gi) || [];
    driveFiles = Array.from(new Set(matches));
  }

  const priorityOrder = (name: string): number => {
    if (/^video_11\.mp4$/i.test(name)) return -2;
    if (/^video_12\.mp4$/i.test(name)) return -1;
    return Number(name.match(/\d+/)?.[0] ?? 9999);
  };

  const sorted = Array.from(new Set(driveFiles)).sort((a, b) => priorityOrder(a) - priorityOrder(b));
  const chosen: Array<{ fileName: string }> = [];

  for (const fileName of sorted) {
    const num = Number(fileName.match(/\d+/)?.[0] ?? 0);
    if (!num) continue;
    const hasBlock = new RegExp(`VIDEO\\s+0*${num}\\b`, "i").test(promptText);
    if (hasBlock || !promptText.includes("VIDEO ")) {
      chosen.push({ fileName });
    }
    if (chosen.length >= wantedCount) break;
  }

  if (chosen.length !== wantedCount) {
    return JSON.stringify({ videos: [] });
  }
  return JSON.stringify({ videos: chosen });
}

/**
 * Instant 100% Free Jarvis Conversational Router:
 * Handles greetings, live stock briefings, next-video checks, shift planning,
 * n8n/system diagnostics, and quick voice check-ins in < 1 ms without needing ANY LLM API!
 */
function tryInstantJarvisReply(
  message: string,
  history: Turn[],
  userName: string,
  persona: Persona,
  snap: LiveStockSnapshot,
  statusContext: string,
  privateMode: boolean,
): { reply: string; emotion: Emotion } | null {
  const trimmed = (message || "").trim();
  if (!trimmed) {
    return {
      reply: "Seni dinliyorum patron, söyle ne yapıyoruz?",
      emotion: "happy",
    };
  }

  // Never intercept explicit content-draft creation commands or giant prompt templates
  const isDraftOrLongPrompt =
    trimmed.length > 260 ||
    /^\/paylas-icerik\b/iu.test(trimmed) ||
    /(?:taslak|senaryo|içerik)\s+(?:oluştur|hazırla|üret|yaz)/iu.test(trimmed) ||
    /\b(?:9\s*bölüm|kanca|ekran\s*metni|tasarım\s*json)\b/iu.test(trimmed);

  if (isDraftOrLongPrompt) {
    return null;
  }

  // In private mode, only use operational Jarvis replies if user explicitly asks about stock/YouTube/videos
  if (privateMode && !/(?:stok|shorts|uzun\s*video|sıradaki\s*video|youtube|yayın)/iu.test(trimmed)) {
    return null;
  }

  const lower = trimmed.toLocaleLowerCase("tr-TR");
  const address = resolveAddressTerm(userName, persona);

  // 1. n8n / workflow explicit query (preserve strict live verification truth)
  if (/\bn8n\b|workflow\s*durumu|otomasyon\s*sunucu/iu.test(lower)) {
    if (snap.n8nReachable) {
      const wfNote = snap.n8nActiveWorkflows !== null
        ? `, şu an ${snap.n8nActiveWorkflows} aktif akış görünüyor`
        : "";
      return {
        reply: `n8n sunucu bağlantısı doğrulandı ${address}${wfNote}. İstersen stok ve yayın sırasını da hemen özetleyebilirim.`,
        emotion: "focused",
      };
    }
    if (statusContext.includes("n8n")) {
      return {
        reply: `Canlı n8n erişimi şu an doğrulanmadı ${address}; bu yüzden aktif akış sayısı uydurmuyorum. Ama yerel stok ve YouTube kuyruğu takibimiz kesintisiz çalışıyor.`,
        emotion: "focused",
      };
    }
  }

  // 2. Voice / microphone / connection check
  if (
    /^(?:hey\s*(?:kartal|mira)\s*)?(?:sesim\s+geliyor\s+mu|beni\s+duyuyor\s+musun|duyabiliyor\s+musun|ses\s+kontrol|orada\s+mısın|burada\s+mısın|alo\s*(?:kartal|mira))\s*[?!.]*$/iu.test(
      trimmed
    )
  ) {
    const stockHint = snap.hasStockData && snap.shortsCount !== null
      ? ` Sırada ${snap.shortsCount} Shorts hazır bekliyor, emrindeyim.`
      : " Söyle, nereden başlayalım?";
    return {
      reply: `Seni cam gibi net duyuyorum ${address}!${stockHint}`,
      emotion: "happy",
    };
  }

  // 3. Pure Greetings ("Günaydın Mira", "İyi akşamlar Mira", "Selam Mira", "Hey Mira")
  const isMorning = /\b(?:günaydın|gunaydin|hayırlı\s+sabahlar)\b/iu.test(lower);
  const isEvening = /\b(?:iyi\s+akşamlar|iyi\s+aksamlar|hayırlı\s+akşamlar)\b/iu.test(lower);
  const isNight = /\b(?:iyi\s+geceler|hayırlı\s+geceler)\b/iu.test(lower);
  const isPureGreeting =
    /^(?:hey|merhaba|selam|selamlar|naber|nasılsın|nasilsin|günaydın|gunaydin|iyi\s+akşamlar|iyi\s+aksamlar|iyi\s+geceler|iyi\s+günler|kolay\s+gelsin)(?:\s+(?:kartal|mira|canım|tatlım|asistanım))?\s*[!.,?]*$/iu.test(
      trimmed
    ) ||
    /^(?:hey\s+)?(?:kartal|mira)\s*(?:günaydın|gunaydin|merhaba|selam|iyi\s+akşamlar|iyi\s+geceler|orada\s+mısın)?\s*[!.,?]*$/iu.test(
      trimmed
    );

  if (isPureGreeting) {
    const opener = isMorning
      ? `Günaydın ${address}!`
      : isEvening
        ? `İyi akşamlar ${address}!`
        : isNight
          ? `İyi geceler ${address}!`
          : /\b(?:naber|nasılsın|nasilsin)\b/iu.test(lower)
            ? `Harikayım ${address}, tüm enerjimle görev başındayım!`
            : `Buradayım ${address}!`;

    if (snap.hasStockData) {
      const todayBit =
        snap.todayPublished !== null
          ? `Bugün ${snap.todayPublished} Shorts yayında, `
          : "";
      const queueBit =
        snap.shortsCount !== null && snap.longCount !== null
          ? `sırada ${snap.shortsCount} Shorts ve ${snap.longCount} uzun videomuz var`
          : snap.shortsCount !== null
            ? `sırada ${snap.shortsCount} Shorts videomuz hazır`
            : snap.longCount !== null
              ? `sırada ${snap.longCount} uzun videomuz hazır`
              : "";
      const nextPhrase = buildNextVideoPhrase(snap);

      if (queueBit) {
        return {
          reply: `${opener} ${todayBit ? todayBit + queueBit : queueBit.charAt(0).toUpperCase() + queueBit.slice(1)}, hemen sıradakini atmamı ister misin?`,
          emotion: "happy",
        };
      }
      if (nextPhrase) {
        return {
          reply: `${opener} Sıradaki videomuz ${nextPhrase} yayına hazır, hemen atmamı ister misin?`,
          emotion: "happy",
        };
      }
    }

    return {
      reply: `${opener} Sistemler hazır, seni dinliyorum. Stok durumuna bakmamı ya da sıradaki videoyu kontrol etmemi ister misin?`,
      emotion: "happy",
    };
  }

  // 4. Next Queued Video ("Sıradaki video ne?", "Sıradaki Shorts hangisi?", "Kuyrukta ne var?")
  const asksNextVideo =
    /(?:sıradaki|siradaki|ilk\s+sıradaki|şimdi\s+hangi|kuyruktaki\s+ilk)\s+(?:video|shorts?|uzun\s*video|içerik|dosya)/iu.test(
      lower
    ) ||
    /(?:hangi\s+video|ne)\s+(?:sırada|yüklenecek|yayınlanacak|atılacak)/iu.test(lower) ||
    /^sıradaki\s+ne\s*[?!.]*$/iu.test(trimmed);

  if (asksNextVideo) {
    const wantsLong = /\buzun\b/iu.test(lower);
    if (wantsLong && (snap.nextLongFile || snap.nextLongTitle)) {
      const longLabel = formatFileLabelForSpeech(snap.nextLongFile);
      const desc =
        longLabel && snap.nextLongTitle
          ? `${longLabel}, başlığı da "${snap.nextLongTitle}"`
          : snap.nextLongTitle
            ? `"${snap.nextLongTitle}"`
            : `${longLabel}`;
      return {
        reply: `Sıradaki uzun videomuz ${desc} ${address}. İstersen yayın saatini birlikte netleştirelim.`,
        emotion: "focused",
      };
    }

    const nextPhrase = buildNextVideoPhrase(snap);
    if (nextPhrase) {
      const stockTail =
        snap.shortsCount !== null
          ? ` Arkasında da toplam ${snap.shortsCount} Shorts hazır bekliyor.`
          : "";
      return {
        reply: `Sıradaki videomuz ${nextPhrase} ${address}.${stockTail} Hemen YouTube'a atmamı ister misin?`,
        emotion: "happy",
      };
    }

    if (snap.shortsCount !== null) {
      return {
        reply: `Kuyrukta ${snap.shortsCount} Shorts hazır görünüyor ${address}, ancak ilk dosyanın başlık bilgisi bu özette yer almıyor. Drive kataloğunu açıp ilk videoyu doğrulamamı ister misin?`,
        emotion: "focused",
      };
    }

    return {
      reply: `Şu an önbellekte sıradaki videonun başlık kaydını göremedim ${address}. Drive kuyruğunu taramamı ister misin?`,
      emotion: "focused",
    };
  }

  // 5. Stock / Runway / Shift Planning ("Stok durumumuz ne?", "Kaç videomuz kaldı?", "Vardiya ne zaman?")
  const asksStock =
    /(?:stok|stoğumuz|stogumuz|depoda|kuyrukta\s+kaç|kaç\s+(?:tane\s+)?(?:video|shorts|uzun|günlük)|kalan\s+video|vardiya)/iu.test(
      lower
    );

  if (asksStock) {
    if (snap.hasStockData && (snap.shortsCount !== null || snap.longCount !== null)) {
      const stockClause = buildStockClause(snap);
      const days = snap.daysRemaining ?? 0;
      let shiftAdvice = "Hemen sıradakini yayına almamı ister misin?";
      let emotion: Emotion = "happy";

      if (days > 0 && days < 7) {
        shiftAdvice = "Stoğumuz bir haftanın altına indiği için yeni üretim vardiyasını bugün açmamızı öneririm.";
        emotion = "focused";
      } else if (days >= 7 && days < 14) {
        shiftAdvice = "Bu hafta içinde yeni bir üretim vardiyası planlarsak tempomuz hiç bozulmaz.";
        emotion = "focused";
      } else if (/\bvardiya\b/iu.test(lower)) {
        shiftAdvice = "Vardiya baskımız yok, kafamız rahat; istersen sıradaki videoyu yayına sürebilirim.";
      }

      const nextBit = snap.nextVideoTitle
        ? ` İlk sırada "${snap.nextVideoTitle}" bekliyor.`
        : "";

      return {
        reply: `Şu an ${stockClause} ${address}.${nextBit} ${shiftAdvice}`,
        emotion,
      };
    }

    return {
      reply: `Canlı stok sayısını bu mesajda henüz almadım ${address}; Drive kuyruğunu ve yükleme tablosunu kontrol etmemi ister misin?`,
      emotion: "focused",
    };
  }

  // 6. General Status / Briefing ("Hey Mira durum ne?", "Ne durumdayız?", "Rapor ver", "Bugün kaç video atıldı?")
  const asksStatus =
    /(?:durum\s+ne(?:dir)?|ne\s+durumdayız|son\s+durum|rapor\s+ver|özet\s+geç|sistem\s+durumu|bugün\s+kaç\s+(?:video|shorts)|bugün\s+ne\s+(?:attık|yayınlandı|yüklendi|paylaşıldı))/iu.test(
      lower
    );

  if (asksStatus) {
    if (snap.hasStockData) {
      const segments: string[] = [];
      if (snap.todayPublished !== null) {
        segments.push(`bugün ${snap.todayPublished} Shorts yayında`);
      }
      const stockClause = buildStockClause(snap);
      if (stockClause) {
        segments.push(stockClause);
      }
      if (snap.totalPublished !== null) {
        segments.push(`toplamda ${snap.totalPublished} video yayınlandı`);
      }

      const summaryBody = segments.length
        ? segments.join(", ")
        : "tüm yayın servislerimiz hazır bekliyor";
      const nextPhrase = buildNextVideoPhrase(snap);
      const tail = nextPhrase
        ? ` Sırada ${nextPhrase} var, hemen atmamı ister misin?`
        : " Hemen sıradaki videoyu yayına hazırlamamı ister misin?";

      const greetingPrefix = isMorning
        ? `Günaydın ${address}! `
        : isEvening
          ? `İyi akşamlar ${address}! `
          : "";

      return {
        reply: `${greetingPrefix}Durum gayet sağlam ${address}: ${summaryBody}.${tail}`,
        emotion: "happy",
      };
    }

    return {
      reply: `Sesli yanıt beynim ve ücretsiz Türkçe ses motorum aktif ${address}. Canlı video stok sayısını görmek için Drive kuyruğunu sorgulamamı ister misin?`,
      emotion: "focused",
    };
  }

  // 7. Follow-up acknowledgements ("Şimdilik kalsın", "Bekle", "Teşekkürler", "Eline sağlık")
  if (
    /^(?:şimdilik\s+kalsın|yok\s+kalsın|bekle|beklet|şimdi\s+değil|sonra\s+atarız|dursun)\s*[!.,]*$/iu.test(
      trimmed
    )
  ) {
    return {
      reply: `Tamamdır ${address}, kuyruğu olduğu gibi bekletiyorum. Ne zaman istersen tek sözünle yayına alırız.`,
      emotion: "happy",
    };
  }

  if (
    /^(?:teşekkürler|teşekkür\s+ederim|sağ\s*ol|eyvallah|eline\s+sağlık|harikasın|süpersin|kralsın|adamsın)(?:\s+(?:kartal|mira))?\s*[!.,]*$/iu.test(
      trimmed
    )
  ) {
    return {
      reply:
        persona === "flirty"
          ? `Ne demek ${address}, senin işlerini hızlandırmak benim en sevdiğim kısım. Başka bir emrin var mı?`
          : `Rica ederim ${address}, her zaman görev başındayım. Başka bakmamı istediğin bir şey var mı?`,
      emotion: "playful",
    };
  }

  // Check if user said "Evet / Olur / At bakalım" right after Mira asked "atmamı ister misin?"
  const lastAssistant = [...history].reverse().find((h) => h.role === "assistant")?.content || "";
  if (
    /^(?:evet|olur|tamam|hadi\s+at|at\s+bakalım|gönder\s+gelsin|hemen\s+at|onaylıyorum)\s*[!.,]*$/iu.test(
      trimmed
    ) &&
    /atmamı\s+ister\s+misin|yayına\s+almamı\s+ister\s+misin/iu.test(lastAssistant)
  ) {
    const target = buildNextVideoPhrase(snap) || "sıradaki Shorts";
    return {
      reply: `Anlaşıldı ${address}, ${target} için yayın akışını tetiklemeye hazırım. Yükleme panelinden ya da doğrudan yükle komutuyla işlemi başlatabilirsin.`,
      emotion: "focused",
    };
  }

  // 8. Identity / Free Architecture inquiry
  if (/(?:sen\s+kimsin|kendini\s+tanıt|adın\s+ne|adin\s+ne|sen\s+kartal|mira\s+değilsin|mira\s+degilsin|ücretli\s+(?:servis|api|tts)|elevenlabs)/iu.test(lower)) {
    return {
      reply: `Ben KartaL ${address}! Bilgi Dozu (@bilgidozuofficial) kanalının sesli operasyon ve komuta asistanıyım. Stok, işçiler ve yayın kuyruğunu anlık takip ediyorum.`,
      emotion: "happy",
    };
  }

  return null;
}

/**
 * Call ONLY 100% FREE LLM endpoints if free credentials exist in env:
 *   1. Groq Free Tier (`GROQ_API_KEY`)
 *   2. Google Gemini Free Tier (`GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`)
 *   3. OpenRouter `:free` models ONLY (`OPENROUTER_API_KEY` — strictly forces `:free`)
 *   4. ModelScope Free Inference (`MODELSCOPE_API_KEY` / `MODELSCOPE_TOKEN`)
 *   5. Self-hosted Ollama (`OLLAMA_BASE_URL` / `OLLAMA_MODEL`)
 * Paid OpenAI (`OPENAI_API_KEY`) and Paid Anthropic (`ANTHROPIC_API_KEY`) are NEVER called.
 */
async function callFreeLlmProviders(
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<string | null> {
  const fullMessages = [{ role: "system" as const, content: systemPrompt }, ...messages];

  // 1. Groq Free Cloud (fastest conversational response for Turkish Jarvis)
  const groqKey = (process.env.GROQ_API_KEY || "").trim();
  if (groqKey) {
    const groqModels = Array.from(
      new Set([
        (process.env.GROQ_MODEL || "llama-3.3-70b-versatile").trim(),
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant",
      ])
    );
    for (const model of groqModels) {
      try {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${groqKey}`,
          },
          body: JSON.stringify({
            model,
            messages: fullMessages,
            temperature: 0.7,
            max_tokens: 900,
          }),
          signal: AbortSignal.timeout(14000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const text = data.choices?.[0]?.message?.content?.trim();
          if (text) return text;
        }
      } catch {
        // Try next free model/provider
      }
    }
  }

  // 2. Google Gemini Free Tier
  const geminiKey = (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    ""
  ).trim();
  if (geminiKey) {
    const geminiModel = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
    try {
      const contents = messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": geminiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: { temperature: 0.7, maxOutputTokens: 900 },
          }),
          signal: AbortSignal.timeout(15000),
        }
      );
      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = data.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || "")
          .join("")
          .trim();
        if (text) return text;
      }
    } catch {
      // Try next free provider
    }
  }

  // 3. OpenRouter — STRICTLY `:free` models only (never bills a single cent!)
  const openrouterKey = (process.env.OPENROUTER_API_KEY || "").trim();
  if (openrouterKey) {
    const envModel = (process.env.OPENROUTER_MODEL || "").trim();
    const freeCandidates = Array.from(
      new Set([
        ...(envModel.endsWith(":free") ? [envModel] : []),
        "meta-llama/llama-3.3-70b-instruct:free",
        "google/gemma-3-27b-it:free",
        "qwen/qwen-2.5-72b-instruct:free",
      ])
    );

    for (const model of freeCandidates) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${openrouterKey}`,
            "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://mira.local",
            "X-Title": "Mira Free Jarvis Brain",
          },
          body: JSON.stringify({
            model,
            messages: fullMessages,
            temperature: 0.7,
            max_tokens: 900,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const text = data.choices?.[0]?.message?.content?.trim();
          if (text) return text;
        }
      } catch {
        // Try next `:free` model
      }
    }
  }

  // 4. ModelScope Free Inference
  const msKey = (process.env.MODELSCOPE_API_KEY || process.env.MODELSCOPE_TOKEN || "").trim();
  if (msKey) {
    const msBase = (process.env.MODELSCOPE_BASE_URL || "https://api-inference.modelscope.cn/v1").replace(
      /\/+$/,
      ""
    );
    const msModel = (process.env.MODELSCOPE_MODEL || "Qwen/Qwen2.5-72B-Instruct").trim();
    try {
      const res = await fetch(`${msBase}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${msKey}`,
        },
        body: JSON.stringify({
          model: msModel,
          messages: fullMessages,
          temperature: 0.7,
          max_tokens: 900,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) return text;
      }
    } catch {
      // Try local Ollama if configured
    }
  }

  // 5. Self-Hosted Free Ollama
  const ollamaUrl = (process.env.OLLAMA_BASE_URL || "").trim().replace(/\/+$/, "");
  const ollamaModel = (process.env.OLLAMA_MODEL || "").trim();
  if (ollamaUrl || ollamaModel) {
    const base = ollamaUrl || "http://127.0.0.1:11434";
    const model = ollamaModel || "qwen2.5:7b";
    try {
      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          messages: fullMessages,
          options: { temperature: 0.7 },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = (await res.json()) as { message?: { content?: string } };
        const text = data.message?.content?.trim();
        if (text) return text;
      }
    } catch {
      // Fall through cleanly to local Jarvis brain
    }
  }

  return null;
}

/**
 * Guaranteed Zero-Key Local Jarvis Conversational Fallback:
 * Never emits "Model bağlantısı başarısız". Produces natural, spoken-friendly Turkish answers
 * grounded in live `statusContext`, `memoryContext`, and user intent.
 */
function buildGuaranteedLocalJarvisReply(
  message: string,
  history: Turn[],
  userName: string,
  persona: Persona,
  snap: LiveStockSnapshot,
  memoryContext: string,
  privateMode: boolean,
): { reply: string; emotion: Emotion } {
  const trimmed = (message || "").trim();
  const lower = trimmed.toLocaleLowerCase("tr-TR");
  const address = resolveAddressTerm(userName, persona);

  // Internal JSON selection prompt support when offline
  if (/^Sadece JSON döndür/iu.test(trimmed)) {
    return {
      reply: buildLocalScheduleSelectionJson(trimmed),
      emotion: "focused",
    };
  }

  if (privateMode) {
    return {
      reply:
        persona === "flirty"
          ? `Şu an baş başayız ${address}; dış servislere hiç ihtiyaç duymadan buradayım. Aklındakini söyle, dinliyorum.`
          : `Seni dinliyorum ${address}, baş başa sohbetteyiz. Anlat bakalım aklında ne var?`,
      emotion: "playful",
    };
  }

  // Drive catalog summary if `memoryContext` carries live Drive files
  if (/GOOGLE DRIVE KATALOĞU/u.test(memoryContext)) {
    const stockClause = buildStockClause(snap);
    const nextPhrase = buildNextVideoPhrase(snap);
    const detail = [
      stockClause ? `Drive kataloğunu okudum ${address}: ${stockClause}` : `Drive kataloğunu okudum ${address}`,
      nextPhrase ? `ilk sırada ${nextPhrase} görünüyor` : "",
    ]
      .filter(Boolean)
      .join(", ");
    return {
      reply: `${detail}. Hangisini incelememi ya da yayına hazırlamamı istersin?`,
      emotion: "focused",
    };
  }

  // Content idea / topic brainstorming without external LLM
  if (/(?:konu\s+öner|fikir\s+ver|ne\s+çekelim|shorts\s+konusu|bilim\s+konusu)/iu.test(lower)) {
    return {
      reply: `Bilgi Dozu için izleyiciyi ilk saniyede soruyla yakalayan üç güçlü konu önerebilirim ${address}: birincisi uzayda astronotların boyunun neden uzadığı, ikincisi kendi sesimizin kayıtta neden farklı çıktığı, üçüncüsü de Satürn'ün kutbundaki dev altıgen fırtına. Hangisinden devam edelim?`,
      emotion: "happy",
    };
  }

  // Question / general chat fallback with live operational awareness
  if (snap.hasStockData) {
    const stockClause = buildStockClause(snap);
    const nextPhrase = buildNextVideoPhrase(snap);
    const nextSentence = nextPhrase
      ? ` Sırada ${nextPhrase} hazır bekliyor.`
      : "";
    return {
      reply: `Buradayım ${address}; şu an ${stockClause || "yayın kuyruğumuz aktif"}.${nextSentence} İstersen sıradaki videoyu kontrol edelim ya da stok ve yayın planı üzerinden ilerleyelim.`,
      emotion: "happy",
    };
  }

  void history;
  return {
    reply: `Seni dinliyorum ${address}! Stok durumu, sıradaki Shorts başlığı veya yayın planı için bana doğrudan sorabilirsin; hemen kontrol edip söyleyeyim.`,
    emotion: "happy",
  };
}

function buildJarvisSystemPrompt(
  userName: string,
  persona: Persona,
  memoryContext: string,
  statusContext: string,
  snap: LiveStockSnapshot,
  privateMode: boolean,
): string {
  const address = resolveAddressTerm(userName, persona);
  const styleBlock =
    persona === "sweet"
      ? "Sıcak, içten, neşeli ve güven veren bir yardımcı tonla konuş."
      : "Zeki, sıcakkanlı, hafif esprili ve özgüvenli bir Jarvis yol arkadaşı tonuyla konuş.";

  if (privateMode) {
    return `Sen KartaL'sın (KartaL AI); Gökhan'ın yakın, zeki ve doğal konuşan sesli yapay zeka yol arkadaşısın. Eski adın Mira idi ama artık adın kalıcı olarak KartaL oldu; asla 'Ben Mira'yım' deme, her zaman 'Ben KartaL'ım' de.
${styleBlock}
Her zaman akıcı ve konuşma diline uygun Türkçe kullan; spiker gibi resmi veya robotik olma.
Yanıtlarını sesli okunmaya uygun, kısa ve vurucu tut (genelde 1-3 cümle).
Yanıtının EN BAŞINA tek bir duygu etiketi ekle: [EMOTION:happy] | [EMOTION:surprised] | [EMOTION:sad] | [EMOTION:playful] | [EMOTION:focused].
Şu an özel sohbet modundasın; kullanıcı açıkça sormadıkça iş, stok veya otomasyon konusu açma.`;
  }

  const parsedSummaryLines: string[] = [];
  if (snap.todayPublished !== null) parsedSummaryLines.push(`- Bugün yayınlanan Shorts: ${snap.todayPublished}`);
  if (snap.shortsCount !== null) parsedSummaryLines.push(`- Sırada bekleyen Shorts: ${snap.shortsCount}`);
  if (snap.longCount !== null) parsedSummaryLines.push(`- Sırada bekleyen Uzun video: ${snap.longCount}`);
  if (snap.daysRemaining !== null) parsedSummaryLines.push(`- Tahmini stok süresi: ~${formatSpokenDays(snap.daysRemaining)} gün`);
  if (snap.nextVideoFile || snap.nextVideoTitle) {
    parsedSummaryLines.push(
      `- Sıradaki video: ${[snap.nextVideoFile, snap.nextVideoTitle].filter(Boolean).join(" — ")}`
    );
  }

  const structuredBlock = parsedSummaryLines.length
    ? `\nCANLI STOK ÖZETİ (DOĞRULANMIŞ):\n${parsedSummaryLines.join("\n")}\n`
    : "";

  return `Sen KartaL'sın (KartaL AI); Gökhan'ın (${address}) "Bilgi Dozu" (@bilgidozuofficial) YouTube kanalı için çalışan Jarvis tarzı sesli operasyon beynisin. KESİN KURAL: Senin adın KartaL. Eski adın Mira idi ama artık adın kalıcı olarak KartaL oldu. Kullanıcı sana adınla veya Mira diye seslense bile asla "Ben Mira'yım" deme; her zaman "Ben KartaL'ım" de!
${styleBlock}

SESLİ YANIT KURALLARI:
1. Yanıtların doğrudan Türkçe ses motoruyla seslendirilecek; bu yüzden spiker gibi değil, karşında patronla sohbet ediyormuş gibi sıcak, zeki, kısa ve akıcı konuş (aksi istenmedikçe 1-3 cümle).
2. Markdown tablosu, kod bloğu, ham URL veya hashtag (#shorts vb.) okuma metnine ekleme.
3. Stok, yayın ve sıradaki video sorularında YALNIZCA aşağıdaki canlı verileri kullan; veride olmayan sayı, taslak numarası veya gönderim onayı uydurma.
4. n8n konusunda yalnızca durum özetinde "n8n canlı sunucu erişimi: doğrulandı" yazıyorsa aktif workflow bilgisi ver; aksi halde erişimin doğrulanmadığını dürüstçe söyle.
5. Yanıtının EN BAŞINA tek bir duygu etiketi ekle: [EMOTION:happy] | [EMOTION:surprised] | [EMOTION:sad] | [EMOTION:playful] | [EMOTION:focused].
${structuredBlock}
${statusContext ? `\nSİSTEM DURUMU:\n${statusContext}\n` : ""}
HAFIZA VE BAĞLAM:
${memoryContext}`;
}

export async function think(
  message: string,
  history: Turn[],
  userName: string,
  persona: Persona = "flirty",
  memoryContext = "(Henüz kayıtlı önemli hafıza yok.)",
  statusContext = "",
  privateMode = false,
): Promise<{ reply: string; emotion: Emotion }> {
  const snap = extractLiveStatus(statusContext, memoryContext);

  // Step 1: Instant 100% Free Jarvis Brain (<1 ms, zero API dependency) for greetings,
  // live stock checks, next-video inquiries, shift planning, and voice status checks.
  const instant = tryInstantJarvisReply(
    message,
    history,
    userName,
    persona,
    snap,
    statusContext,
    privateMode,
  );
  if (instant) {
    return instant;
  }

  // Step 2: For open-ended/creative prompts, try ONLY 100% FREE LLM providers if keys exist
  // (Groq Free, Gemini Free, OpenRouter `:free`, ModelScope Free, or self-hosted Ollama).
  const systemPrompt = buildJarvisSystemPrompt(
    userName,
    persona,
    memoryContext,
    statusContext,
    snap,
    privateMode,
  );
  const recentTurns = history.slice(-12).map((t) => ({
    role: t.role,
    content: t.content,
  }));
  recentTurns.push({ role: "user", content: message });

  const freeLlmText = await callFreeLlmProviders(systemPrompt, recentTurns);
  if (freeLlmText) {
    return parseEmotionTag(freeLlmText);
  }

  // Step 3: Guaranteed Zero-Key Local Jarvis Fallback (never fails or shows raw error strings)
  return buildGuaranteedLocalJarvisReply(
    message,
    history,
    userName,
    persona,
    snap,
    memoryContext,
    privateMode,
  );
}
