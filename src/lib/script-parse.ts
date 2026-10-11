// İşçi (worker) tarafından üretilen taslak metnini bölümlerine ayırır.
// Beklenen başlıklar: KANCA, SESLENDİRME, EKRAN METNİ, GÖRSEL TASARIMI,
// SES VE MÜZİK, KAYNAK, AÇIKLAMA, ETİKETLER

const HEADINGS = [
  "KANCA",
  "SESLENDİRME",
  "EKRAN METNİ",
  "GÖRSEL TASARIMI",
  "SES VE MÜZİK",
  "KAYNAK",
  "AÇIKLAMA",
  "ETİKETLER",
] as const;

export type DraftSections = Partial<Record<(typeof HEADINGS)[number], string>>;

export function parseDraftScript(script: string): DraftSections {
  const sections: DraftSections = {};
  // Başlıkları satır başında ara: "SESLENDİRME:", "## SESLENDİRME", "**SESLENDİRME**" vb.
  const headingPattern = new RegExp(
    `^\\s*(?:#{1,4}\\s*|\\*\\*)?\\s*(${HEADINGS.join("|")})\\s*(?:\\*\\*)?\\s*:?\\s*$`,
    "gmi",
  );
  const matches = [...script.matchAll(headingPattern)];
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].toUpperCase() as (typeof HEADINGS)[number];
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? script.length) : script.length;
    const value = script.slice(start, end).trim();
    if (value && !sections[name]) sections[name] = value;
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
 * Seslendirme metnini cümle sınırlarında kırpar: hedef ~44 kelime (≈20sn), tavan 58 (≈26sn).
 * Edge TTS +%5 hızla ölçülen ~2.2 kelime/sn bütçesiyle video 30sn altında kalır.
 * Tek bir şişkin cümle maxWords'ü aşarsa kelime sınırında "…" ile keser.
 */
export function capNarrationForDuration(text: string, opts?: { targetWords?: number; maxWords?: number }) {
  const targetWords = opts?.targetWords ?? 44;
  const maxWords = opts?.maxWords ?? 58;
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
