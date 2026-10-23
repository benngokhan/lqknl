"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSpeaker } from "./useSpeaker";

type Stock = { shorts: number; long: number; days?: number; nextTitle?: string };
type ChatResponse = {
  reply?: unknown;
  assistant?: { content?: unknown };
  error?: unknown;
};

type SRResult = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { transcript: string };
};
type SREvent = {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: SRResult };
};
type SRErrorEvent = { readonly error: string };
type SpeechRec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

export type VoiceOrbStageProps = {
  onCommand?: (command: string) => string | void | Promise<string | void>;
  stock?: Stock;
  portraitSrc?: string;
  autoStart?: boolean;
};

const DEFAULT_STOCK: Required<Stock> = {
  shorts: 60,
  long: 9,
  days: 23,
  nextTitle: "",
};

const ORB_STYLES = `
.mira-orb-stage {
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: 100%;
  min-height: 100dvh;
  overflow: hidden;
  padding: max(62px, env(safe-area-inset-top)) 20px max(28px, env(safe-area-inset-bottom));
  color: #f5f3ff;
  background:
    radial-gradient(circle at 50% 44%, rgba(72, 30, 132, .38), transparent 42%),
    radial-gradient(circle at 15% 15%, rgba(0, 212, 255, .11), transparent 36%),
    radial-gradient(circle at 85% 78%, rgba(232, 68, 255, .11), transparent 36%),
    #03030c;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.mira-orb-stage::before {
  content: "";
  position: absolute;
  z-index: -1;
  inset: -20%;
  opacity: .55;
  background-image:
    radial-gradient(circle, rgba(255,255,255,.65) 0 1px, transparent 1.5px),
    radial-gradient(circle, rgba(100,220,255,.4) 0 1px, transparent 1.5px);
  background-position: 0 0, 37px 61px;
  background-size: 137px 137px, 191px 191px;
  animation: mira-orb-stars 36s linear infinite;
}
.mira-orb-stage::after {
  content: "";
  position: absolute;
  z-index: -1;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(ellipse at center, transparent 35%, rgba(0,0,0,.68) 100%);
}
.mira-orb-stock {
  z-index: 5;
  justify-self: center;
  max-width: min(94vw, 680px);
  padding: 11px 18px;
  border: 1px solid rgba(153, 228, 255, .24);
  border-radius: 999px;
  color: rgba(239, 247, 255, .94);
  background: linear-gradient(120deg, rgba(14,22,44,.82), rgba(29,15,48,.76));
  box-shadow: 0 12px 50px rgba(0,0,0,.35), inset 0 1px rgba(255,255,255,.08);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  font-size: clamp(12px, 2.8vw, 15px);
  font-weight: 600;
  line-height: 1.45;
  text-align: center;
}
.mira-orb-space { display: grid; place-items: center; min-height: 0; }
.mira-orb-button {
  position: relative;
  width: min(72vw, 370px);
  aspect-ratio: 1;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 50%;
  outline: none;
  color: inherit;
  background: transparent;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.mira-orb-button:focus-visible { outline: 2px solid rgba(109,235,255,.75); outline-offset: 12px; }
.mira-orb-ring, .mira-orb-core, .mira-orb-wake-pulse {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
}
.mira-orb-ring {
  inset: 0;
  border: 1.5px solid rgba(91,225,255,.36);
  box-shadow: 0 0 24px rgba(62,198,255,.12), inset 0 0 24px rgba(108,83,255,.09);
  will-change: transform, opacity;
}
.mira-orb-ring-1 { inset: -7%; border-color: rgba(177,106,255,.32); border-style: dashed; }
.mira-orb-ring-2 { inset: -15%; border-color: rgba(76,208,255,.22); }
.mira-orb-ring-3 { inset: -24%; border-color: rgba(218,92,255,.16); border-style: dotted; }
.mira-orb-core {
  inset: 15%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1.5px solid rgba(179,238,255,.58);
  background:
    radial-gradient(circle at 34% 25%, rgba(192,250,255,.45), transparent 28%),
    radial-gradient(circle at 68% 72%, rgba(219,65,255,.42), transparent 46%),
    radial-gradient(circle at 42% 45%, #3b218c 0%, #121942 48%, #050817 82%);
  box-shadow:
    0 0 34px rgba(72,221,255,.34),
    0 0 95px rgba(115,64,255,.32),
    0 0 165px rgba(211,58,255,.16),
    inset 0 0 55px rgba(74,209,255,.26);
  will-change: transform, filter;
  transition: border-color .25s ease, box-shadow .25s ease;
}
.mira-orb-core[data-listening="true"] {
  border-color: rgba(52, 211, 153, .95);
  box-shadow:
    0 0 45px rgba(16, 185, 129, .55),
    0 0 110px rgba(52, 211, 153, .38),
    inset 0 0 60px rgba(16, 185, 129, .35);
}
.mira-orb-core[data-speaking="true"] {
  border-color: rgba(232, 121, 249, .95);
  box-shadow:
    0 0 50px rgba(217, 70, 239, .6),
    0 0 120px rgba(139, 92, 246, .45),
    inset 0 0 65px rgba(217, 70, 239, .38);
}
.mira-orb-nebula, .mira-orb-shine { position: absolute; inset: 0; border-radius: 50%; }
.mira-orb-nebula {
  opacity: .85;
  mix-blend-mode: screen;
  background:
    conic-gradient(from 30deg, transparent 0 18%, rgba(66,226,255,.22) 27%, transparent 39% 57%, rgba(226,73,255,.25) 69%, transparent 82%),
    radial-gradient(ellipse at 50% 100%, rgba(83,66,255,.35), transparent 55%);
  animation: mira-orb-nebula 13s linear infinite;
}
.mira-orb-shine {
  border: 1px solid rgba(255,255,255,.18);
  background: linear-gradient(145deg, rgba(255,255,255,.18), transparent 28% 68%, rgba(114,55,255,.18));
  box-shadow: inset 0 0 45px rgba(0,0,0,.25);
}
.mira-orb-center-content {
  position: relative;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  padding: 0 16px;
}
.mira-orb-eq {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 44px;
}
.mira-orb-eq-bar {
  width: 5px;
  height: 36px;
  border-radius: 999px;
  background: linear-gradient(180deg, #67e8f9 0%, #c084fc 55%, #f472b6 100%);
  box-shadow: 0 0 12px rgba(103, 232, 249, .55);
  transform-origin: center;
  transition: transform .08s ease;
}
.mira-orb-badge-label {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: rgba(240, 249, 255, .95);
  text-shadow: 0 0 16px rgba(56, 189, 248, .55);
}
.mira-orb-sub-label {
  font-size: 11px;
  font-weight: 500;
  color: rgba(224, 231, 255, .78);
}
.mira-orb-wake-pulse {
  inset: 10%;
  border: 2px solid rgba(105,238,255,.92);
  box-shadow: 0 0 40px rgba(69,219,255,.55), inset 0 0 30px rgba(192,92,255,.3);
  animation: mira-orb-wake .78s cubic-bezier(.15,.65,.25,1) forwards;
}
.mira-orb-status {
  z-index: 5;
  margin: 0;
  color: rgba(232,235,255,.85);
  font-size: clamp(14px, 3.4vw, 18px);
  font-weight: 550;
  letter-spacing: .03em;
  line-height: 1.5;
  text-align: center;
  text-shadow: 0 0 22px rgba(110,195,255,.25);
}
@keyframes mira-orb-stars { to { transform: translate3d(5%, 8%, 0) rotate(3deg); } }
@keyframes mira-orb-nebula { to { transform: rotate(360deg); } }
@keyframes mira-orb-wake {
  0% { opacity: .95; transform: scale(.78); }
  100% { opacity: 0; transform: scale(1.55); }
}
@media (max-height: 620px) {
  .mira-orb-button { width: min(50vh, 74vw); }
  .mira-orb-stock { padding: 8px 14px; }
}
`;

export default function VoiceOrbStage({
  onCommand,
  stock: providedStock,
}: VoiceOrbStageProps) {
  const { speak, stop, speaking, ampRef } = useSpeaker();
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [supported, setSupported] = useState(true);
  const [interim, setInterim] = useState("");
  const [lastHeard, setLastHeard] = useState("");
  const [lastReply, setLastReply] = useState(
    "Hazırım patron! Konuşmak için ortadaki küreye dokun (Bas-Konuş)."
  );
  const [error, setError] = useState<string | null>(null);
  const [wakePulse, setWakePulse] = useState(0);
  const [liveStock, setLiveStock] = useState<Required<Stock>>(DEFAULT_STOCK);

  const recRef = useRef<SpeechRec | null>(null);
  const thinkingRef = useRef(false);
  const coreRef = useRef<HTMLSpanElement>(null);
  const ringRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const eqRefs = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    return () => {
      try {
        recRef.current?.abort();
      } catch {
        // ignore
      }
    };
  }, []);

  const sendCommand = useCallback(
    async (command: string) => {
      const cleaned = command.replace(/^\s*(?:hey\s+|merhaba\s+|selam\s+)?mira[\s,.:;!?-]*/iu, "").trim() || command.trim();
      if (!cleaned || thinkingRef.current) return;

      thinkingRef.current = true;
      setThinking(true);
      setLastHeard(cleaned);
      setInterim("");
      setError(null);
      stop();

      try {
        let answer: string | void;
        if (onCommand) {
          answer = await onCommand(cleaned);
        } else {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: cleaned }),
          });
          const data = (await response.json().catch(() => ({}))) as ChatResponse;
          if (!response.ok) {
            throw new Error(typeof data.error === "string" ? data.error : `/api/chat ${response.status}`);
          }
          answer =
            typeof data.reply === "string"
              ? data.reply
              : typeof data.assistant?.content === "string"
                ? data.assistant.content
                : "";
        }

        if (typeof answer === "string" && answer.trim()) {
          const cleanReply = answer.trim();
          setLastReply(cleanReply);
          void speak(cleanReply, { solMode: "close", emotion: "happy" });
        }
      } catch (reason) {
        console.warn("Mira Orb command failed:", reason);
        const fallbackMsg = "Bağlantıda bir sorun oldu patron, tekrar dokunup söyler misin?";
        setLastReply(fallbackMsg);
        void speak(fallbackMsg, { solMode: "close", emotion: "sad" });
      } finally {
        thinkingRef.current = false;
        setThinking(false);
      }
    },
    [onCommand, speak, stop]
  );

  // BAS-KONUŞ (Tap-to-Talk): Sadece kullanıcı küreye dokunduğunda tek seferlik açılır!
  // Kendi kendine döngüsel aç-kapa yapmadığı için Android'de "dıgıdık" sistem sesi çıkarmaz.
  const togglePushToTalk = useCallback(() => {
    if (speaking) {
      stop();
      return;
    }
    if (thinkingRef.current) return;

    if (listening && recRef.current) {
      try {
        recRef.current.stop();
      } catch {
        setListening(false);
      }
      return;
    }

    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRec;
      webkitSpeechRecognition?: new () => SpeechRec;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      setSupported(false);
      setError("Bu tarayıcıda ses tanıma desteklenmiyor.");
      return;
    }

    stop();
    setError(null);
    setInterim("");
    setWakePulse((n) => n + 1);

    const rec = new Ctor();
    rec.lang = "tr-TR";
    rec.continuous = false; // Tek cümlelik net Bas-Konuş: döngüsel bip/dıgıdık sesini tamamen önler
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let finalTranscript = "";
    let latestInterim = "";

    rec.onstart = () => {
      setListening(true);
    };

    rec.onresult = (event: SREvent) => {
      let inter = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res?.[0]?.transcript || "";
        if (res.isFinal) {
          finalTranscript += " " + txt;
        } else {
          inter += txt;
        }
      }
      latestInterim = (finalTranscript + " " + inter).trim();
      setInterim(latestInterim);
    };

    rec.onerror = (ev: SRErrorEvent) => {
      setListening(false);
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        setError("Mikrofon izni kapalı. Tarayıcıdan mikrofon izni verin.");
      } else if (ev.error === "no-speech") {
        setError("Ses duyulmadı. Küreye dokunup tekrar söyleyin.");
      }
    };

    rec.onend = () => {
      setListening(false);
      recRef.current = null;
      const spoken = (finalTranscript.trim() || latestInterim.trim());
      if (spoken) {
        void sendCommand(spoken);
      }
    };

    recRef.current = rec;
    try {
      rec.start();
    } catch {
      setListening(false);
      setError("Mikrofon başlatılamadı, küreye tekrar dokunun.");
    }
  }, [listening, sendCommand, speaking, stop]);

  const stock: Required<Stock> = providedStock
    ? {
        shorts: providedStock.shorts,
        long: providedStock.long,
        days: providedStock.days ?? (providedStock.shorts + providedStock.long) / 3,
        nextTitle: providedStock.nextTitle ?? "",
      }
    : liveStock;

  useEffect(() => {
    if (providedStock) return;
    let cancelled = false;

    const refreshStock = async () => {
      try {
        const invRes = await fetch("/api/chat?view=inventory", { cache: "no-store" });
        if (invRes.ok) {
          const inv = (await invRes.json()) as {
            ok?: boolean;
            shortsRemaining?: number;
            longsRemaining?: number;
            daysRemaining?: number;
            nextShorts?: { title?: string } | null;
          };
          if (
            !cancelled &&
            inv?.ok &&
            typeof inv.shortsRemaining === "number" &&
            typeof inv.longsRemaining === "number"
          ) {
            setLiveStock({
              shorts: inv.shortsRemaining,
              long: inv.longsRemaining,
              days:
                typeof inv.daysRemaining === "number"
                  ? inv.daysRemaining
                  : (inv.shortsRemaining + inv.longsRemaining) / 3,
              nextTitle: inv.nextShorts?.title || "",
            });
            return;
          }
        }
        const bridgeRes = await fetch("/api/automation/yt-bridge", { cache: "no-store" });
        if (bridgeRes.ok) {
          const b = (await bridgeRes.json()) as {
            remainingShortsCount?: number;
            remainingLongsCount?: number;
            estimatedDaysRemaining?: number;
            nextShort?: { title?: string } | null;
          };
          if (
            !cancelled &&
            typeof b?.remainingShortsCount === "number" &&
            typeof b?.remainingLongsCount === "number"
          ) {
            setLiveStock({
              shorts: b.remainingShortsCount,
              long: b.remainingLongsCount,
              days:
                typeof b.estimatedDaysRemaining === "number"
                  ? b.estimatedDaysRemaining
                  : (b.remainingShortsCount + b.remainingLongsCount) / 3,
              nextTitle: b.nextShort?.title || "",
            });
          }
        }
      } catch {
        // Keep last known stock figures
      }
    };

    void refreshStock();
    const interval = setInterval(() => void refreshStock(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [providedStock]);

  useEffect(() => {
    let animationFrame = 0;
    let smoothed = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const animate = (time: number) => {
      const raw = Math.max(0, Math.min(1, ampRef.current));
      const baseline = speaking ? 0.08 : thinking ? 0.1 : listening ? 0.14 : 0.025;
      const target = speaking ? Math.max(baseline, raw) : baseline;
      smoothed += (target - smoothed) * (speaking ? 0.25 : 0.12);
      const amplitude = Math.max(0, Math.min(1, smoothed));
      const ambient = reducedMotion ? 0 : Math.sin(time * 0.0022) * 0.008;

      if (coreRef.current) {
        const scale = 1 + amplitude * 0.2 + ambient;
        coreRef.current.style.transform = `scale(${scale.toFixed(4)})`;
      }

      ringRefs.current.forEach((ring, index) => {
        if (!ring) return;
        const wave = reducedMotion ? 0 : Math.sin(time * (0.002 + index * 0.00035) + index * 1.55);
        const scale = 1 + amplitude * (0.12 + index * 0.065) + wave * (0.008 + amplitude * 0.018);
        const rotation = reducedMotion ? 0 : time * (0.0025 + index * 0.001) * (index % 2 ? -1 : 1);
        ring.style.transform = `scale(${scale.toFixed(4)}) rotate(${rotation.toFixed(2)}deg)`;
        ring.style.opacity = String(Math.min(0.92, 0.26 + amplitude * 0.58 + (wave + 1) * 0.045));
      });

      eqRefs.current.forEach((bar, i) => {
        if (!bar) return;
        const phase = Math.sin(time * 0.009 + i * 0.85) * 0.5 + 0.5;
        const level = speaking
          ? 0.25 + amplitude * (0.5 + phase * 0.8)
          : listening
            ? 0.3 + phase * 0.55
            : thinking
              ? 0.22 + phase * 0.25
              : 0.18 + phase * 0.08;
        bar.style.transform = `scaleY(${Math.min(1.35, Math.max(0.15, level)).toFixed(3)})`;
      });

      animationFrame = requestAnimationFrame(animate);
    };

    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [ampRef, listening, speaking, thinking]);

  const statusText = !supported
    ? "Konuşma tanıma bu tarayıcıda desteklenmiyor"
    : speaking
      ? "🔊 Mira Konuşuyor... (Durdurmak için küreye dokun)"
      : thinking
        ? "⚡ Mira Düşünüyor..."
        : listening
          ? "🎙️ Dinliyorum Patron... Konuşabilirsin (Bitince otomatik gönderir)"
          : error
            ? `⚠️ ${error}`
            : "🎙️ Konuşmak İçin Küreye Dokun (Bas-Konuş)";

  return (
    <section className="mira-orb-stage" aria-label="Mira Bas-Konuş Ses Küresi">
      <style>{ORB_STYLES}</style>
      <div className="mira-orb-stock" aria-label="Canlı video stoğu">
        <div>📦 Kalan Stok: {stock.shorts} Shorts · {stock.long} Uzun (~{stock.days.toFixed(1)} Gün)</div>
        {stock.nextTitle && (
          <div style={{ fontSize: "11px", color: "rgba(186, 230, 253, 0.85)", marginTop: "3px", fontWeight: 500 }}>
            ⏭️ Sıradaki: {stock.nextTitle}
          </div>
        )}
      </div>

      <div className="mira-orb-space">
        <button
          type="button"
          className="mira-orb-button"
          aria-label={speaking ? "Mira konuşmasını durdur" : listening ? "Dinlemeyi bitir" : "Bas-Konuş mikrofonu aç"}
          onClick={togglePushToTalk}
        >
          {[0, 1, 2, 3].map((index) => (
            <span
              key={index}
              ref={(node) => {
                ringRefs.current[index] = node;
              }}
              className={`mira-orb-ring mira-orb-ring-${index}`}
              aria-hidden="true"
            />
          ))}
          <span
            ref={coreRef}
            className="mira-orb-core"
            data-listening={listening}
            data-speaking={speaking}
            aria-hidden="true"
          >
            <span className="mira-orb-nebula" />
            <span className="mira-orb-shine" />
            <span className="mira-orb-center-content">
              <span className="mira-orb-eq">
                {Array.from({ length: 7 }).map((_, i) => (
                  <span
                    key={i}
                    ref={(el) => {
                      eqRefs.current[i] = el;
                    }}
                    className="mira-orb-eq-bar"
                  />
                ))}
              </span>
              <span className="mira-orb-badge-label">
                {speaking ? "MİRA KONUŞUYOR" : listening ? "DİNLİYORUM..." : thinking ? "İŞLENİYOR..." : "BAS · KONUŞ"}
              </span>
              <span className="mira-orb-sub-label">
                {speaking ? "Durdurmak için dokun" : listening ? "Cümleni söyle" : "Dokun ve emrini söyle"}
              </span>
            </span>
          </span>
          {wakePulse > 0 && <span key={wakePulse} className="mira-orb-wake-pulse" aria-hidden="true" />}
        </button>
      </div>

      <div
        style={{
          zIndex: 5,
          alignSelf: "end",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "10px",
          maxWidth: "min(92vw, 720px)",
          margin: "0 auto",
        }}
      >
        {(interim || lastHeard) && (
          <div
            style={{
              padding: "6px 14px",
              borderRadius: "999px",
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.14)",
              fontSize: "13px",
              color: "rgba(225,198,255,0.95)",
            }}
          >
            🗣️ {interim || lastHeard}
          </div>
        )}
        {lastReply && (
          <div
            style={{
              padding: "12px 18px",
              borderRadius: "18px",
              background: "rgba(10,14,32,0.76)",
              border: "1px solid rgba(153,228,255,0.24)",
              fontSize: "clamp(13px, 2.8vw, 16px)",
              lineHeight: 1.5,
              color: "#f5f3ff",
              textAlign: "center",
              backdropFilter: "blur(12px)",
            }}
          >
            {lastReply}
          </div>
        )}
        <p className="mira-orb-status" aria-live="polite" role="status">
          {statusText}
        </p>
      </div>
    </section>
  );
}
