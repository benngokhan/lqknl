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

  /**
   * Mobil (Android Chrome / iOS Safari) tarayıcılarda kullanıcı küreye dokunduğu
   * saniye (await fetch öncesinde) AudioContext kilidini senkron olarak açar.
   * Böylece /api/chat yanıtı 1-2 sn sonra geldiğinde tarayıcı sesi bloklamaz
   * ve telefonun robotik yerleşik speechSynthesis sesine asla düşmez.
   */
  const unlock = useCallback(() => {
    try {
      if (typeof window === "undefined") return;
      const Ctx =
        window.AudioContext ??
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!audioContextRef.current) {
        audioContextRef.current = new Ctx();
      }
      const ctx = audioContextRef.current;
      if (ctx.state === "suspended") {
        void ctx.resume();
      }
      // 1-sample sessiz buffer ile ses kanalını sıcak tut
      const silent = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = silent;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      // ignore
    }
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

      let stage: "audiocontext" | "fetch" | "content-type" | "decode" | "play" = "audiocontext";

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

        // Stüdyo İnsanlaştırma Zinciri (Warm Vocal EQ + De-Harshing + Soft Compressor):
        // Neural TTS'in metalik 3.2 kHz tizliğini yumuşatır, 210 Hz alt-orta gövde sıcaklığı ekler.
        const warmLow = ctx.createBiquadFilter();
        warmLow.type = "lowshelf";
        warmLow.frequency.value = 215;
        warmLow.gain.value = 3.2;

        const deHarsh = ctx.createBiquadFilter();
        deHarsh.type = "peaking";
        deHarsh.frequency.value = 3250;
        deHarsh.Q.value = 1.35;
        deHarsh.gain.value = -3.6;

        const airHigh = ctx.createBiquadFilter();
        airHigh.type = "highshelf";
        airHigh.frequency.value = 7800;
        airHigh.gain.value = 1.4;

        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.knee.value = 18;
        compressor.ratio.value = 2.4;
        compressor.attack.value = 0.012;
        compressor.release.value = 0.18;

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.72;

        const data = new Uint8Array(analyser.fftSize);
        source.connect(warmLow);
        warmLow.connect(deHarsh);
        deHarsh.connect(airHigh);
        airHigh.connect(compressor);
        compressor.connect(analyser);
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
        console.warn(`Mira sunucu TTS kullanılamadı [${stage}]:`, message);
        stopLoop();
        setVoiceError("Ses çalınırken geçici bir sorun oluştu, küreye tekrar dokunun.");
        setSpeaking(false);
        setWordIndex(-1);
        opts.onEnd?.();
      }
    },
    [stop, stopLoop],
  );

  return {
    speak,
    stop,
    unlock,
    speaking,
    wordIndex,
    ampRef,
    voiceError,
  };
}
