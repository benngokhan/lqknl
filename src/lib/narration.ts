// Tek noktadan Türkçe seslendirme + senkron altyazı üretimi.
// Varsayılan zincir ücretsizdir: Edge TTS, ardından Google TTS.
// Ücretli ElevenLabs yalnızca MIRA_ALLOW_PAID_TTS=true açıkça ayarlanırsa kullanılır.
// Edge TTS'nin kelime zaman damgaları (offset/duration 100ns tick) altyazı gruplarına dönüştürülür.

export type CaptionGroup = { start: number; end: number; text: string };
export type MiraTtsEmotion = "happy" | "surprised" | "sad" | "playful" | "focused";
export type MiraSolMode = "sweet" | "flirty" | "serious" | "excited" | "close";
export type NarrationOptions = { emotion?: MiraTtsEmotion; solMode?: MiraSolMode };

export type NarrationResult = {
  audio: Uint8Array;
  provider: string;
  captions: CaptionGroup[];
  // Kelime zamanlarından ölçülen gerçek konuşma süresi (saniye).
  // ElevenLabs zaman damgası vermediğinde null; render servisi dosyadan ölçer.
  durationSeconds: number | null;
};

const EDGE_TTS_VOICE = process.env.EDGE_TTS_VOICE || "tr-TR-EmelNeural";
const EDGE_TTS_RATE = process.env.EDGE_TTS_RATE || "+5%";
const MAX_GROUPS = 24;
const MAX_GROUP_CHARS = 44;
const MAX_GROUP_WORDS = 4;

function stripForTts(text: string) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>~]/g, "")
    .replace(/[️\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export async function generateWithElevenLabs(text: string): Promise<Uint8Array> {
  const key = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voiceId) throw new Error("ElevenLabs API key veya voice ID ayarlı değil");

  const modelId = process.env.ELEVENLABS_MODEL_ID || process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text, model_id: modelId, language_code: "tr", voice_settings: { speed: 1.05 } }),
      signal: AbortSignal.timeout(45000),
      cache: "no-store",
    },
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`ElevenLabs HTTP ${response.status}: ${detail}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("audio/")) {
    throw new Error("ElevenLabs ses yerine beklenmeyen veri döndürdü");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error("ElevenLabs boş ses verisi döndürdü");
  return bytes;
}

type EdgeWord = { offset: number; duration: number; text: string };

function groupWords(words: EdgeWord[]): CaptionGroup[] {
  const groups: CaptionGroup[] = [];
  let current: EdgeWord[] = [];
  const flush = (tail = 0.12) => {
    if (!current.length) return;
    const last = current[current.length - 1];
    groups.push({
      start: Math.max(0, current[0].offset / 1e7 - 0.03),
      end: (last.offset + last.duration) / 1e7 + tail,
      text: current.map((w) => w.text).join(" "),
    });
    current = [];
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    current.push(word);
    const next = words[i + 1];
    // Edge TTS sözcük arası boşlukları: cümle sonu ~350ms+, virgül ~120ms, normal 0-15ms.
    const gapSeconds = next ? (next.offset - (word.offset + word.duration)) / 1e7 : 0;
    const sentenceBreak = gapSeconds > 0.3;
    const joined = current.map((w) => w.text).join(" ");
    if (sentenceBreak || joined.length >= MAX_GROUP_CHARS || current.length >= MAX_GROUP_WORDS) {
      flush(sentenceBreak ? Math.min(Math.max(gapSeconds - 0.08, 0.1), 0.55) : 0.12);
    }
  }
  flush(0.3);
  // Grup sayısı sınırlıysa kısa grupları birleştirerek baştan tut
  while (groups.length > MAX_GROUPS) {
    groups.splice(-2, 2, {
      start: groups[groups.length - 2].start,
      end: groups[groups.length - 1].end,
      text: (groups[groups.length - 2].text + " " + groups[groups.length - 1].text).slice(0, 180),
    });
  }
  // Çakışma olmasın
  for (let i = 1; i < groups.length; i++) {
    if (groups[i].start < groups[i - 1].end) groups[i].start = groups[i - 1].end + 0.02;
  }
  return groups;
}

export async function generateWithEdgeTts(text: string, rate = EDGE_TTS_RATE): Promise<{ audio: Uint8Array; captions: CaptionGroup[]; durationSeconds: number | null }> {
  const { EdgeTTS } = await import("@andresaya/edge-tts");
  const tts = new EdgeTTS();
  await tts.synthesize(text, EDGE_TTS_VOICE, {
    rate,
    outputFormat: "audio-24khz-96kbitrate-mono-mp3",
  });
  const audio = tts.toBuffer();
  if (!audio.length) throw new Error("Edge TTS boş ses verisi döndürdü");
  const words: EdgeWord[] = (tts.getWordBoundaries() || [])
    .filter((w) => typeof w.text === "string" && Number.isFinite(w.offset) && Number.isFinite(w.duration))
    .map((w) => ({ offset: w.offset, duration: w.duration, text: w.text as string }));
  const last = words[words.length - 1];
  return {
    audio,
    captions: groupWords(words),
    durationSeconds: last ? Math.round(((last.offset + last.duration) / 1e7) * 100) / 100 : null,
  };
}

/**
 * SON CAN SİMİDİ: keysiz Google Translate TTS (client=tw-ob). Edge TTS'nin
 * protokolü Microsoft tarafında 403'e kapandığında zincirin koptuğu yer.
 * Parça parça (≤170kr) alınır, MP3'ler uç uca eklenir. Altyazı zamanlaması yoktur
 * (render servisi dosya süresini kendi ölçer).
 */
export async function generateWithGoogleTts(text: string): Promise<Uint8Array> {
  const chunks: string[] = [];
  let bucket = "";
  for (const piece of text.split(/(?<=[.!?,;:\n—])/)) {
    if ((bucket + piece).length > 170 && bucket.trim()) {
      chunks.push(bucket.trim());
      bucket = piece;
    } else {
      bucket += piece;
    }
  }
  if (bucket.trim()) chunks.push(bucket.trim());

  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=tr&total=1&idx=0&textlen=${chunk.length}&q=${encodeURIComponent(chunk)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://translate.google.com/",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Google TTS HTTP ${res.status} döndürdü`);
    parts.push(Buffer.from(await res.arrayBuffer()));
  }
  const audio = Buffer.concat(parts);
  if (!audio.length) throw new Error("Google TTS boş ses verisi döndürdü");
  return new Uint8Array(audio);
}

function emotionAwareRate(options: NarrationOptions): string {
  const baseMatch = EDGE_TTS_RATE.match(/([+-]?\d+(?:\.\d+)?)%/);
  const base = baseMatch ? Number(baseMatch[1]) : 0;
  const emotionDelta: Record<MiraTtsEmotion, number> = {
    happy: 2,
    surprised: 7,
    sad: -9,
    playful: 4,
    focused: -4,
  };
  const modeDelta: Record<MiraSolMode, number> = {
    sweet: -1,
    flirty: -3,
    serious: -2,
    excited: 5,
    close: -2,
  };
  const emotion = options.emotion ?? "happy";
  const mode = options.solMode ?? "close";
  const rate = Math.max(-20, Math.min(20, Math.round(base + emotionDelta[emotion] + modeDelta[mode])));
  return `${rate >= 0 ? "+" : ""}${rate}%`;
}

export async function generateNarration(rawText: string, options: NarrationOptions = {}): Promise<NarrationResult> {
  const text = stripForTts(rawText);
  if (!text) throw new Error("Seslendirilecek metin boş");
  if (text.length > 5000) throw new Error("Metin çok uzun");

  if (process.env.MIRA_ALLOW_PAID_TTS === "true" && process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
    try {
      const audio = await generateWithElevenLabs(text);
      return { audio, provider: "elevenlabs", captions: [], durationSeconds: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Narration] ElevenLabs failed; Edge TTS fallback:", message);
    }
  }
  try {
    const edge = await generateWithEdgeTts(text, emotionAwareRate(options));
    return { audio: edge.audio, provider: "edge-tts", captions: edge.captions, durationSeconds: edge.durationSeconds };
  } catch (edgeError) {
    const message = edgeError instanceof Error ? edgeError.message : String(edgeError);
    console.error("[Narration] Edge TTS failed; Google TTS son can simidi:", message);
  }
  const google = await generateWithGoogleTts(text);
  return { audio: google, provider: "google-tts", captions: [], durationSeconds: null };
}
