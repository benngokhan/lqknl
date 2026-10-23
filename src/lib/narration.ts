import { EdgeTTS } from "@andresaya/edge-tts";

export type CaptionGroup = {
  text: string;
  startSeconds: number;
  endSeconds: number;
  start: number;
  end: number;
};

export type MiraTtsEmotion = "happy" | "surprised" | "sad" | "playful" | "focused";
export type MiraSolMode = "sweet" | "flirty" | "serious" | "excited" | "close";

export type NarrationOptions = {
  emotion?: MiraTtsEmotion;
  solMode?: MiraSolMode;
  /** Optional relative speed multiplier around 1.0 (e.g. 0.92..1.12). */
  rate?: number;
  /** Optional relative pitch multiplier around 1.0 (e.g. 0.95..1.08). */
  pitch?: number;
};

export type NarrationResult = {
  audio: Buffer;
  provider: "elevenlabs" | "edge" | "google";
  captions: CaptionGroup[];
  durationSeconds: number;
};

/**
 * Hard-locked to `false`: Mira strictly uses 100% FREE TTS engines
 * (Microsoft Edge Neural TTS + Google Translate TTS fallback).
 * Paid ElevenLabs calls are permanently disabled even if API keys exist in env.
 */
export const MIRA_ALLOW_PAID_TTS = false as const;

const DEFAULT_TURKISH_VOICE = "tr-TR-EmelNeural";
const BACKUP_MULTILINGUAL_VOICE = "en-US-AvaMultilingualNeural";

type CachedClip = NarrationResult & {
  createdAt: number;
};

const SHORT_SPEECH_CACHE = new Map<string, CachedClip>();
const MAX_CACHE_ENTRIES = 32;
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Clean and normalize Turkish text so neural/fallback TTS reads it like a warm,
 * natural conversational assistant rather than spelling out symbols, markdown, or hashtags.
 */
export function prepareTextForTurkishSpeech(raw: string): string {
  let cleaned = (raw || "")
    // Remove fenced code blocks completely from spoken output
    .replace(/```[\s\S]*?```/g, " ")
    // Keep markdown link labels, drop raw URLs
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
    // Strip inline code ticks & HTML tags
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, " ")
    // Strip trailing/inline hashtags (#bilgidozu #shorts etc.) so TTS doesn't read "diyez"
    .replace(/(?:^|\s)#[a-zA-Z0-9_çğıöşüÇĞİÖŞÜ]+/g, " ")
    // Convert "~23.0" / "~23,0" -> "yaklaşık 23", "~23.5" -> "yaklaşık 23,5" BEFORE stripping markdown
    .replace(/(?<!~)~\s*(\d+)[.,]0\b/g, "yaklaşık $1")
    .replace(/(?<!~)~\s*(\d+)[.,](\d+)\b/g, "yaklaşık $1 virgül $2")
    .replace(/(?<!~)~\s*(\d+)\b/g, "yaklaşık $1")
    // Strip markdown headings, bold/italic/strikethrough markers, blockquotes
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(?:\*+|_+|~{2,})/g, "")
    .replace(/^\s*>\s?/gm, "")
    // Convert redundant ".0" before Turkish unit words ("23.0 Gün" -> "23 Gün")
    .replace(/\b(\d+)[.,]0(?=\s*(?:gün|saat|dakika|saniye|hafta|ay|video|shorts)\b)/giu, "$1")
    // Turn visual separators into natural conversational comma pauses
    .replace(/\s*[·•▪▸►→⟶|—–]\s*/g, ", ")
    // Strip emojis & pictographs
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu, " ")
    // Collapse repeated punctuation & whitespace
    .replace(/,\s*,+/g, ", ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/([,.;!?])(?=[A-Za-zÇĞİÖŞÜçğıöşü])/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();

  // Remove leading/trailing stray commas
  cleaned = cleaned.replace(/^[,;:\s]+|[,;:\s]+$/g, "").trim();
  return cleaned;
}

/**
 * Group individual word boundary timings into 3-4 word readable subtitle phrases.
 */
function groupWordsIntoCaptions(
  boundaries: Array<{ text: string; offsetMs: number; durationMs: number }>
): CaptionGroup[] {
  if (!boundaries.length) return [];
  const groups: CaptionGroup[] = [];
  const chunkSize = 4;

  for (let i = 0; i < boundaries.length; i += chunkSize) {
    const slice = boundaries.slice(i, i + chunkSize);
    const text = slice.map((w) => w.text).join(" ").trim();
    if (!text) continue;
    const startSeconds = slice[0].offsetMs / 1000;
    const last = slice[slice.length - 1];
    const endSeconds = Math.max(startSeconds + 0.25, (last.offsetMs + last.durationMs) / 1000);
    groups.push({
      text,
      startSeconds,
      endSeconds,
      start: startSeconds,
      end: endSeconds,
    });
  }
  return groups;
}

/**
 * Estimate smooth word-group captions & duration when a fallback engine (Google TTS)
 * returns raw MP3 audio without word boundary metadata.
 */
function estimateCaptionsAndDuration(text: string, audioByteLength: number): {
  captions: CaptionGroup[];
  durationSeconds: number;
} {
  const words = text.split(/\s+/).map((w) => w.trim()).filter(Boolean);
  if (!words.length) {
    return { captions: [], durationSeconds: 0 };
  }
  // Google Translate MP3 averages ~64 kbps (8000 bytes/s); blend with ~13.5 chars/s Turkish speech rate
  const byBytes = audioByteLength > 512 ? audioByteLength / 8000 : 0;
  const byChars = Math.max(0.8, text.length / 13.5);
  const durationSeconds = Number((byBytes > 0.4 ? (byBytes * 0.65 + byChars * 0.35) : byChars).toFixed(2));

  const totalChars = Math.max(1, words.reduce((acc, w) => acc + w.length + 1, 0));
  let cursorMs = 0;
  const syntheticBoundaries = words.map((word) => {
    const weight = (word.length + 1) / totalChars;
    const durationMs = Math.max(110, Math.round(durationSeconds * 1000 * weight));
    const item = { text: word, offsetMs: cursorMs, durationMs };
    cursorMs += durationMs;
    return item;
  });

  return {
    captions: groupWordsIntoCaptions(syntheticBoundaries),
    durationSeconds,
  };
}

/**
 * Map Mira's emotion + companion mode into natural conversational prosody
 * (warm, lively, human cadence — never stiff newsreader speed).
 */
export function resolveConversationalProsody(opts?: NarrationOptions): {
  rate: string;
  pitch: string;
  volume: string;
  googleSlow: boolean;
} {
  const emotion: MiraTtsEmotion = opts?.emotion ?? "happy";
  const mode: MiraSolMode = opts?.solMode ?? "flirty";

  const emotionRateDelta: Record<MiraTtsEmotion, number> = {
    happy: 5,
    playful: 7,
    surprised: 8,
    focused: 3, // Jarvis operational clarity: brisk and confident
    sad: -5,
  };

  const modeRateDelta: Record<MiraSolMode, number> = {
    sweet: 0,
    flirty: 1,
    close: -2,
    serious: 0,
    excited: 4,
  };

  const emotionPitchHz: Record<MiraTtsEmotion, number> = {
    happy: 2,
    playful: 4,
    surprised: 5,
    focused: 1,
    sad: -3,
  };

  const modePitchHz: Record<MiraSolMode, number> = {
    sweet: 1,
    flirty: 2,
    close: 0,
    serious: -1,
    excited: 2,
  };

  const explicitRateOffset = typeof opts?.rate === "number" && Number.isFinite(opts.rate)
    ? Math.round((opts.rate - 1) * 100)
    : 0;
  const explicitPitchOffset = typeof opts?.pitch === "number" && Number.isFinite(opts.pitch)
    ? Math.round((opts.pitch - 1) * 40)
    : 0;

  const rateNum = Math.max(
    -18,
    Math.min(20, emotionRateDelta[emotion] + modeRateDelta[mode] + explicitRateOffset),
  );
  const pitchNum = Math.max(
    -12,
    Math.min(12, emotionPitchHz[emotion] + modePitchHz[mode] + explicitPitchOffset),
  );
  const volumeNum = emotion === "sad" ? 0 : 2;

  return {
    rate: rateNum >= 0 ? `+${rateNum}%` : `${rateNum}%`,
    pitch: pitchNum >= 0 ? `+${pitchNum}Hz` : `${pitchNum}Hz`,
    volume: `+${volumeNum}%`,
    googleSlow: emotion === "sad",
  };
}

/**
 * Paid ElevenLabs provider is permanently disabled (`MIRA_ALLOW_PAID_TTS = false`).
 * Kept only to preserve backwards-compatible module exports.
 */
export async function generateWithElevenLabs(_text: string): Promise<NarrationResult> {
  void _text;
  throw new Error(
    "Ücretli TTS (ElevenLabs) kalıcı olarak devre dışı bırakıldı (MIRA_ALLOW_PAID_TTS=false). Mira %100 ücretsiz ses motoru kullanır."
  );
}

/**
 * Primary 100% Free Neural TTS: Microsoft Edge Neural TTS (`tr-TR-EmelNeural`)
 * with automatic retry and multilingual neural voice backup.
 */
export async function generateWithEdgeTts(
  text: string,
  opts?: NarrationOptions
): Promise<NarrationResult> {
  const spokenText = prepareTextForTurkishSpeech(text);
  if (!spokenText) {
    throw new Error("Seslendirilecek metin boş.");
  }

  const preferredVoice = (process.env.EDGE_TTS_VOICE || DEFAULT_TURKISH_VOICE).trim() || DEFAULT_TURKISH_VOICE;
  const prosody = resolveConversationalProsody(opts);

  const candidateVoices = Array.from(
    new Set([preferredVoice, DEFAULT_TURKISH_VOICE, BACKUP_MULTILINGUAL_VOICE])
  );

  const errors: string[] = [];

  for (const voice of candidateVoices) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const tts = new EdgeTTS({ timeout: 18000 });
        await tts.synthesize(spokenText, voice, {
          rate: prosody.rate,
          pitch: prosody.pitch,
          volume: prosody.volume,
          outputFormat: "audio-24khz-96kbitrate-mono-mp3",
          timeout: 18000,
        });

        const audio = tts.toBuffer();
        if (!audio || audio.length < 256) {
          throw new Error(`Edge TTS boş ses döndürdü (${audio?.length ?? 0} bayt)`);
        }

        let rawBounds: Array<{ text: string; offset: number; duration: number }> = [];
        try {
          rawBounds = tts.getWordBoundaries();
        } catch {
          rawBounds = [];
        }

        const boundaries = rawBounds.map((b) => ({
          text: b.text,
          offsetMs: Math.round(b.offset / 10000),
          durationMs: Math.max(80, Math.round(b.duration / 10000)),
        }));

        const captions = boundaries.length > 0
          ? groupWordsIntoCaptions(boundaries)
          : estimateCaptionsAndDuration(spokenText, audio.length).captions;

        const durationSeconds = captions.length > 0
          ? captions[captions.length - 1].endSeconds
          : estimateCaptionsAndDuration(spokenText, audio.length).durationSeconds;

        return {
          audio,
          provider: "edge",
          captions,
          durationSeconds,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${voice}#${attempt}: ${msg}`);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 220));
        }
      }
    }
  }

  throw new Error(`Edge TTS başarısız: ${errors.join(" | ")}`);
}

/**
 * Split Turkish text into natural <= maxLen char chunks at sentence, clause, or word boundaries
 * so Google Translate TTS never truncates or returns HTTP 400 on long sentences.
 */
function splitIntoNaturalTurkishChunks(text: string, maxLen = 165): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= maxLen) return [normalized];

  const rawSentences = normalized.split(/(?<=[.!?…])\s+/);
  const chunks: string[] = [];
  let current = "";

  const pushPiece = (piece: string) => {
    const trimmed = piece.trim();
    if (!trimmed) return;

    if (trimmed.length <= maxLen) {
      if (!current) {
        current = trimmed;
      } else if ((current + " " + trimmed).length <= maxLen) {
        current += " " + trimmed;
      } else {
        chunks.push(current);
        current = trimmed;
      }
      return;
    }

    // Split further by comma/semicolon clauses first
    const clauses = trimmed.split(/(?<=[,;:])\s+/);
    if (clauses.length > 1) {
      for (const clause of clauses) {
        pushPiece(clause);
      }
      return;
    }

    // Hard word-boundary split for ultra-long unpunctuated segments
    const words = trimmed.split(" ");
    for (const word of words) {
      if (!word) continue;
      const safeWord = word.length > maxLen ? word.slice(0, maxLen) : word;
      if (!current) {
        current = safeWord;
      } else if ((current + " " + safeWord).length <= maxLen) {
        current += " " + safeWord;
      } else {
        chunks.push(current);
        current = safeWord;
      }
    }
  };

  for (const sentence of rawSentences) {
    pushPiece(sentence);
  }
  if (current) chunks.push(current);

  return chunks;
}

/**
 * Secondary 100% Free Keyless Fallback: Google Translate Turkish TTS
 * Cascades across 3 public endpoints with no API key required.
 */
export async function generateWithGoogleTts(
  text: string,
  opts?: NarrationOptions
): Promise<NarrationResult> {
  const cleanText = prepareTextForTurkishSpeech(text);
  if (!cleanText) {
    throw new Error("Google TTS için metin boş.");
  }

  const chunks = splitIntoNaturalTurkishChunks(cleanText, 165);
  if (!chunks.length) {
    throw new Error("Google TTS için parça oluşturulamadı.");
  }

  const { googleSlow } = resolveConversationalProsody(opts);
  const speedParam = googleSlow ? "0.8" : "1";

  const buffers: Buffer[] = [];
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    const encoded = encodeURIComponent(chunk);
    const urls = [
      `https://translate.googleapis.com/translate_tts?ie=UTF-8&q=${encoded}&tl=tr&total=${chunks.length}&idx=${idx}&textlen=${chunk.length}&client=gtx&ttsspeed=${speedParam}`,
      `https://clients5.google.com/translate_tts?ie=UTF-8&client=dict-chrome-ex&tl=tr&q=${encoded}&ttsspeed=${speedParam}`,
      `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=tr&client=tw-ob&ttsspeed=${speedParam}`,
    ];

    let chunkAudio: Buffer | null = null;
    let lastStatus = 0;

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            Accept: "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
            Referer: "https://translate.google.com/",
          },
          signal: AbortSignal.timeout(12000),
        });
        lastStatus = res.status;
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 128) {
          chunkAudio = buf;
          break;
        }
      } catch {
        // Move immediately to the next public Google TTS endpoint
      }
    }

    if (!chunkAudio) {
      throw new Error(`Google TTS parça seslendiremedi (HTTP ${lastStatus || "timeout"}).`);
    }
    buffers.push(chunkAudio);
  }

  const audio = Buffer.concat(buffers);
  if (audio.length < 256) {
    throw new Error("Google TTS boş ses verisi döndürdü.");
  }

  const { captions, durationSeconds } = estimateCaptionsAndDuration(cleanText, audio.length);
  return {
    audio,
    provider: "google",
    captions,
    durationSeconds,
  };
}

/**
 * Generate Mira Turkish speech using ONLY 100% FREE providers:
 *   1. Microsoft Edge Neural TTS (`tr-TR-EmelNeural`) with conversational prosody
 *   2. Google Translate Turkish TTS (`gtx` / `dict-chrome-ex` / `tw-ob`) keyless fallback
 * Paid ElevenLabs (`MIRA_ALLOW_PAID_TTS=false`) is permanently disabled.
 */
export async function generateNarration(
  text: string,
  opts?: NarrationOptions
): Promise<NarrationResult> {
  const prepared = prepareTextForTurkishSpeech(text);
  if (!prepared) {
    throw new Error("Seslendirilecek geçerli metin bulunamadı.");
  }

  const cacheKey = prepared.length <= 360
    ? `${opts?.emotion ?? "happy"}|${opts?.solMode ?? "flirty"}|${opts?.rate ?? ""}|${opts?.pitch ?? ""}|${prepared}`
    : "";

  if (cacheKey) {
    const cached = SHORT_SPEECH_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
      return {
        audio: Buffer.from(cached.audio),
        provider: cached.provider,
        captions: cached.captions,
        durationSeconds: cached.durationSeconds,
      };
    }
  }

  const errors: string[] = [];

  // Paid TTS is strictly locked off (`MIRA_ALLOW_PAID_TTS === false`).
  // Step 1: 100% Free Microsoft Edge Neural TTS (Turkish female voice)
  try {
    const edgeResult = await generateWithEdgeTts(prepared, opts);
    if (cacheKey) {
      if (SHORT_SPEECH_CACHE.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = SHORT_SPEECH_CACHE.keys().next().value;
        if (oldestKey) SHORT_SPEECH_CACHE.delete(oldestKey);
      }
      SHORT_SPEECH_CACHE.set(cacheKey, { ...edgeResult, createdAt: Date.now() });
    }
    return edgeResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`EdgeTTS: ${message}`);
    console.warn("[Mira TTS] Edge TTS hatası, ücretsiz Google TTS yedeğine geçiliyor:", message);
  }

  // Step 2: 100% Free Keyless Google Translate TTS fallback
  try {
    const googleResult = await generateWithGoogleTts(prepared, opts);
    if (cacheKey) {
      if (SHORT_SPEECH_CACHE.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = SHORT_SPEECH_CACHE.keys().next().value;
        if (oldestKey) SHORT_SPEECH_CACHE.delete(oldestKey);
      }
      SHORT_SPEECH_CACHE.set(cacheKey, { ...googleResult, createdAt: Date.now() });
    }
    return googleResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`GoogleTTS: ${message}`);
    console.error("[Mira TTS] Google TTS yedeği de başarısız:", message);
  }

  throw new Error(`Ücretsiz TTS sağlayıcıları yanıt veremedi: ${errors.join(" | ")}`);
}
