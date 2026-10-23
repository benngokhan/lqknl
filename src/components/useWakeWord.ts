"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type RecognitionAlternative = { transcript: string; confidence?: number };
type RecognitionResult = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternative;
};
type RecognitionResultList = {
  readonly length: number;
  readonly [index: number]: RecognitionResult;
};
type RecognitionEvent = {
  readonly resultIndex: number;
  readonly results: RecognitionResultList;
};
type RecognitionErrorEvent = { readonly error: string; readonly message?: string };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type RecognitionConstructor = new () => Recognition;
type Timer = ReturnType<typeof setTimeout>;

export type WakeWordOptions = {
  /** True while Mira's TTS is audible; recognition is paused to prevent echo. */
  speaking: boolean;
  /** Optional command-in-flight lock; final results are ignored while busy. */
  busy?: boolean;
  onCommand: (command: string) => void | Promise<void>;
  onWake?: () => void;
  autoStart?: boolean;
  wakeSound?: boolean;
  /** Follow-up commands need no wake word during this window. Default: 20 s. */
  activeTimeoutMs?: number;
};

type WakeMatch = { matched: boolean; command: string };

const WAKE_PATTERN = /(^|[^a-zçğıöşü])(hey[\s,.;:!?-]*mira|alo[\s,.;:!?-]*mira|mira)(?=$|[^a-zçğıöşü])/iu;

function matchWakeWord(transcript: string): WakeMatch {
  const text = transcript.trim();
  const match = WAKE_PATTERN.exec(text);
  if (!match) return { matched: false, command: "" };
  const command = text
    .slice(match.index + match[0].length)
    .replace(/^[\s,.;:!?-]+/, "")
    .trim();
  return { matched: true, command };
}

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const speechWindow = window as typeof window & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

export function useWakeWord({
  speaking,
  busy = false,
  onCommand,
  onWake,
  autoStart = true,
  wakeSound = true,
  activeTimeoutMs = 20_000,
}: WakeWordOptions) {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [active, setActive] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wakePulse, setWakePulse] = useState(0);

  const mountedRef = useRef(false);
  const recognitionRef = useRef<Recognition | null>(null);
  const shouldRunRef = useRef(false);
  const listeningRef = useRef(false);
  const speakingRef = useRef(speaking);
  const busyRef = useRef(busy);
  const echoPausedRef = useRef(speaking);
  const activeRef = useRef(false);
  const activeTimeoutRef = useRef(activeTimeoutMs);
  const wakeSoundRef = useRef(wakeSound);
  const onCommandRef = useRef(onCommand);
  const onWakeRef = useRef(onWake);
  const startRef = useRef<() => boolean>(() => false);
  const restartTimerRef = useRef<Timer | null>(null);
  const echoTimerRef = useRef<Timer | null>(null);
  const activeTimerRef = useRef<Timer | null>(null);
  const restartDelayRef = useRef(350);
  const lastCommandRef = useRef({ text: "", at: 0 });
  const wakeAudioRef = useRef<AudioContext | null>(null);

  useEffect(() => { onCommandRef.current = onCommand; }, [onCommand]);
  useEffect(() => { onWakeRef.current = onWake; }, [onWake]);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { activeTimeoutRef.current = activeTimeoutMs; }, [activeTimeoutMs]);
  useEffect(() => { wakeSoundRef.current = wakeSound; }, [wakeSound]);

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current !== null) clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
  }, []);

  const clearActiveTimer = useCallback(() => {
    if (activeTimerRef.current !== null) clearTimeout(activeTimerRef.current);
    activeTimerRef.current = null;
  }, []);

  const armActiveTimer = useCallback(() => {
    clearActiveTimer();
    if (!activeRef.current || speakingRef.current) return;
    activeTimerRef.current = setTimeout(() => {
      activeRef.current = false;
      if (mountedRef.current) setActive(false);
    }, Math.max(3_000, activeTimeoutRef.current));
  }, [clearActiveTimer]);

  const stopRecognition = useCallback((abort = false) => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    listeningRef.current = false;
    if (mountedRef.current) setListening(false);
    if (!recognition) return;
    try {
      if (abort) recognition.abort();
      else recognition.stop();
    } catch {
      // A stopped/aborted recognition can throw InvalidStateError on some browsers.
    }
  }, []);

  const scheduleRestart = useCallback((delay?: number) => {
    if (
      !mountedRef.current ||
      !shouldRunRef.current ||
      speakingRef.current ||
      echoPausedRef.current ||
      recognitionRef.current ||
      restartTimerRef.current !== null
    ) return;

    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      startRef.current();
    }, Math.max(0, delay ?? restartDelayRef.current));
  }, []);

  const playWakeSound = useCallback(async () => {
    if (typeof window === "undefined" || speakingRef.current) return;
    try {
      const Context = window.AudioContext ?? (window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;
      if (!Context) return;
      if (!wakeAudioRef.current) wakeAudioRef.current = new Context();
      const context = wakeAudioRef.current;
      if (context.state === "suspended") await context.resume();
      if (!mountedRef.current || speakingRef.current) return;

      const startAt = context.currentTime + 0.015;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.075, startAt + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.28);
      gain.connect(context.destination);

      [659.25, 987.77].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, startAt + index * 0.085);
        oscillator.connect(gain);
        oscillator.start(startAt + index * 0.085);
        oscillator.stop(startAt + 0.3);
      });
    } catch {
      // Wake visuals still work when the browser blocks audio before a gesture.
    }
  }, []);

  const wake = useCallback(() => {
    activeRef.current = true;
    if (mountedRef.current) {
      setActive(true);
      setWakePulse((value) => value + 1);
      setError(null);
    }
    armActiveTimer();
    onWakeRef.current?.();
    if (wakeSoundRef.current) void playWakeSound();
  }, [armActiveTimer, playWakeSound]);

  const emitCommand = useCallback((rawCommand: string) => {
    const command = rawCommand.trim();
    if (
      !command ||
      speakingRef.current ||
      echoPausedRef.current ||
      busyRef.current
    ) return;

    const now = Date.now();
    const fingerprint = command.toLocaleLowerCase("tr-TR").replace(/\s+/g, " ");
    if (
      fingerprint === lastCommandRef.current.text &&
      now - lastCommandRef.current.at < 1_200
    ) return;
    lastCommandRef.current = { text: fingerprint, at: now };

    activeRef.current = true;
    if (mountedRef.current) {
      setActive(true);
      setInterim("");
      setError(null);
    }
    armActiveTimer();

    try {
      void Promise.resolve(onCommandRef.current(command)).catch((reason: unknown) => {
        console.warn("Mira voice command failed:", reason);
        if (mountedRef.current) setError("Komut işlenemedi; lütfen tekrar deneyin.");
      });
    } catch (reason) {
      console.warn("Mira voice command failed:", reason);
      if (mountedRef.current) setError("Komut işlenemedi; lütfen tekrar deneyin.");
    }
  }, [armActiveTimer]);

  const handleFinal = useCallback((transcript: string) => {
    if (
      !mountedRef.current ||
      speakingRef.current ||
      echoPausedRef.current ||
      busyRef.current
    ) return;
    const text = transcript.trim();
    if (!text) return;

    const wakeMatch = matchWakeWord(text);
    if (wakeMatch.matched) {
      if (!activeRef.current) wake();
      if (wakeMatch.command) emitCommand(wakeMatch.command);
      return;
    }
    // Once awake, follow-up speech is a direct command without another wake word.
    if (activeRef.current) emitCommand(text);
  }, [emitCommand, wake]);

  const start = useCallback((): boolean => {
    shouldRunRef.current = true;
    const Constructor = recognitionConstructor();
    if (!Constructor) {
      shouldRunRef.current = false;
      if (mountedRef.current) {
        setSupported(false);
        setError("Bu tarayıcıda Türkçe konuşma tanıma desteklenmiyor.");
      }
      return false;
    }
    if (mountedRef.current) {
      setSupported(true);
      setError(null);
    }
    if (speakingRef.current || echoPausedRef.current) return true;
    if (recognitionRef.current || listeningRef.current) return true;

    clearRestartTimer();
    const recognition = new Constructor();
    recognition.lang = "tr-TR";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognitionRef.current = recognition;

    recognition.onstart = () => {
      if (recognitionRef.current !== recognition) return;
      restartDelayRef.current = 350;
      listeningRef.current = true;
      if (mountedRef.current) {
        setListening(true);
        setError(null);
      }
    };

    recognition.onresult = (event) => {
      if (
        recognitionRef.current !== recognition ||
        speakingRef.current ||
        echoPausedRef.current ||
        busyRef.current
      ) return;

      const interimParts: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript?.trim() ?? "";
        if (!transcript) continue;
        if (result.isFinal) handleFinal(transcript);
        else interimParts.push(transcript);
      }

      const interimText = interimParts.join(" ").trim();
      if (mountedRef.current) setInterim(interimText);
      if (interimText && !activeRef.current) {
        const earlyWake = matchWakeWord(interimText);
        if (earlyWake.matched) wake();
      }
    };

    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition) return;
      const fatal = event.error === "not-allowed" || event.error === "service-not-allowed";
      if (fatal) {
        shouldRunRef.current = false;
        if (mountedRef.current) {
          setError("Mikrofon izni gerekli; Orb'a dokunarak tekrar deneyin.");
        }
        return;
      }
      if (event.error === "audio-capture" && mountedRef.current) {
        setError("Mikrofon bulunamadı veya başka bir uygulama tarafından kullanılıyor.");
      } else if (event.error === "network" && mountedRef.current) {
        setError("Konuşma servisine bağlanılamadı; yeniden deneniyor.");
      }
      if (event.error !== "no-speech" && event.error !== "aborted") {
        restartDelayRef.current = Math.min(5_000, restartDelayRef.current * 1.7);
      }
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      listeningRef.current = false;
      if (mountedRef.current) setListening(false);
      scheduleRestart();
    };

    try {
      recognition.start();
      return true;
    } catch {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      listeningRef.current = false;
      if (mountedRef.current) setListening(false);
      scheduleRestart();
      return false;
    }
  }, [clearRestartTimer, handleFinal, scheduleRestart, wake]);

  useEffect(() => { startRef.current = start; }, [start]);

  const stop = useCallback(() => {
    shouldRunRef.current = false;
    clearRestartTimer();
    clearActiveTimer();
    if (echoTimerRef.current !== null) clearTimeout(echoTimerRef.current);
    echoTimerRef.current = null;
    activeRef.current = false;
    if (mountedRef.current) {
      setActive(false);
      setInterim("");
      setError(null);
    }
    stopRecognition(true);
  }, [clearActiveTimer, clearRestartTimer, stopRecognition]);

  const endSession = useCallback(() => {
    clearActiveTimer();
    activeRef.current = false;
    if (mountedRef.current) {
      setActive(false);
      setInterim("");
    }
  }, [clearActiveTimer]);

  // Hard echo guard: abort capture while TTS is audible, then leave a short
  // tail before restarting so the final speaker samples are not recognized.
  useEffect(() => {
    speakingRef.current = speaking;
    if (speaking) {
      echoPausedRef.current = true;
      clearRestartTimer();
      clearActiveTimer();
      if (echoTimerRef.current !== null) clearTimeout(echoTimerRef.current);
      echoTimerRef.current = null;
      stopRecognition(true);
      return;
    }
    if (!echoPausedRef.current) return;
    echoTimerRef.current = setTimeout(() => {
      echoTimerRef.current = null;
      echoPausedRef.current = false;
      if (activeRef.current) armActiveTimer();
      scheduleRestart(0);
    }, 450);
    return () => {
      if (echoTimerRef.current !== null) clearTimeout(echoTimerRef.current);
      echoTimerRef.current = null;
    };
  }, [armActiveTimer, clearActiveTimer, clearRestartTimer, scheduleRestart, speaking, stopRecognition]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      shouldRunRef.current = false;
      clearRestartTimer();
      clearActiveTimer();
      if (echoTimerRef.current !== null) clearTimeout(echoTimerRef.current);
      stopRecognition(true);
      if (wakeAudioRef.current) void wakeAudioRef.current.close().catch(() => undefined);
      wakeAudioRef.current = null;
    };
  }, [clearActiveTimer, clearRestartTimer, stopRecognition]);

  useEffect(() => {
    if (!autoStart) return;
    const timer = setTimeout(() => start(), 400);
    return () => clearTimeout(timer);
  }, [autoStart, start]);

  return {
    supported,
    listening,
    active,
    interim,
    error,
    wakePulse,
    start,
    stop,
    endSession,
  };
}
