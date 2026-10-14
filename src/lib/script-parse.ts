// İşçi (worker) tarafından üretilen taslak metnini bölümlerine ayırır.
// Beklenen başlıklar: KANCA, SESLENDİRME, EKRAN METNİ, GÖRSEL TASARIMI,
// SES VE MÜZİK, KAYNAK, AÇIKLAMA, ETİKETLER, TASARIM

export const HEADINGS = [
  "KANCA",
  "SESLENDİRME",
  "EKRAN METNİ",
  "GÖRSEL TASARIMI",
  "SES VE MÜZİK",
  "KAYNAK",
  "AÇIKLAMA",
  "ETİKETLER",
  "TASARIM",
] as const;

export type DraftHeading = (typeof HEADINGS)[number];
export type DraftSections = Partial<Record<DraftHeading, string>>;

function turkishRegexPattern(str: string): string {
  return str
    .replace(/[iIİı]/g, "[iIİı]")
    .replace(/[sSŞş]/g, "[sSŞş]")
    .replace(/[cCÇç]/g, "[cCÇç]")
    .replace(/[gGĞğ]/g, "[gGĞğ]")
    .replace(/[uUÜü]/g, "[uUÜü]")
    .replace(/[oOÖö]/g, "[oOÖö]");
}

export function normalizeHeadingName(raw: string): DraftHeading | null {
  const clean = raw.trim().toLocaleLowerCase("tr-TR");
  for (const h of HEADINGS) if (h.toLocaleLowerCase("tr-TR") === clean) return h;
  return null;
}

const HEADING_PATTERNS = HEADINGS.map(turkishRegexPattern).join("|");

export function parseDraftScript(script: string): DraftSections {
  const sections: DraftSections = {};
  // Markdown, numaralandırma, kalın yazım ve isteğe bağlı (JSON) eki desteklenir.
  const headingPattern = new RegExp(
    `^\\s*(?:#{1,6}\\s*)?(?:\\*{1,3})?\\s*(?:\\d+[\\.\\)]\\s*)?(?:\\*{1,3})?\\s*(${HEADING_PATTERNS})(?:\\s*\\([^)]*\\))?\\s*(?:\\*{1,3})?:?\\s*(?:\\*{1,3})?:?\\s*// İşçi (worker) tarafından üretilen taslak metnini bölümlerine ayırır.
// Beklenen başlıklar: KANCA, SESLENDİRME, EKRAN METNİ, GÖRSEL TASARIMI,
// SES VE MÜZİK, KAYNAK, AÇIKLAMA, ETİKETLER, TASARIM

export const HEADINGS = [
  "KANCA",
  "SESLENDİRME",
  "EKRAN METNİ",
  "GÖRSEL TASARIMI",
  "SES VE MÜZİK",
  "KAYNAK",
  "AÇIKLAMA",
  "ETİKETLER",
  "TASARIM",
] as const;

export type DraftHeading = (typeof HEADINGS)[number];
export type DraftSections = Partial<Record<DraftHeading, string>>;

function turkishRegexPattern(str: string): string {
  return str
    .replace(/[iIİı]/g, "[iIİı]")
    .replace(/[sSŞş]/g, "[sSŞş]")
    .replace(/[cCÇç]/g, "[cCÇç]")
    .replace(/[gGĞğ]/g, "[gGĞğ]")
    .replace(/[uUÜü]/g, "[uUÜü]")
    .replace(/[oOÖö]/g, "[oOÖö]");
}

export function normalizeHeadingName(raw: string): DraftHeading | null {
  const clean = raw.trim().toLocaleLowerCase("tr-TR");
  for (const h of HEADINGS) if (h.toLocaleLowerCase("tr-TR") === clean) return h;
  return null;
}

const HEADING_PATTERNS = HEADINGS.map(turkishRegexPattern).join("|");

export function parseDraftScript(script: string): DraftSections {
  const sections: DraftSections = {};
,
    "gmi",
  );
  const matches = [...script.matchAll(headingPattern)];
  for (let i = 0; i < matches.length; i++) {
    const canonical = normalizeHeadingName(matches[i][1]);
    if (!canonical) continue;
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? script.length) : script.length;
    const value = script.slice(start, end).trim();
    if (value && !sections[canonical]) sections[canonical] = value;
  }
  return sections;
}

// Seslendirme metnini temizle: süre işaretleri, köşeli açıklamalar vb. çıkar
export function extractNarration(script: string, fallback = ""): string {
  const sections = parseDraftScript(script);
  const raw = sections["SESLENDİRME"] || fallback;
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+\s*(?:sn|saniye)|\(\d+[-–]\d+\s*sn\)|\[[^\]]*\]|\([0-9\s\-–]*saniye[0-9\s\-–]*\))\s*[:.)-]*\s*/i, ""))
    .map((line) => line.replace(/^\s*[-*•]\s+/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Seslendirme metnini cümle sınırlarında kırpar: hedef ~72 kelime, tavan 82 kelime.
 * Bilgi Dozu üretim sözleşmesi 35–40 saniyedir; gerçek ses süresi ayrıca QC'de doğrulanır.
 * Tek bir şişkin cümle maxWords'ü aşarsa kelime sınırında "…" ile keser.
 */
export function capNarrationForDuration(text: string, opts?: { targetWords?: number; maxWords?: number }) {
  const targetWords = opts?.targetWords ?? 72;
  const maxWords = opts?.maxWords ?? 82;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return { text: "", wasCapped: false, words: 0 };
  const sentences = cleaned.split(/(?<=[.!?…])\s+/u).map((s) => s.trim()).filter(Boolean);
  const picked: string[] = [];
  let words = 0;
  for (const sentence of sentences) {
    const n = countWords(sentence);
    if (picked.length === 0 && n > maxWords) {
      const tokens = sentence.split(/\s+/).filter(Boolean);
      return { text: tokens.slice(0, targetWords).join(" ") + "…", wasCapped: true, words: targetWords };
    }
    if (picked.length > 0 && words + n > maxWords) break;
    picked.push(sentence);
    words += n;
    if (words >= targetWords) break;
  }
  const result = picked.join(" ");
  return { text: result, wasCapped: result !== cleaned, words };
}
