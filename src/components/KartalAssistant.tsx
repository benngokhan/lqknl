'use client';

import { useEffect, useRef, useState } from 'react';

type Turn = { role: 'user' | 'assistant'; content: string; sources?: Array<{ title: string; url: string }> };
type RecognitionEvent = { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> };
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: (() => void) | null; onend: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
};

export default function KartalAssistant() {
  const [items, setItems] = useState<Turn[]>([{ role: 'assistant', content: 'Buradayım reis. Bana yazabilir veya mikrofonla konuşabilirsin.' }]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [sound, setSound] = useState(true);
  const busyRef = useRef(false);
  const historyRef = useRef<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const recognitionRef = useRef<Recognition | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const soundRef = useRef(true);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [items, busy]);
  useEffect(() => () => {
    try { recognitionRef.current?.abort(); } catch { /* no active recognition */ }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  function speak(reply: string) {
    if (!soundRef.current || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(reply);
      utterance.lang = 'tr-TR';
      const voice = window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('tr'));
      if (voice) utterance.voice = voice;
      window.speechSynthesis.speak(utterance);
    } catch { /* Text remains visible when device TTS is unavailable. */ }
  }

  async function send(message: string) {
    const cleaned = message.trim();
    if (!cleaned || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setItems((prev) => [...prev.slice(-39), { role: 'user', content: cleaned }]);
    try {
      const response = await fetch('/api/kartal/assistant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: cleaned, history: historyRef.current.slice(-12) }),
      });
      const result = await response.json().catch(() => ({}));
      const reply = typeof result?.reply === 'string' && result.reply.trim() ? result.reply.trim() : 'KartaL bağlantısı yanıt vermedi.';
      const sources = Array.isArray(result?.sources) ? result.sources.filter((source: { title?: unknown; url?: unknown }) =>
        typeof source.title === 'string' && typeof source.url === 'string' && source.url.startsWith('https://')).slice(0, 4) : undefined;
      setItems((prev) => [...prev.slice(-39), { role: 'assistant', content: reply, sources }]);
      if (response.ok && result.ok) historyRef.current = [...historyRef.current, { role: 'user' as const, content: cleaned }, { role: 'assistant' as const, content: reply }].slice(-12);
      speak(reply);
    } catch {
      const reply = 'Panele ulaşamadım. İnternet bağlantısını kontrol et; işlem yapılmadı.';
      setItems((prev) => [...prev.slice(-39), { role: 'assistant', content: reply }]);
      speak(reply);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function startMic() {
    if (listening) { recognitionRef.current?.stop(); return; }
    if (busyRef.current) return;
    const win = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const Ctor = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!Ctor) {
      setItems((prev) => [...prev.slice(-39), { role: 'assistant', content: 'Bu tarayıcıda ses tanıma yok. Yazabilirsin veya Android Chrome kullanabilirsin.' }]);
      return;
    }
    const recognition = new Ctor();
    recognitionRef.current = recognition;
    recognition.lang = 'tr-TR'; recognition.continuous = false; recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((r) => r[0]?.transcript || '').join(' ').trim();
      if (transcript) void send(transcript);
    };
    recognition.onerror = () => { setListening(false); setItems((prev) => [...prev.slice(-39), { role: 'assistant', content: 'Mikrofon açılamadı. Mikrofon iznini kontrol et veya mesajını yaz.' }]); };
    recognition.onend = () => setListening(false);
    try { recognition.start(); setListening(true); } catch { setListening(false); setItems((prev) => [...prev.slice(-39), { role: 'assistant', content: 'Mikrofon başlatılamadı; mesajını yazabilirsin.' }]); }
  }

  return (
    <section className="ka-shell v2-card" aria-label="KartaL kişisel asistan">
      <style jsx>{`
        .ka-shell{border:1px solid rgba(34,211,238,.32); background:linear-gradient(145deg,rgba(9,32,47,.94),rgba(13,19,31,.95));}
        .ka-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
        .ka-title{font-size:20px;font-weight:850;color:#f6fcff;letter-spacing:-.02em}.ka-small{margin-top:4px;font-size:12px;color:#a9c8d3}
        .ka-sound{border:1px solid #426273;background:#102c3b;color:#e1f9ff;border-radius:12px;padding:8px 10px;cursor:pointer;font-weight:700;white-space:nowrap}
        .ka-log{height:min(40vh,360px);min-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:9px;padding:12px;border:1px solid #284958;border-radius:16px;background:#071620;scroll-behavior:smooth}
        .ka-msg{max-width:93%;padding:10px 12px;border-radius:14px;background:#17303e;color:#eaf9ff;font-size:14px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
        .ka-user{align-self:flex-end;background:#087a8d;color:#fff}.ka-who{display:block;font-size:10px;font-weight:800;letter-spacing:.06em;margin-bottom:4px;opacity:.8}
        .ka-link{display:block;margin-top:6px;color:#7beaff!important;text-decoration:underline!important}
        .ka-form{display:flex;gap:8px;align-items:center;margin-top:10px}.ka-input{flex:1;min-width:0;background:#f7fcff;color:#10232e;border:0;border-radius:12px;padding:12px;font-size:16px;outline-color:#30c9e2}
        .ka-mic,.ka-send{border:0;border-radius:12px;padding:12px 13px;font-weight:800;cursor:pointer;min-height:44px}.ka-mic{background:#23475b;color:white}.ka-mic[aria-pressed="true"]{background:#b44428}.ka-send{background:#4eddf0;color:#08242f}
        .ka-mic:disabled,.ka-send:disabled{opacity:.45;cursor:default}.ka-foot{margin:8px 0 0;font-size:11px;color:#a8c3ce;line-height:1.4}
        @media(max-width:380px){.ka-form{gap:5px}.ka-mic,.ka-send{padding:11px 9px}}
      `}</style>
      <div className="ka-top">
        <div><div className="ka-title">🦅 KartaL ile konuş</div><div className="ka-small">Kişisel asistanın · yaz veya konuş</div></div>
        <button className="ka-sound" type="button" onClick={() => { const next = !sound; soundRef.current = next; setSound(next); if (!next && 'speechSynthesis' in window) window.speechSynthesis.cancel(); }} aria-pressed={sound}>
          {sound ? '🔊 Ses açık' : '🔇 Ses kapalı'}
        </button>
      </div>
      <div className="ka-log" ref={scrollRef} aria-label="KartaL sohbeti" aria-live="polite">
        {items.map((item, i) => <div className={`ka-msg ${item.role === 'user' ? 'ka-user' : ''}`} key={i}>
          <span className="ka-who">{item.role === 'user' ? 'SEN' : 'KARTAL'}</span>{item.content}
          {item.sources?.map((source) => <a className="ka-link" key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a>)}
        </div>)}
        {busy && <div className="ka-msg">KartaL düşünüyor…</div>}
      </div>
      <form className="ka-form" onSubmit={(event) => { event.preventDefault(); const message = text.trim(); if (message && !busyRef.current) { setText(''); void send(message); } }}>
        <button className="ka-mic" type="button" aria-label={listening ? 'Dinlemeyi bitir' : 'Konuşmak için mikrofon'} aria-pressed={listening} disabled={busy} onClick={startMic}>{listening ? '⏹' : '🎙️'}</button>
        <label htmlFor="ka-message" className="sr-only">KartaL&apos;a mesaj</label>
        <input className="ka-input" id="ka-message" placeholder="KartaL'a yaz…" autoComplete="off" maxLength={3000} value={text} onChange={(event) => setText(event.target.value)} />
        <button className="ka-send" type="submit" disabled={busy || !text.trim()}>Gönder</button>
      </form>
      <p className="ka-foot">Mikrofon yalnızca dokununca açılır. Mesajların panel ve ücretsiz dış yapay zekâ servislerine gönderilebilir; şifre veya anahtar yazma.</p>
    </section>
  );
}
