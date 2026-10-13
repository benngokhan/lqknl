"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type SpeakerOptions = {
  rate?: number;
  pitch?: number;
  solMode?: "sweet" | "flirty" | "serious" | "excited" | "close";
  emotion?: "happy" | "surprised" | "sad" | "playful" | "focused";
  onEnd?: () => void;
};

export function useSpeaker() {
  const [speaking, setSpeaking] = useState(false);
  const [wordIndex, setWordIndex] = useState(-1);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const ampRef = useRef(0);
  const targetRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    targetRef.current = 0;
    ampRef.current = 0;
  }, []);

  const stop = useCallback(() => {
    try {
      audioSourceRef.current?.stop();
    } catch {
      // The source may already have ended.
    }

    audioSourceRef.current?.disconnect();
    audioSourceRef.current = null;

    try {
      analyserRef.current?.disconnect();
    } catch {
      // Ignore an already-disconnected analyser.
    }

    analyserRef.current = null;
    stopLoop();
    setSpeaking(false);
    setWordIndex(-1);
  }, [stopLoop]);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  const speak = useCallback(
    async (text: string, opts: SpeakerOptions = {}) => {
      stop();
      setVoiceError(null);

      const cleanText = text.trim();
      if (!cleanText) return;

      const words = cleanText.split(/\s+/).filter(Boolean);
      setSpeaking(true);
      setWordIndex(words.length ? 0 : -1);

      let stage:
        | "audiocontext"
        | "fetch"
        | "content-type"
        | "decode"
        | "play" = "audiocontext";

      try {
        if (typeof window === "undefined") {
          throw new Error("Tarayıcı ortamı yok");
        }

        const Ctx =
          window.AudioContext ??
          (window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }).webkitAudioContext;

        if (!Ctx) {
          throw new Error("AudioContext desteklenmiyor");
        }

        if (!audioContextRef.current) {
          audioContextRef.current = new Ctx();
        }

        const ctx = audioContextRef.current;
        if (ctx.state === "suspended") {
          await ctx.resume();
        }

        stage = "fetch";
        const response = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: cleanText,
            solMode: opts.solMode ?? "close",
            emotion: opts.emotion ?? "happy",
          }),
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(
            `/api/tts ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
          );
        }

        stage = "content-type";
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("audio/")) {
          throw new Error(`/api/tts ses yerine ${contentType || "bilinmeyen veri"} döndürdü`);
        }

        stage = "decode";
        const audioData = await response.arrayBuffer();
        const buffer = await ctx.decodeAudioData(audioData.slice(0));

        stage = "play";
        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.72;

        const data = new Uint8Array(analyser.fftSize);
        source.connect(analyser);
        analyser.connect(ctx.destination);

        analyserRef.current = analyser;
        audioSourceRef.current = source;

        const startedAt = performance.now();
        const duration = Math.max(0.1, buffer.duration);

        const finish = () => {
          if (audioSourceRef.current === source) {
            audioSourceRef.current = null;
          }
          stopLoop();
          setSpeaking(false);
          setWordIndex(-1);
          opts.onEnd?.();
        };

        source.onended = finish;
        source.start(0);

        const syncAudio = () => {
          if (audioSourceRef.current !== source) return;

          const elapsed = (performance.now() - startedAt) / 1000;
          const progress = Math.min(1, elapsed / duration);
          const index = Math.min(
            words.length - 1,
            Math.floor(progress * words.length),
          );
          setWordIndex(index);

          analyser.getByteTimeDomainData(data);

          let sum = 0;
          for (let i = 0; i < data.length; i += 1) {
            const value = (data[i] - 128) / 128;
            sum += value * value;
          }

          const rms = Math.sqrt(sum / data.length);
          const speechLevel = Math.min(
            1,
            Math.max(0, (rms - 0.008) / 0.075),
          );

          targetRef.current = 0.08 + speechLevel * 0.92;
          ampRef.current +=
            (targetRef.current - ampRef.current) * 0.35;

          rafRef.current = requestAnimationFrame(syncAudio);
        };

        rafRef.current = requestAnimationFrame(syncAudio);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Mira sunucu TTS kullanılamadı; tarayıcı sesi deneniyor [${stage}]:`, message);
        stopLoop();

        // Keep Mira audible when the server TTS endpoint is not configured.
        // This fallback uses the device's Turkish speech voice, not a cloned voice.
        if (typeof window !== "undefined" && "speechSynthesis" in window) {
          const utterance = new SpeechSynthesisUtterance(cleanText);
          utterance.lang = "tr-TR";
          const emotion = opts.emotion ?? "happy";
          const rateFactor: Record<NonNullable<SpeakerOptions["emotion"]>, number> = {
            happy: 1.02,
            surprised: 1.08,
            sad: 0.9,
            playful: 1.04,
            focused: 0.96,
          };
          const pitchDelta: Record<NonNullable<SpeakerOptions["emotion"]>, number> = {
            happy: 0.03,
            surprised: 0.12,
            sad: -0.12,
            playful: 0.08,
            focused: -0.08,
          };
          utterance.rate = Math.min(2, Math.max(0.5, (opts.rate ?? 1) * rateFactor[emotion]));
          utterance.pitch = Math.min(2, Math.max(0.5, (opts.pitch ?? 1.1) + pitchDelta[emotion]));
          const voices = window.speechSynthesis.getVoices();
          const turkishVoice = voices.find((voice) => voice.lang.toLowerCase().startsWith("tr"));
          if (turkishVoice) utterance.voice = turkishVoice;

          utterance.onstart = () => {
            setVoiceError(null);
            setSpeaking(true);
            setWordIndex(0);
          };
          utterance.onboundary = (event) => {
            if (event.name === "word" && words.length) {
              const spoken = cleanText.slice(0, event.charIndex).trim().split(/\\s+/).filter(Boolean).length;
              setWordIndex(Math.min(words.length - 1, Math.max(0, spoken)));
            }
          };
          utterance.onend = () => {
            setSpeaking(false);
            setWordIndex(-1);
            opts.onEnd?.();
          };
          utterance.onerror = () => {
            setVoiceError("Cihazın Türkçe konuşma sesi de kullanılamıyor.");
            setSpeaking(false);
            setWordIndex(-1);
          };
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(utterance);
          return;
        }

        setVoiceError("Sunucu sesi ayarlanmamış ve bu cihazda tarayıcı konuşma desteği yok.");
        setSpeaking(false);
        setWordIndex(-1);
      }
    },
    [stop, stopLoop],
  );

  return {
    speak,
    stop,
    speaking,
    wordIndex,
    ampRef,
    voiceError,
  };
}
