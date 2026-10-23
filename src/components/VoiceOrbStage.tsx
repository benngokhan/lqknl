"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MIRA_AVATAR } from "@/lib/mira-avatar";
import { useSpeaker } from "./useSpeaker";
import { useWakeWord } from "./useWakeWord";

type Stock = { shorts: number; long: number; days?: number };
type ChatResponse = {
  assistant?: { content?: unknown };
  error?: unknown;
};

export type VoiceOrbStageProps = {
  /** Optional host command handler. Return a string to have Mira speak it. */
  onCommand?: (command: string) => string | void | Promise<string | void>;
  /** Without this prop the component periodically tries /api/drive/catalog. */
  stock?: Stock;
  portraitSrc?: string;
  autoStart?: boolean;
};

const DEFAULT_STOCK = { shorts: 60, long: 9, days: 23 };

const ORB_STYLES = `
.mira-orb-stage {
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: 100%;
  min-height: 100dvh;
  overflow: hidden;
  padding: max(22px, env(safe-area-inset-top)) 20px max(28px, env(safe-area-inset-bottom));
  color: #f5f3ff;
  background:
    radial-gradient(circle at 50% 46%, rgba(72, 30, 132, .32), transparent 38%),
    radial-gradient(circle at 15% 15%, rgba(0, 212, 255, .09), transparent 35%),
    radial-gradient(circle at 85% 78%, rgba(232, 68, 255, .09), transparent 34%),
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
  border: 1px solid rgba(153, 228, 255, .2);
  border-radius: 999px;
  color: rgba(239, 247, 255, .9);
  background: linear-gradient(120deg, rgba(14,22,44,.78), rgba(29,15,48,.7));
  box-shadow: 0 12px 50px rgba(0,0,0,.3), inset 0 1px rgba(255,255,255,.06);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  font-size: clamp(11px, 2.7vw, 15px);
  font-weight: 560;
  line-height: 1.45;
  text-align: center;
}
.mira-orb-space { display: grid; place-items: center; min-height: 0; }
.mira-orb-button {
  position: relative;
  width: min(72vw, 390px);
  aspect-ratio: 1;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 50%;
  outline: none;
  color: inherit;
  background: transparent;
  cursor: pointer;
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
  border: 1px solid rgba(91,225,255,.32);
  box-shadow: 0 0 24px rgba(62,198,255,.1), inset 0 0 24px rgba(108,83,255,.07);
  will-change: transform, opacity;
}
.mira-orb-ring-1 { inset: -7%; border-color: rgba(177,106,255,.25); border-style: dashed; }
.mira-orb-ring-2 { inset: -15%; border-color: rgba(76,208,255,.18); }
.mira-orb-ring-3 { inset: -24%; border-color: rgba(218,92,255,.13); border-style: dotted; }
.mira-orb-core {
  inset: 17%;
  overflow: hidden;
  border: 1px solid rgba(179,238,255,.52);
  background:
    radial-gradient(circle at 34% 25%, rgba(192,250,255,.38), transparent 25%),
    radial-gradient(circle at 68% 72%, rgba(219,65,255,.35), transparent 44%),
    radial-gradient(circle at 42% 45%, #362080 0%, #101639 46%, #050817 78%);
  box-shadow:
    0 0 28px rgba(72,221,255,.28),
    0 0 90px rgba(115,64,255,.25),
    0 0 160px rgba(211,58,255,.12),
    inset 0 0 55px rgba(74,209,255,.2);
  will-change: transform, filter;
}
.mira-orb-portrait, .mira-orb-nebula, .mira-orb-shine { position: absolute; inset: 0; border-radius: 50%; }
.mira-orb-portrait { overflow: hidden; }
.mira-orb-portrait img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 20%;
  opacity: .57;
  filter: saturate(.88) contrast(1.12) brightness(.88);
}
.mira-orb-nebula {
  opacity: .8;
  mix-blend-mode: screen;
  background:
    conic-gradient(from 30deg, transparent 0 18%, rgba(66,226,255,.18) 27%, transparent 39% 57%, rgba(226,73,255,.21) 69%, transparent 82%),
    radial-gradient(ellipse at 50% 100%, rgba(83,66,255,.3), transparent 55%);
  animation: mira-orb-nebula 13s linear infinite;
}
.mira-orb-shine {
  border: 1px solid rgba(255,255,255,.15);
  background: linear-gradient(145deg, rgba(255,255,255,.15), transparent 28% 68%, rgba(114,55,255,.15));
  box-shadow: inset 0 0 45px rgba(0,0,0,.25);
}
.mira-orb-wake-pulse {
  inset: 12%;
  border: 2px solid rgba(105,238,255,.9);
  box-shadow: 0 0 40px rgba(69,219,255,.5), inset 0 0 30px rgba(192,92,255,.25);
  animation: mira-orb-wake .78s cubic-bezier(.15,.65,.25,1) forwards;
}
.mira-orb-status {
  z-index: 5;
  align-self: end;
  min-height: 2.2em;
  margin: 0;
  color: rgba(232,235,255,.78);
  font-size: clamp(14px, 3.5vw, 19px);
  font-weight: 450;
  letter-spacing: .045em;
  line-height: 1.6;
  text-align: center;
  text-shadow: 0 0 22px rgba(110,195,255,.2);
  transition: color .25s ease;
}
.mira-orb-status[data-speaking="true"] { color: #b9f5ff; }
.mira-orb-status[data-active="true"] { color: #e1c6ff; }
@keyframes mira-orb-stars { to { transform: translate3d(5%, 8%, 0) rotate(3deg); } }
@keyframes mira-orb-nebula { to { transform: rotate(360deg); } }
@keyframes mira-orb-wake {
  0% { opacity: .95; transform: scale(.78); }
  100% { opacity: 0; transform: scale(1.55); }
}
@media (max-height: 620px) {
  .mira-orb-button { width: min(52vh, 76vw); }
  .mira-orb-stock { padding: 8px 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .mira-orb-stage::before, .mira-orb-nebula { animation: none; }
}
`;

export default function VoiceOrbStage({
  onCommand,
  stock: providedStock,
  portraitSrc = MIRA_AVATAR,
  autoStart = true,
}: VoiceOrbStageProps) {
  const { speak, stop, speaking, ampRef } = useSpeaker();
  const [thinking, setThinking] = useState(false);
  const thinkingRef = useRef(false);
  const [liveStock, setLiveStock] = useState<Required<Stock>>(DEFAULT_STOCK);

  const sendCommand = useCallback(async (command: string) => {
    if (thinkingRef.current) return;
    thinkingRef.current = true;
    setThinking(true);
    stop();

    try {
      let answer: string | void;
      if (onCommand) {
        answer = await onCommand(command);
      } else {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: command }),
        });
        const data = await response.json() as ChatResponse;
        if (!response.ok) {
          throw new Error(typeof data.error === "string" ? data.error : `/api/chat ${response.status}`);
        }
        answer = typeof data.assistant?.content === "string" ? data.assistant.content : "";
      }

      if (typeof answer === "string" && answer.trim()) {
        void speak(answer.trim(), { solMode: "close", emotion: "happy" });
      }
    } catch (reason) {
      console.warn("Mira Orb command failed:", reason);
      void speak("Bağlantıda bir sorun oldu. Lütfen biraz sonra tekrar deneyin.", {
        solMode: "close",
        emotion: "sad",
      });
    } finally {
      thinkingRef.current = false;
      setThinking(false);
    }
  }, [onCommand, speak, stop]);

  const {
    supported,
    listening,
    active,
    interim,
    error,
    wakePulse,
    start,
  } = useWakeWord({
    speaking,
    busy: thinking,
    onCommand: sendCommand,
    autoStart,
  });

  const stock: Required<Stock> = providedStock
    ? {
        shorts: providedStock.shorts,
        long: providedStock.long,
        days: providedStock.days ?? (providedStock.shorts + providedStock.long) / 3,
      }
    : liveStock;

  useEffect(() => {
    if (providedStock) return;
    let cancelled = false;

    const refreshStock = async () => {
      try {
        const response = await fetch("/api/drive/catalog", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as {
          videos?: { shorts?: unknown[]; longVideos?: unknown[] };
        };
        const shorts = data.videos?.shorts?.length;
        const long = data.videos?.longVideos?.length;
        if (
          cancelled ||
          typeof shorts !== "number" ||
          typeof long !== "number" ||
          !Number.isFinite(shorts) ||
          !Number.isFinite(long)
        ) return;
        setLiveStock({ shorts, long, days: (shorts + long) / 3 });
      } catch {
        // The approved stock figures remain visible when Drive is not configured.
      }
    };

    void refreshStock();
    const interval = setInterval(() => void refreshStock(), 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [providedStock]);

  const coreRef = useRef<HTMLSpanElement>(null);
  const ringRefs = useRef<Array<HTMLSpanElement | null>>([]);

  // Drive the neon rings from useSpeaker's real analyser amplitude. DOM writes
  // avoid a React render for every audio frame.
  useEffect(() => {
    let animationFrame = 0;
    let smoothed = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const animate = (time: number) => {
      const raw = Math.max(0, Math.min(1, ampRef.current));
      const baseline = speaking ? 0.055 : thinking ? 0.09 : active ? 0.07 : listening ? 0.035 : 0.02;
      const target = speaking ? Math.max(baseline, raw) : baseline;
      smoothed += (target - smoothed) * (speaking ? 0.24 : 0.09);
      const amplitude = Math.max(0, Math.min(1, smoothed));
      const ambient = reducedMotion ? 0 : Math.sin(time * 0.0022) * 0.006;

      if (coreRef.current) {
        const scale = 1 + amplitude * 0.19 + ambient;
        coreRef.current.style.transform = `scale(${scale.toFixed(4)})`;
        coreRef.current.style.filter = `saturate(${(1 + amplitude * 0.5).toFixed(3)}) brightness(${(1 + amplitude * 0.22).toFixed(3)})`;
      }

      ringRefs.current.forEach((ring, index) => {
        if (!ring) return;
        const wave = reducedMotion ? 0 : Math.sin(time * (0.002 + index * 0.00035) + index * 1.55);
        const scale = 1 + amplitude * (0.12 + index * 0.065) + wave * (0.008 + amplitude * 0.018);
        const rotation = reducedMotion ? 0 : time * (0.0025 + index * 0.001) * (index % 2 ? -1 : 1);
        ring.style.transform = `scale(${scale.toFixed(4)}) rotate(${rotation.toFixed(2)}deg)`;
        ring.style.opacity = String(Math.min(0.9, 0.24 + amplitude * 0.58 + (wave + 1) * 0.045));
      });

      animationFrame = requestAnimationFrame(animate);
    };

    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [active, ampRef, listening, speaking, thinking]);

  const statusText = !supported
    ? "Konuşma tanıma bu tarayıcıda desteklenmiyor"
    : speaking
      ? "Mira Konuşuyor..."
      : thinking
        ? "Mira Düşünüyor..."
        : error
          ? error
          : active || interim
            ? "Dinliyorum..."
            : "Hey Mira deyin...";

  return (
    <section className="mira-orb-stage" aria-label="Mira sadece ses Orb modu">
      <style>{ORB_STYLES}</style>
      <div className="mira-orb-stock" aria-label="Canlı video stoğu">
        📦 Kalan Stok: {stock.shorts} Shorts · {stock.long} Uzun (~{stock.days.toFixed(1)} Gün)
      </div>

      <div className="mira-orb-space">
        <button
          type="button"
          className="mira-orb-button"
          aria-label={speaking ? "Mira'nın konuşmasını durdur" : "Mira mikrofonunu başlat"}
          onClick={() => {
            if (speaking) stop();
            else start();
          }}
        >
          {[0, 1, 2, 3].map((index) => (
            <span
              key={index}
              ref={(node) => { ringRefs.current[index] = node; }}
              className={`mira-orb-ring mira-orb-ring-${index}`}
              aria-hidden="true"
            />
          ))}
          <span ref={coreRef} className="mira-orb-core" aria-hidden="true">
            <span className="mira-orb-portrait">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={portraitSrc} alt="" draggable={false} />
            </span>
            <span className="mira-orb-nebula" />
            <span className="mira-orb-shine" />
          </span>
          {wakePulse > 0 && <span key={wakePulse} className="mira-orb-wake-pulse" aria-hidden="true" />}
        </button>
      </div>

      <p
        className="mira-orb-status"
        data-speaking={speaking}
        data-active={active}
        aria-live="polite"
        role="status"
      >
        {statusText}
      </p>
    </section>
  );
}
