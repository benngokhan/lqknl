// Tek noktadan Türkçe seslendirme + senkron altyazı üretimi.
// ElevenLabs ana sağlayıcı, Edge TTS yedek. Edge TTS'nin kelime zaman
// damgaları (offset/duration 100ns tick) altyazı gruplarına dönüştürülür.

export type CaptionGroup = { start: number; end: number; text: string };

export type NarrationResult = {
  audio: Uint8Array;
  provider: string;
  captions: CaptionGroup[];
  // Kelime zamanlarından ölçülen gerçek konuşma süresi (saniye).
  // ElevenLabs zaman damgası vermediğinde null; render servisi dosyadan ölçer.
  durationSeconds: number | null;
};

const EDGE_TTS_VOICE = process.env.EDGE_TTS_VOICE || "tr-TR-EmelNeural";
const EDGE_TTS_RATE = process.env.EDGE_TTS_RATE || "+10%";
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

  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text, model_id: modelId, language_code: "tr", voice_settings: { speed: 1.1 } }),
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

export async function generateWithEdgeTts(text: string): Promise<{ audio: Uint8Array; captions: CaptionGroup[]; durationSeconds: number | null }> {
  const { EdgeTTS } = await import("@andresaya/edge-tts");
  const tts = new EdgeTTS();
  await tts.synthesize(text, EDGE_TTS_VOICE, {
    rate: EDGE_TTS_RATE,
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

export async function generateNarration(rawText: string): Promise<NarrationResult> {
  const text = stripForTts(rawText);
  if (!text) throw new Error("Seslendirilecek metin boş");
  if (text.length > 5000) throw new Error("Metin çok uzun");

  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
    try {
      const audio = await generateWithElevenLabs(text);
      return { audio, provider: "elevenlabs", captions: [], durationSeconds: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Narration] ElevenLabs failed; Edge TTS fallback:", message);
    }
  }
  const edge = await generateWithEdgeTts(text);
  return { audio: edge.audio, provider: "edge-tts", captions: edge.captions, durationSeconds: edge.durationSeconds };
}
