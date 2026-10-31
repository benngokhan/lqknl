'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PAYLASIM_KITLERI, type PaylasimKiti } from '@/data/paylasim_kitleri';
import KartalAssistant from '@/components/KartalAssistant';

/* ================= TİPLER (KartalTaskManager ile aynı veri şekli) ================= */

interface WorkerItem {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'err';
  status_text: string;
  updated_at: string;
  telegram_last?: string;
  jobs_done: number;
  last_action: string;
  error_message: string;
}

interface AlertItem {
  id: string;
  title: string;
  status: 'ok' | 'warn' | 'err';
  status_text: string;
  updated_at: string;
  detail: string;
}

interface VideoItem {
  id: string;
  url: string;
  title: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
}

interface StatusReport {
  updated_at: string;
  overall_status: 'ok' | 'warn' | 'err';
  overall_label: string;
  summary: {
    total_views: number;
    subscribers: number;
    total_videos_published: number;
    weekly_uploaded: number;
    total_comments: number;
    total_likes: number;
    failed_jobs: number;
    stock_shorts: number;
    stock_long: number;
  };
  workers: WorkerItem[];
  alerts: AlertItem[];
  videos: VideoItem[];
}

interface Plan {
  sabah: string;
  ogle: string;
  aksam: string;
}

type TabId = 'bugun' | 'videolar' | 'paylasim' | 'gorsel' | 'yazi' | 'kartal' | 'sistem';

interface AgentKomut {
  id: number;
  komut: string;
  durum: string;
  sonuc: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentVeri {
  tablet: { online: boolean; last_seen: string | null };
  bekleyen: number;
  komutlar: AgentKomut[];
}

function agentDurumLabel(d: string): { etiket: string; cls: string } {
  switch (d) {
    case 'BEKLEMEDE': return { etiket: 'Beklemede', cls: 'v2-adot-warn' };
    case 'CALISIYOR': return { etiket: 'Çalışıyor', cls: 'v2-adot-run' };
    case 'BITTI': return { etiket: 'Tamamlandı', cls: 'v2-adot-ok' };
    case 'HATA': return { etiket: 'Hata', cls: 'v2-adot-err' };
    default: return { etiket: d, cls: 'v2-adot-warn' };
  }
}

function timeShort(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const DRIVE_STOK_URL = 'https://drive.google.com/drive/folders/1w8tz_lv7iMFsRRCaTKUSY_ri0F107rz_';

// Yazı stüdyosu — ücretsiz hatlar ve varsayılan modelleri
const YAZI_DEFAULTS: Record<string, string> = {
  openrouter: 'nvidia/nemotron-3-ultra-550b-a55b:free',
  gemini: 'gemini-3.8-flash',
  pollinations: 'openai',
};
const YAZI_HATLAR: Array<[string, string]> = [
  ['openrouter', 'OpenRouter · ücretsiz'],
  ['gemini', 'Gemini · ücretsiz'],
  ['pollinations', 'Yedek · anahtarsız'],
];

/* ================= YARDIMCILAR ================= */

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('tr-TR');
}

function dateTR(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' });
}

function cleanTitle(raw: string): string {
  if (!raw) return 'Başlıksız';
  return raw
    .replace(/#[\wçğıöşüÇĞİÖŞÜ]+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function useCountUp(target: number, dur = 1300): number {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!target) {
      const reset = requestAnimationFrame(() => setVal(0));
      return () => cancelAnimationFrame(reset);
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(target * e));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, dur]);
  return target ? val : 0;
}

interface SlotInfo {
  key: 'sabah' | 'ogle' | 'aksam';
  label: string;
  time: string;
  note: string;
  mins: number | null;
}

function parseSlots(plan: Plan | null): SlotInfo[] {
  const base: SlotInfo[] = [
    { key: 'sabah', label: 'Sabah', time: '', note: 'telafi', mins: null },
    { key: 'ogle', label: 'Öğle', time: '', note: '1. yayın', mins: null },
    { key: 'aksam', label: 'Akşam', time: '', note: '2. yayın', mins: null },
  ];
  if (!plan) return base;
  return base.map((s) => {
    const t = String(plan[s.key] || '').trim();
    const m = /^(\d{1,2}):(\d{2})/.exec(t);
    return { ...s, time: t, mins: m ? +m[1] * 60 + +m[2] : null };
  });
}

function useNextSlot(plan: Plan | null) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const slots = useMemo(() => parseSlots(plan), [plan]);

  const next = useMemo(() => {
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const valid = slots.filter((s) => s.mins != null);
    const today = valid.filter((s) => (s.mins as number) > nowMin).sort((a, b) => (a.mins as number) - (b.mins as number));
    const picked = today[0] || [...valid].sort((a, b) => (a.mins as number) - (b.mins as number))[0] || null;
    if (!picked) return { slot: null as SlotInfo | null, diffMin: 0, tomorrow: false };
    let diff = (picked.mins as number) - nowMin;
    let tomorrow = false;
    if (diff <= 0) {
      diff += 1440;
      tomorrow = true;
    }
    return { slot: picked, diffMin: diff, tomorrow };
  }, [slots, now]);

  return { slots, next, now };
}

/* ================= KÜÇÜK BİLEŞENLER ================= */

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <div className="v2-spark-empty">yeterli veri yok</div>;
  }
  const w = 132;
  const h = 42;
  const pad = 4;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i * (w - pad * 2)) / (values.length - 1);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return { x, y };
  });
  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${pad},${h - pad} ${line} ${w - pad},${h - pad}`;
  const last = pts[pts.length - 1];
  return (
    <svg className="v2-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden>
      <polygon points={area} fill="url(#v2sp)" opacity="0.35" />
      <defs>
        <linearGradient id="v2sp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#C6F52E" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#C6F52E" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={line} fill="none" stroke="#C6F52E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last.x} cy={last.y} r="3" fill="#C6F52E">
        <animate attributeName="r" values="3;4.5;3" dur="1.6s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

function Ring({ pct, title, sub }: { pct: number; title: string; sub: string }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const off = c - (Math.min(100, Math.max(0, pct)) / 100) * c;
  return (
    <div className="v2-ring-wrap">
      <svg viewBox="0 0 84 84" width="84" height="84">
        <circle cx="42" cy="42" r={r} stroke="rgba(255,255,255,0.08)" strokeWidth="7" fill="none" />
        <circle
          cx="42"
          cy="42"
          r={r}
          stroke="#C6F52E"
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={off}
          transform="rotate(-90 42 42)"
          style={{ filter: 'drop-shadow(0 0 6px rgba(198,245,46,0.55))', transition: 'stroke-dashoffset 1s ease' }}
        />
        <text x="42" y="40" textAnchor="middle" className="v2-ring-num">{Math.round(pct)}%</text>
        <text x="42" y="53" textAnchor="middle" className="v2-ring-lbl">stok</text>
      </svg>
      <div>
        <div className="v2-ring-title">{title}</div>
        <div className="v2-ring-sub">{sub}</div>
      </div>
    </div>
  );
}

function Dot({ status }: { status: 'ok' | 'warn' | 'err' }) {
  const cls = status === 'ok' ? 'v2-dot-ok' : status === 'warn' ? 'v2-dot-warn' : 'v2-dot-err';
  return <span className={`v2-dot ${cls}`} />;
}

/* ================= ANA SAYFA ================= */

export default function PanelV2Page() {
  const [tab, setTab] = useState<TabId>('bugun');
  const [report, setReport] = useState<StatusReport | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [lastUploadFile, setLastUploadFile] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  /* ===== Görsel stüdyosu (Gemini: metin→görsel / görsel→görsel) ===== */
  const [imgPrompt, setImgPrompt] = useState('');
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [imgMime, setImgMime] = useState('image/png');
  const [imgAspect, setImgAspect] = useState('16:9');
  const [imgProvider, setImgProvider] = useState('auto');
  const [imgBusy, setImgBusy] = useState(false);
  const [imgResult, setImgResult] = useState<{ b64: string; mime: string; provider: string } | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);

  /* ===== Yazı stüdyosu (OpenRouter sohbet — kişisel) ===== */
  const [chatMsgs, setChatMsgs] = useState<{ role: string; content: string }[]>(() => {
    try {
      if (typeof window === 'undefined') return [];
      const s = window.localStorage.getItem('v2_yazi_chat');
      return s ? (JSON.parse(s) as { role: string; content: string }[]) : [];
    } catch {
      return [];
    }
  });
  const [chatSystem, setChatSystem] = useState(
    () => (typeof window === 'undefined' ? '' : localStorage.getItem('v2_yazi_sys') || ''),
  );
  const [chatProvider, setChatProvider] = useState<string>(() => {
    try {
      if (typeof window === 'undefined') return 'openrouter';
      return (localStorage.getItem('v2_yazi_prov') as string) || 'openrouter';
    } catch {
      return 'openrouter';
    }
  });
  const [chatModel, setChatModel] = useState<string>(() => {
    try {
      if (typeof window === 'undefined') return YAZI_DEFAULTS.openrouter;
      const p = (localStorage.getItem('v2_yazi_prov') as string) || 'openrouter';
      return localStorage.getItem(`v2_yazi_model_${p}`) || YAZI_DEFAULTS[p] || YAZI_DEFAULTS.openrouter;
    } catch {
      return YAZI_DEFAULTS.openrouter;
    }
  });
  const switchChatProv = (p: string) => {
    setChatProvider(p);
    try { localStorage.setItem('v2_yazi_prov', p); } catch { /* yok say */ }
    setChatModel(
      (() => {
        try {
          return localStorage.getItem(`v2_yazi_model_${p}`) || YAZI_DEFAULTS[p] || YAZI_DEFAULTS.openrouter;
        } catch {
          return YAZI_DEFAULTS.openrouter;
        }
      })(),
    );
  };
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState('');
  const [chatHasKey, setChatHasKey] = useState<boolean | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch('/api/chat/openrouter/key')
      .then((r) => r.json())
      .then((j) => setChatHasKey(Boolean(j.hasKey)))
      .catch(() => setChatHasKey(null));
  }, []);

  const saveChatKey = async () => {
    if (!chatKey.trim()) return;
    const res = await fetch('/api/chat/openrouter/key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: chatKey.trim() }),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (res.ok && j.ok) {
      setChatHasKey(true);
      setChatKey('');
      setChatError(null);
    } else {
      setChatError(j.error || 'Anahtar kaydedilemedi.');
    }
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chatMsgs, chatBusy]);

  const saveChat = (msgs: { role: string; content: string }[]) => {
    setChatMsgs(msgs);
    try { localStorage.setItem('v2_yazi_chat', JSON.stringify(msgs.slice(-60))); } catch { /* dolu olabilir */ }
  };

  /* Sesli okuma — panelin mevcut TTS altyapısı (Mira'nın sesi) */
  const [speakingIdx, setSpeakingIdx] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speakMsg = async (text: string, idx: number) => {
    if (speakingIdx === idx) {
      audioRef.current?.pause();
      audioRef.current = null;
      setSpeakingIdx(null);
      return;
    }
    audioRef.current?.pause();
    setSpeakingIdx(idx);
    setChatError(null);
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 4800) }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = () => { setSpeakingIdx(null); URL.revokeObjectURL(url); };
      a.onerror = () => { setSpeakingIdx(null); URL.revokeObjectURL(url); };
      await a.play();
    } catch (e) {
      setChatError(e instanceof Error ? e.message : String(e));
      setSpeakingIdx(null);
    }
  };

  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    setChatBusy(true);
    setChatError(null);
    const withUser = [...chatMsgs, { role: 'user', content: text }];
    saveChat(withUser);
    setChatInput('');
    try {
      const res = await fetch('/api/chat/openrouter', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: withUser, system: chatSystem, model: chatModel, provider: chatProvider }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; content?: string; error?: string };
      if (!j.ok || !j.content) throw new Error(j.error || `HTTP ${res.status}`);
      saveChat([...withUser, { role: 'assistant', content: j.content }]);
    } catch (e) {
      setChatError(e instanceof Error ? e.message : String(e));
    } finally {
      setChatBusy(false);
    }
  };

  const onImgFile = (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) {
      setImgError('Sadece görsel dosyası kabul edilir (jpg/png/webp).');
      return;
    }
    if (f.size > 8 * 1024 * 1024) {
      setImgError('Görsel en fazla 8MB olabilir.');
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      setImgSrc(String(r.result));
      setImgMime(f.type);
      setImgError(null);
    };
    r.readAsDataURL(f);
  };

  const genImage = async () => {
    if (!imgPrompt.trim() && !imgSrc) return;
    setImgBusy(true);
    setImgError(null);
    try {
      const res = await fetch('/api/image/gemini', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: imgPrompt.trim(),
          image_base64: imgSrc || undefined,
          mime_type: imgMime,
          aspect: imgAspect,
          provider: imgProvider,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; image_base64?: string; mime_type?: string; provider?: string; error?: string };
      if (!j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setImgResult({ b64: String(j.image_base64 || ''), mime: j.mime_type || 'image/png', provider: j.provider || 'gemini' });
    } catch (e) {
      setImgError(e instanceof Error ? e.message : String(e));
    } finally {
      setImgBusy(false);
    }
  };

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const [repR, planR] = await Promise.all([
        fetch(`/api/kartal/status?t=${Date.now()}`, { cache: 'no-store' }),
        fetch(`/api/automation/schedule?t=${Date.now()}`, { cache: 'no-store' }).catch(() => null),
      ]);
      if (repR.ok) {
        const data = await repR.json();
        if (data?.ok && data.report) {
          setReport(data.report as StatusReport);
          if (data.last_upload_file) setLastUploadFile(String(data.last_upload_file));
        } else {
          setErr(data?.error || 'Durum verisi alınamadı');
        }
      } else {
        setErr('Durum verisi alınamadı');
      }
      if (planR && planR.ok) {
        const d = await planR.json().catch(() => null);
        if (d?.ok && d.slots) setPlan(d.slots as Plan);
      }
    } catch {
      setErr('Bağlantı hatası');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => void load(), 0);
    const id = setInterval(() => void load(true), 60_000);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [load]);

  const { slots, next } = useNextSlot(plan);

  const totalViews = useCountUp(report?.summary?.total_views ?? 0);

  const sparkValues = useMemo(() => {
    const vs = [...(report?.videos || [])]
      .filter((v) => v.publishedAt)
      .sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
    return vs.slice(-7).map((v) => v.views ?? 0);
  }, [report]);

  const nextVideo = useMemo(() => {
    const fromUpload = /video[_\s-]*(\d+)/i.exec(lastUploadFile || '');
    if (fromUpload) return `video_${+fromUpload[1] + 1}`;
    let maxN = 0;
    for (const v of report?.videos || []) {
      const m = /video[_\s-]*(\d+)/i.exec(v.title || v.id || '');
      if (m) maxN = Math.max(maxN, +m[1]);
    }
    return maxN > 0 ? `video_${maxN + 1}` : null;
  }, [report, lastUploadFile]);

  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'views' | 'new'>('views');
  const videos = useMemo(() => {
    let list = [...(report?.videos || [])];
    const needle = q.trim().toLocaleLowerCase('tr');
    if (needle) list = list.filter((v) => (v.title || '').toLocaleLowerCase('tr').includes(needle));
    list.sort((a, b) =>
      sort === 'views' ? (b.views ?? 0) - (a.views ?? 0) : new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );
    return list;
  }, [report, q, sort]);

  const siraKits = useMemo(
    () => PAYLASIM_KITLERI.filter((k) => k.durum === 'sira').sort((a, b) => a.no - b.no),
    []
  );
  const yayindaKits = useMemo(() => PAYLASIM_KITLERI.filter((k) => k.durum === 'yayinda'), []);

  const [copied, setCopied] = useState<string | null>(null);
  const copyKit = useCallback(async (kind: 'caption' | 'yorum', k: PaylasimKiti) => {
    const text = kind === 'caption' ? k.caption : k.yorum;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* yoksay */
      }
      document.body.removeChild(ta);
    }
    const key = `${k.no}-${kind}`;
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
  }, []);

  const stockShorts = report?.summary?.stock_shorts ?? null;
  const stockDays = stockShorts != null ? Math.max(1, Math.round(stockShorts / 2)) : null;
  const stockPct = stockShorts != null ? Math.min(100, (stockShorts / 100) * 100) : 0;

  const workers = report?.workers || [];
  const alerts = report?.alerts || [];
  const badWorkers = workers.filter((w) => w.status !== 'ok');
  const badAlerts = alerts.filter((a) => a.status !== 'ok');
  const sifa = badWorkers.length === 0 && badAlerts.length === 0;

  /* ===== KartaL ajan — panel → tablet komut kuyruğu ===== */
  const [agentVeri, setAgentVeri] = useState<AgentVeri | null>(null);
  const [agentKomut, setAgentKomut] = useState('');
  const [agentGonderiliyor, setAgentGonderiliyor] = useState(false);
  const [agentErr, setAgentErr] = useState('');
  const [showLegacyAgent, setShowLegacyAgent] = useState(false);

  const loadAgent = useCallback(async () => {
    try {
      const r = await fetch(`/api/kartal/agent/status?t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        if (d?.ok) setAgentVeri(d as AgentVeri);
      }
    } catch {
      /* tablet hattı geçici olarak erişilemedi */
    }
  }, []);

  useEffect(() => {
    if (tab !== 'kartal' || !showLegacyAgent) return;
    const initial = setTimeout(() => void loadAgent(), 0);
    const id = setInterval(() => void loadAgent(), 5000);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [tab, loadAgent, showLegacyAgent]);

  const agentGonder = useCallback(
    async (metin?: string) => {
      const k = (metin ?? agentKomut).trim();
      if (!k || agentGonderiliyor) return;
      if (/(?:sil|yayınla|paylaş|mesaj.*gönder|mail.*gönder|ödeme|havale|satın al)/iu.test(k) && !window.confirm('Bu eski tablet komutu silme, yayın, ödeme veya dışa mesaj içerebilir. Devam edilsin mi?')) return;
      setAgentGonderiliyor(true);
      setAgentErr('');
      try {
        const r = await fetch('/api/kartal/agent/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ komut: k }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error || 'Komut gönderilemedi');
        setAgentKomut('');
        loadAgent();
      } catch (e) {
        setAgentErr(e instanceof Error ? e.message : 'Komut gönderilemedi');
      } finally {
        setAgentGonderiliyor(false);
      }
    },
    [agentKomut, agentGonderiliyor, loadAgent]
  );

  const AGENT_CHIPS = [
    'YouTube kanalını aç',
    'YouTube kanalını aç, analiz et',
    'Chrome\u2019da Arena\u2019yı aç',
    'Mail\u2019leri kontrol et',
  ];

  return (
    <div className="v2-root">
      <style>{CSS}</style>

      <div className="v2-aurora" aria-hidden>
        <div className="v2-blob v2-blob-a" />
        <div className="v2-blob v2-blob-b" />
        <div className="v2-blob v2-blob-c" />
      </div>

      <div className="v2-shell">
        {/* ÜST BAR */}
        <header className="v2-top">
          <div className="v2-brand">
            <span className="v2-brand-badge">v2</span>
            <div>
              <div className="v2-brand-name">Bilgi Dozu</div>
              <div className="v2-brand-sub">
                <Dot status={report ? report.overall_status : 'ok'} />
                {report ? report.overall_label : 'bağlanıyor…'}
              </div>
            </div>
          </div>
          <button className="v2-refresh" onClick={() => load()} disabled={refreshing} title="Yenile">
            <svg viewBox="0 0 24 24" width="17" height="17" className={refreshing ? 'v2-spin' : ''}>
              <path
                d="M20 11A8 8 0 1 0 20.5 14M20 5v6h-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </header>

        {err && !report && (
          <div className="v2-card v2-errcard">
            <div className="v2-errtitle">Veri alınamadı</div>
            <div className="v2-errsub">{err} — tekrar dene</div>
            <button className="v2-btn v2-btn-primary" onClick={() => load()}>Tekrar Dene</button>
          </div>
        )}

        {!report && !err && (
          <>
            <div className="v2-card v2-skel" />
            <div className="v2-card v2-skel" style={{ height: 120 }} />
            <div className="v2-card v2-skel" style={{ height: 80 }} />
          </>
        )}

        {/* ===== BUGÜN ===== */}
        {report && tab === 'bugun' && (
          <main className="v2-main">
            <section className="v2-card v2-hero">
              <div className="v2-hero-label">TOPLAM GÖRÜNTÜLENME</div>
              <div className="v2-hero-num">{fmt(totalViews)}</div>
              <div className="v2-hero-foot">
                <div className="v2-hero-stat">
                  <b>{fmt(report.summary.weekly_uploaded)}</b>
                  <span>bu hafta</span>
                </div>
                <div className="v2-hero-stat">
                  <b>{fmt(report.summary.total_comments)}</b>
                  <span>yorum</span>
                </div>
                <div className="v2-hero-stat">
                  <b>{fmt(report.summary.subscribers)}</b>
                  <span>abone</span>
                </div>
              </div>
              <div className="v2-hero-spark">
                <Sparkline values={sparkValues} />
                <div className="v2-spark-note">son 7 video · view</div>
              </div>
            </section>

            <section className="v2-card">
              <div className="v2-sechead">
                <span>Yayın Slotları</span>
                {next.slot && (
                  <span className="v2-live">
                    ⏱ {next.tomorrow ? 'yarın ' : ''}
                    {next.slot.time} · {Math.floor(next.diffMin / 60)} sa {String(next.diffMin % 60).padStart(2, '0')} dk
                  </span>
                )}
              </div>
              <div className="v2-slots">
                {slots.map((s) => {
                  const active = next.slot?.key === s.key;
                  return (
                    <div key={s.key} className={`v2-slot ${active ? 'v2-slot-active' : ''}`}>
                      <div className="v2-slot-time">{s.time || '—:—'}</div>
                      <div className="v2-slot-name">{s.label}</div>
                      <div className="v2-slot-note">{active ? 'SIRADA' : s.note}</div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="v2-card v2-nextcard">
              <div className="v2-next-label">SIRADAKİ YAYIN</div>
              <div className="v2-next-file">🎬 {nextVideo || '—'}</div>
              <div className="v2-next-sub">stok {report.summary.stock_shorts} Shorts · {report.summary.stock_long} Uzun</div>
            </section>
          </main>
        )}

        {/* ===== VİDEOLAR ===== */}
        {report && tab === 'videolar' && (
          <main className="v2-main">
            <div className="v2-card">
              <input
                className="v2-search"
                placeholder="Video ara…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <div className="v2-chips">
                <button className={`v2-chip ${sort === 'views' ? 'v2-chip-on' : ''}`} onClick={() => setSort('views')}>
                  🔥 En çok izlenen
                </button>
                <button className={`v2-chip ${sort === 'new' ? 'v2-chip-on' : ''}`} onClick={() => setSort('new')}>
                  🆕 Yeni
                </button>
              </div>
            </div>

            <div className="v2-vlist">
              {videos.map((v, i) => (
                <a key={v.id || i} href={v.url || undefined} target="_blank" rel="noopener noreferrer" className="v2-card v2-vrow">
                  <div className="v2-vrank">{i + 1}</div>
                  <div className="v2-vbody">
                    <div className="v2-vtitle">
                      {cleanTitle(v.title)}
                      {i === 0 && <span className="v2-vbadge">EN İYİ</span>}
                    </div>
                    <div className="v2-vmeta">
                      {dateTR(v.publishedAt)} · 👁 {fmt(v.views)} · 👍 {fmt(v.likes)} · 💬 {fmt(v.comments)}
                    </div>
                  </div>
                </a>
              ))}
              {videos.length === 0 && <div className="v2-empty">Sonuç yok</div>}
            </div>
          </main>
        )}

        {/* ===== PAYLAŞIM ===== */}
        {tab === 'paylasim' && (
          <main className="v2-main">
            <section className="v2-card">
              <div className="v2-sechead"><span>Kurallar</span><span className="v2-live">her yayında</span></div>
              <div className="v2-rules">
                <span className="v2-rule">🔌 VPN kapalı</span>
                <span className="v2-rule">⏰ günde ≤ 2 (12:45 · 21:45)</span>
                <span className="v2-rule">⏳ 10-15 dk bekle</span>
                <span className="v2-rule">📌 sabit yorum = ilk + pinle</span>
              </div>
            </section>

            {siraKits.map((k) => (
              <section key={k.no} className="v2-card v2-kit v2-kit-sira">
                <div className="v2-kit-top">
                  <div>
                    <div className="v2-kit-file">{k.driveAdi}</div>
                    <div className="v2-kit-sub">Drive: {k.driveAdi} · plan: {k.gunSlot !== '—' ? k.gunSlot : 'yayında'}</div>
                  </div>
                  <span className="v2-sira-badge">SIRA {siraKits.indexOf(k) + 1}</span>
                </div>
                <div className="v2-kit-title">{cleanTitle(k.title)}</div>
                <div className="v2-kit-caption">{k.caption}</div>
                <div className="v2-copyrow">
                  <button
                    className={`v2-btn ${copied === `${k.no}-caption` ? 'v2-btn-copied' : 'v2-btn-primary'}`}
                    onClick={() => copyKit('caption', k)}
                  >
                    {copied === `${k.no}-caption` ? '✓ Kopyalandı' : '📋 Açıklamayı Kopyala'}
                  </button>
                  <button
                    className={`v2-btn ${copied === `${k.no}-yorum` ? 'v2-btn-copied' : 'v2-btn-ghost'}`}
                    onClick={() => copyKit('yorum', k)}
                  >
                    {copied === `${k.no}-yorum` ? '✓ Kopyalandı' : '💬 Yorumu Kopyala'}
                  </button>
                </div>
                <a className="v2-drivelink" href={DRIVE_STOK_URL} target="_blank" rel="noopener noreferrer">
                  📁 Drive “KartaL Stok” klasörü — {k.driveAdi}
                </a>
              </section>
            ))}

            {siraKits.length === 0 && (
              <div className="v2-card v2-empty">Sıradaki paylaşım yok — hepsi yayında 🎉</div>
            )}

            <div className="v2-donehead">
              <span>Yayında</span>
              <span>{yayindaKits.length}</span>
            </div>
            {yayindaKits.map((k) => (
              <div key={k.no} className="v2-card v2-kitsmall">
                <span className="v2-kit-ok">✓</span>
                <div className="v2-vbody">
                  <div className="v2-vtitle">{k.driveAdi}</div>
                  <div className="v2-vmeta">{cleanTitle(k.title)}</div>
                </div>
              </div>
            ))}
          </main>
        )}

        {/* ===== KARTAL AJAN ===== */}
        {tab === 'kartal' && (
          <main className="v2-main">
            <KartalAssistant />
            <details onToggle={(event) => setShowLegacyAgent(event.currentTarget.open)}>
              <summary style={{cursor:'pointer', color:'#acc6cd', margin:'14px 0', fontSize:13}}>Eski tablet komut kuyruğu · bağlantı doğrulanmadı</summary>
            <section className="v2-card v2-hero">
              <div className="v2-hero-label">KARTA AJAN · TABLET KÖPRÜSÜ</div>
              <div className="v2-agent-title">Panele yaz, tablet yapsın</div>
              <div className={`v2-agent-status ${agentVeri?.tablet?.online ? 'v2-agent-on' : 'v2-agent-off'}`}>
                <span className={`v2-agent-led ${agentVeri?.tablet?.online ? 'on' : 'off'}`} />
                {agentVeri?.tablet?.online
                  ? 'Son tablet bağlantısı görülmüş; sonucu ayrıca kontrol et'
                  : 'Tablet bağlantısı doğrulanamadı; komutun çalıştığı varsayılmamalı'}
              </div>
            </section>

            <section className="v2-card">
              <div className="v2-sechead">
                <span>Komut Ver</span>
                {(agentVeri?.bekleyen ?? 0) > 0 && <span className="v2-live">{agentVeri!.bekleyen} sırada</span>}
              </div>
              <input
                className="v2-search"
                placeholder="Örn: YouTube kanalını aç, analiz et"
                value={agentKomut}
                onChange={(e) => setAgentKomut(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') agentGonder();
                }}
                maxLength={300}
              />
              <div className="v2-chips">
                {AGENT_CHIPS.map((s) => (
                  <button key={s} className="v2-chip" onClick={() => agentGonder(s)}>
                    {s}
                  </button>
                ))}
              </div>
              {agentErr && <div className="v2-agent-err">⚠️ {agentErr}</div>}
              <button
                className="v2-btn v2-btn-primary v2-agent-send"
                disabled={agentGonderiliyor || !agentKomut.trim()}
                onClick={() => agentGonder()}
              >
                {agentGonderiliyor ? 'Gönderiliyor…' : '📣 KartaL\u2019a Gönder'}
              </button>
            </section>

            <div className="v2-donehead">
              <span>Geçmiş</span>
              <span>{agentVeri?.komutlar.length ?? 0}</span>
            </div>
            {!agentVeri && <div className="v2-card v2-empty">Kuyruk yükleniyor…</div>}
            {agentVeri && agentVeri.komutlar.length === 0 && (
              <div className="v2-card v2-empty">Henüz komut yok — yukarıdan ilkini ver</div>
            )}
            {agentVeri?.komutlar.map((k) => {
              const d = agentDurumLabel(k.durum);
              return (
                <div key={k.id} className="v2-card v2-kitsmall">
                  <span className={`v2-agent-dot ${d.cls}`}>
                    {k.durum === 'BITTI' ? '✓' : k.durum === 'HATA' ? '✗' : k.durum === 'CALISIYOR' ? '⚙' : '…'}
                  </span>
                  <div className="v2-vbody">
                    <div className="v2-vtitle">{k.komut}</div>
                    <div className="v2-vmeta">
                      <b className={`v2-agent-durum ${d.cls}`}>{d.etiket}</b> · {timeShort(k.updated_at)}
                      {k.sonuc ? ` — ${k.sonuc}` : ''}
                    </div>
                  </div>
                </div>
              );
            })}
            </details>
          </main>
        )}

        {/* ===== SİSTEM ===== */}
        {report && tab === 'sistem' && (
          <main className="v2-main">
            <section className="v2-card">
              <div className="v2-sechead"><span>Sistem Durumu</span></div>
              {sifa ? (
                <div className="v2-okline">🩺 Uyarı yok — her şey çalışıyor</div>
              ) : (
                <div className="v2-warnline">
                  ⚠️ {badWorkers.length + badAlerts.length} unsur dikkat istiyor
                </div>
              )}
              <div className="v2-sysmeta">
                <div className="v2-hero-stat"><b>{fmt(report.summary.failed_jobs)}</b><span>hata</span></div>
                <div className="v2-hero-stat"><b>{fmt(report.summary.stock_shorts)}</b><span>Shorts stok</span></div>
                <div className="v2-hero-stat"><b>{fmt(report.summary.stock_long)}</b><span>Uzun stok</span></div>
              </div>
            </section>

            <section className="v2-card">
              <div className="v2-sechead"><span>Stok Ömrü</span></div>
              <Ring
                pct={stockPct}
                title={stockDays != null ? `≈ ${stockDays} gün stok` : '—'}
                sub={`günde 2 Shorts varsayımı · ${stockShorts ?? '—'} Shorts`}
              />
            </section>

            <section className="v2-card">
              <div className="v2-sechead"><span>İşçiler</span></div>
              <div className="v2-wlist">
                {workers.map((w) => (
                  <div key={w.id} className="v2-wrow">
                    <Dot status={w.status} />
                    <div className="v2-vbody">
                      <div className="v2-vtitle">{w.name}</div>
                      <div className="v2-vmeta">{w.status_text}{w.last_action ? ` · ${w.last_action}` : ''}</div>
                    </div>
                  </div>
                ))}
                {workers.length === 0 && <div className="v2-empty">İşçi kaydı yok</div>}
              </div>
            </section>

            <section className="v2-card">
              <div className="v2-sechead"><span>Uyarılar</span></div>
              <div className="v2-wlist">
                {alerts.map((a) => (
                  <div key={a.id} className="v2-wrow">
                    <Dot status={a.status} />
                    <div className="v2-vbody">
                      <div className="v2-vtitle">{a.title}</div>
                      <div className="v2-vmeta">{a.status_text}</div>
                    </div>
                  </div>
                ))}
                {alerts.length === 0 && <div className="v2-empty">Kayıtlı uyarı yok</div>}
              </div>
            </section>

            <div className="v2-foot">
              son güncelleme {String(report.updated_at || '—').replace('T', ' ').slice(0, 16)} ·{' '}
              <a href="/panel" className="v2-backlink">eski panele dön ↩</a>
            </div>
          </main>
        )}

        {/* ===== GÖRSEL STÜDYOSU ===== */}
        {tab === 'gorsel' && (
          <main className="v2-main">
            <section className="v2-card">
              <div className="v2-sechead"><span>Görsel Stüdyosu</span><span className="v2-live">Gemini</span></div>
              <div className="v2-imglabel">Metinden görsel üret ya da bir görsel yükleyip dönüştür — kapak, sahne, konsept.</div>
              <textarea
                className="v2-imgprompt"
                rows={3}
                placeholder="Örn: 103. yıl Cumhuriyet coşkusu, hologram geometri şekilleri, koyu teal arka plan, sinematik ışık, 3D illüstrasyon"
                value={imgPrompt}
                onChange={(e) => setImgPrompt(e.target.value)}
              />
              <div className="v2-imgrow">
                <label className="v2-imgfile">
                  <input type="file" accept="image/*" onChange={(e) => onImgFile(e.target.files?.[0])} />
                  {imgSrc ? '🖼 Görsel yüklü (değiştirmek için tıkla)' : '🖼 Görsel ekle — görselden görsel (opsiyonel)'}
                </label>
              </div>
              {imgSrc && <img className="v2-imgprev" src={imgSrc} alt="giriş görseli" />}
              <div className="v2-imgrow">
                {['16:9', '9:16', '1:1'].map((a) => (
                  <button key={a} className={`v2-chip ${imgAspect === a ? 'v2-chip-on' : ''}`} onClick={() => setImgAspect(a)}>
                    {a}
                  </button>
                ))}
                {[
                  { v: 'auto', l: 'Oto' },
                  { v: 'gemini', l: 'Gemini' },
                  { v: 'pollinations', l: 'Yedek' },
                ].map((p) => (
                  <button key={p.v} className={`v2-chip ${imgProvider === p.v ? 'v2-chip-on' : ''}`} onClick={() => setImgProvider(p.v)} title="Üretim hattı">
                    {p.l}
                  </button>
                ))}
                <button
                  className="v2-imggen"
                  disabled={imgBusy || (!imgPrompt.trim() && !imgSrc)}
                  onClick={genImage}
                >
                  {imgBusy ? 'Üretiliyor…' : '✨ Üret'}
                </button>
              </div>
              {imgBusy && <div className="v2-empty">Görsel üretiliyor — 10-40 sn sürebilir</div>}
              {imgError && !imgBusy && <div className="v2-errline">⚠️ {imgError}</div>}
            </section>

            {imgResult && (
              <section className="v2-card">
                <div className="v2-sechead">
                  <span>Sonuç {imgResult.provider === 'pollinations' ? '· yedek hat (Pollinations)' : '· Gemini'}</span>
                  <a className="v2-backlink" download="gorsel.png" href={`data:${imgResult.mime};base64,${imgResult.b64}`}>
                    ⬇ İndir
                  </a>
                </div>
                <img className="v2-imgout" src={`data:${imgResult.mime};base64,${imgResult.b64}`} alt="üretilen görsel" />
              </section>
            )}
          </main>
        )}

        {tab === 'yazi' && (
          <main className="v2-main">
          <section className="v2-card">
            <div className="v2-sechead"><span>Yazı Stüdyosu</span><span className="v2-live">ücretsiz 3 hat</span></div>
            <div className="v2-imglabel">Serbest metin sohbeti — senin için, panel şifresi arkasında. Hat seç, modelini gerekirse değiştir.</div>
            <div className="v2-imgrow" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {YAZI_HATLAR.map(([p, l]) => (
                <button key={p} className={`v2-chip ${chatProvider === p ? 'v2-chip-on' : ''}`} onClick={() => switchChatProv(p)}>
                  {l}
                </button>
              ))}
              <button
                className="v2-chip"
                onClick={() => { if (confirm('Sohbeti temizle?')) { saveChat([]); setChatError(null); } }}
                title="Sohbeti temizle"
              >
                🗑 Temizle
              </button>
            </div>
            <div className="v2-imgrow" style={{ marginTop: 6, gap: 8 }}>
              <input
                className="v2-imgprompt"
                style={{ flex: 1, minWidth: 200, padding: 8 }}
                value={chatModel}
                onChange={(e) => { setChatModel(e.target.value); try { localStorage.setItem(`v2_yazi_model_${chatProvider}`, e.target.value); } catch { /* yok say */ } }}
                placeholder={`model (${YAZI_DEFAULTS[chatProvider] || 'varsayılan'})`}
              />
            </div>
                <details style={{ margin: '8px 0' }}>
                  <summary style={{ cursor: 'pointer', color: 'rgba(255,255,255,.55)', fontSize: 12 }}>
                    🔑 API Anahtarı {chatHasKey === true ? '— kayıtlı ✓' : chatHasKey === false ? '— tanımlı değil' : '…'}
                  </summary>
                  <div className="v2-imgrow" style={{ marginTop: 6, gap: 8 }}>
                    <input
                      className="v2-imgprompt"
                      style={{ flex: 1, padding: 8 }}
                      type="password"
                      placeholder="sk-or- ... (yalnızca sen görürsün; sunucuda veritabanında kalır)"
                      value={chatKey}
                      onChange={(e) => setChatKey(e.target.value)}
                    />
                    <button className="v2-chip" onClick={() => void saveChatKey()} disabled={!chatKey.trim()}>
                      Kaydet
                    </button>
                  </div>
                </details>
            <details style={{ margin: '8px 0' }}>
              <summary style={{ cursor: 'pointer', color: 'rgba(255,255,255,.55)', fontSize: 12 }}>Karakter / talimat (opsiyonel)</summary>
              <textarea
                className="v2-imgprompt"
                rows={2}
                style={{ marginTop: 6 }}
                placeholder="Örn: Kısa, net ve düz Türkçe cevap ver."
                value={chatSystem}
                onChange={(e) => { setChatSystem(e.target.value); localStorage.setItem('v2_yazi_sys', e.target.value); }}
              />
            </details>
            <div
              style={{
                maxHeight: 420, overflowY: 'auto', border: '1px solid rgba(255,255,255,.08)',
                borderRadius: 12, padding: 10, marginBottom: 8, background: 'rgba(0,0,0,.2)',
              }}
            >
              {chatMsgs.length === 0 && !chatBusy && (
                <div className="v2-empty" style={{ padding: 24 }}>Henüz mesaj yok — aşağıdan yaz, ilk mesajı gönder.</div>
              )}
              {chatMsgs.map((m, i) => (
                <div
                  key={i}
                  style={{
                    margin: '8px 0', padding: '8px 10px', borderRadius: 10,
                    background: m.role === 'user' ? 'rgba(251,191,36,.12)' : 'rgba(255,255,255,.05)',
                    borderLeft: m.role === 'user' ? '3px solid #fbbf24' : '3px solid rgba(255,255,255,.2)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                    <span style={{ fontSize: 11, opacity: .55 }}>{m.role === 'user' ? 'SEN' : 'YANIT'}</span>
                    {m.role === 'assistant' && (
                      <button
                        onClick={() => void speakMsg(m.content, i)}
                        disabled={!m.content.trim()}
                        title={speakingIdx === i ? 'Durdur' : 'Sesli oku'}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer', fontSize: 13,
                          opacity: speakingIdx === i ? 1 : .55, padding: 0, lineHeight: 1,
                        }}
                      >
                        {speakingIdx === i ? '⏹ Durdur' : '🔊 Oku'}
                      </button>
                    )}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 14, lineHeight: 1.45 }}>
                    {m.content}
                  </div>
                </div>
              ))}
              {chatBusy && <div className="v2-empty">Düşünüyor… (0-2 dk sürebilir)</div>}
              <div ref={chatEndRef} />
            </div>
            {chatError && !chatBusy && <div className="v2-errline">⚠️ {chatError}</div>}
            <div className="v2-imgrow" style={{ gap: 8 }}>
              <textarea
                className="v2-imgprompt"
                rows={2}
                style={{ flex: 1, padding: 8 }}
                placeholder="Mesajını yaz… (Enter = gönder, Shift+Enter = satır)"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendChat(); } }}
              />
              <button
                className="v2-imggen"
                disabled={chatBusy || !chatInput.trim()}
                onClick={() => void sendChat()}
                style={{ alignSelf: 'flex-end' }}
              >
                {chatBusy ? '…' : '➤ Gönder'}
              </button>
            </div>
          </section>
          </main>
        )}
      </div>

      {/* ALT NAV */}
      <nav className="v2-nav">
        {(
          [
            { id: 'bugun', icon: '📊', label: 'Bugün' },
            { id: 'videolar', icon: '🎬', label: 'Videolar' },
            { id: 'paylasim', icon: '📤', label: 'Paylaşım' },
            { id: 'gorsel', icon: '🎨', label: 'Görsel' },
            { id: 'yazi', icon: '💬', label: 'Yazı' },
            { id: 'kartal', icon: '🤖', label: 'KartaL' },
            { id: 'sistem', icon: '⚙️', label: 'Sistem' },
          ] as { id: TabId; icon: string; label: string }[]
        ).map((t) => (
          <button key={t.id} className={`v2-navitem ${tab === t.id ? 'v2-navitem-on' : ''}`} onClick={() => setTab(t.id)}>
            <span className="v2-navicon">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/* ================= STİLLER (scoped: v2- öneki) ================= */

const CSS = `
.v2-root { position: relative; min-height: 100dvh; background: #07090D; color: #F4F7FB;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  overflow-x: hidden; }
.v2-root a { color: inherit; text-decoration: none; }

/* --- aurora --- */
.v2-aurora { position: fixed; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; }
.v2-blob { position: absolute; width: 60vmax; height: 60vmax; border-radius: 50%; filter: blur(90px); opacity: .5; }
.v2-blob-a { background: radial-gradient(circle, rgba(198,245,46,.28), transparent 60%); top: -25vmax; left: -18vmax; animation: v2drift 26s ease-in-out infinite alternate; }
.v2-blob-b { background: radial-gradient(circle, rgba(34,211,238,.22), transparent 60%); bottom: -28vmax; right: -20vmax; animation: v2drift 32s ease-in-out infinite alternate-reverse; }
.v2-blob-c { background: radial-gradient(circle, rgba(124,58,237,.20), transparent 60%); top: 30%; left: 35%; animation: v2drift 38s ease-in-out infinite alternate; }
@keyframes v2drift { from { transform: translate(0,0) scale(1); } to { transform: translate(9vmax, 7vmax) scale(1.15); } }

/* --- shell --- */
.v2-shell { position: relative; z-index: 1; max-width: 480px; margin: 0 auto; padding: 18px 16px 110px; }
.v2-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.v2-brand { display: flex; align-items: center; gap: 10px; }
.v2-brand-badge { background: #C6F52E; color: #0A0C10; font-weight: 800; font-size: 11px; letter-spacing: .06em;
  padding: 4px 7px; border-radius: 8px; box-shadow: 0 0 18px rgba(198,245,46,.45); }
.v2-brand-name { font-size: 17px; font-weight: 800; letter-spacing: -.01em; }
.v2-brand-sub { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: #8B94A7; margin-top: 1px; }
.v2-refresh { background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1); color: #C9D2E0;
  width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center; cursor: pointer; }
.v2-refresh:active { transform: scale(.94); }
.v2-spin { animation: v2spin 1s linear infinite; }
@keyframes v2spin { to { transform: rotate(360deg); } }

/* --- kartlar --- */
.v2-card { background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.09); border-radius: 20px;
  padding: 16px; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  box-shadow: 0 8px 30px rgba(0,0,0,.35); margin-bottom: 14px; }
.v2-main { animation: v2fade .28s ease; }
@keyframes v2fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.v2-sechead { display: flex; align-items: center; justify-content: space-between; font-size: 12px; font-weight: 700;
  letter-spacing: .08em; text-transform: uppercase; color: #8B94A7; margin-bottom: 12px; }
.v2-live { color: #C6F52E; font-size: 11.5px; font-weight: 700; text-transform: none; letter-spacing: 0;
  animation: v2pulse 2s ease-in-out infinite; }
@keyframes v2pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }

/* --- hero --- */
.v2-hero { position: relative; overflow: hidden; padding: 20px; }
.v2-hero::before { content: ''; position: absolute; inset: -40% -20% auto auto; width: 220px; height: 220px;
  background: radial-gradient(circle, rgba(198,245,46,.16), transparent 65%); pointer-events: none; }
.v2-hero-label { font-size: 11px; font-weight: 700; letter-spacing: .14em; color: #8B94A7; }
.v2-hero-num { font-size: 46px; font-weight: 850; letter-spacing: -.03em; line-height: 1.05; margin: 6px 0 14px;
  color: #fff; text-shadow: 0 0 30px rgba(198,245,46,.25); font-variant-numeric: tabular-nums; }
.v2-hero-foot { display: flex; gap: 18px; }
.v2-hero-stat { display: flex; flex-direction: column; gap: 2px; }
.v2-hero-stat b { font-size: 15px; font-weight: 800; color: #E8EDF5; }
.v2-hero-stat span { font-size: 11px; color: #8B94A7; }
.v2-hero-spark { display: flex; align-items: flex-end; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.v2-spark-note { font-size: 10px; color: #6B7385; text-align: right; line-height: 1.5; }
.v2-spark-empty { font-size: 11px; color: #6B7385; }

/* --- slotlar --- */
.v2-slots { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.v2-slot { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 16px;
  padding: 12px 8px; text-align: center; }
.v2-slot-active { background: rgba(198,245,46,.09); border-color: rgba(198,245,46,.5);
  box-shadow: 0 0 24px rgba(198,245,46,.22); animation: v2breathe 2.4s ease-in-out infinite; }
@keyframes v2breathe { 0%,100% { box-shadow: 0 0 16px rgba(198,245,46,.16); } 50% { box-shadow: 0 0 30px rgba(198,245,46,.34); } }
.v2-slot-time { font-size: 19px; font-weight: 850; font-variant-numeric: tabular-nums; }
.v2-slot-active .v2-slot-time { color: #C6F52E; }
.v2-slot-name { font-size: 11px; color: #8B94A7; margin-top: 3px; }
.v2-slot-note { font-size: 9.5px; color: #6B7385; margin-top: 2px; }
.v2-slot-active .v2-slot-note { color: #C6F52E; font-weight: 800; letter-spacing: .08em; }

/* --- sıradaki --- */
.v2-nextcard { border-color: rgba(198,245,46,.35); }
.v2-next-label { font-size: 10.5px; font-weight: 800; letter-spacing: .14em; color: #C6F52E; }
.v2-next-file { font-size: 24px; font-weight: 850; margin-top: 6px; letter-spacing: -.01em; }
.v2-next-sub { font-size: 12px; color: #8B94A7; margin-top: 5px; }

/* --- videolar --- */
.v2-search { width: 100%; box-sizing: border-box; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.12);
  border-radius: 14px; padding: 12px 14px; color: #F4F7FB; font-size: 14px; outline: none; }
.v2-search::placeholder { color: #6B7385; }
.v2-search:focus { border-color: rgba(198,245,46,.55); box-shadow: 0 0 0 3px rgba(198,245,46,.12); }
.v2-chips { display: flex; gap: 8px; margin-top: 10px; }
.v2-chip { background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1); color: #AAB3C4;
  font-size: 12px; font-weight: 600; padding: 7px 12px; border-radius: 999px; cursor: pointer; }
.v2-chip-on { background: rgba(198,245,46,.12); border-color: rgba(198,245,46,.55); color: #C6F52E;
  box-shadow: 0 0 14px rgba(198,245,46,.18); }
.v2-vlist { display: flex; flex-direction: column; gap: 10px; }
.v2-vrow { display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; }
.v2-vrow:active { transform: scale(.99); }
.v2-vrank { flex: 0 0 auto; width: 30px; height: 30px; border-radius: 10px; display: grid; place-items: center;
  font-size: 13px; font-weight: 800; color: #AAB3C4; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.09); }
.v2-vbody { min-width: 0; flex: 1; }
.v2-vtitle { font-size: 13.5px; font-weight: 700; line-height: 1.35; color: #E8EDF5;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.v2-vmeta { font-size: 11.5px; color: #8B94A7; margin-top: 4px; }
.v2-vbadge { display: inline-block; margin-left: 8px; padding: 2px 7px; border-radius: 7px; font-size: 9.5px;
  font-weight: 800; letter-spacing: .06em; background: #C6F52E; color: #0A0C10; vertical-align: middle;
  box-shadow: 0 0 12px rgba(198,245,46,.4); }
.v2-empty { text-align: center; color: #6B7385; font-size: 13px; padding: 22px 0; }

/* --- paylaşım --- */
.v2-rules { display: flex; flex-wrap: wrap; gap: 8px; }
.v2-rule { font-size: 11.5px; font-weight: 600; color: #C9D2E0; background: rgba(255,255,255,.05);
  border: 1px solid rgba(255,255,255,.1); padding: 7px 11px; border-radius: 999px; }
.v2-kit-sira { border-color: rgba(198,245,46,.4); box-shadow: 0 0 30px rgba(198,245,46,.1); }
.v2-kit-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.v2-kit-file { font-size: 15px; font-weight: 800; }
.v2-kit-sub { font-size: 11.5px; color: #8B94A7; margin-top: 3px; }
.v2-sira-badge { flex: 0 0 auto; font-size: 10.5px; font-weight: 850; letter-spacing: .08em; color: #0A0C10;
  background: #C6F52E; padding: 5px 9px; border-radius: 8px; box-shadow: 0 0 16px rgba(198,245,46,.5);
  animation: v2pulse 2s ease-in-out infinite; }
.v2-kit-title { font-size: 13px; font-weight: 700; color: #E8EDF5; margin-top: 10px; line-height: 1.4; }
.v2-kit-caption { font-size: 12px; color: #AAB3C4; line-height: 1.55; margin-top: 8px; white-space: pre-wrap;
  max-height: 120px; overflow: hidden; position: relative; }
.v2-copyrow { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px; }
.v2-btn { border: none; border-radius: 14px; padding: 13px 10px; font-size: 13px; font-weight: 800; cursor: pointer;
  transition: transform .08s ease; }
.v2-btn:active { transform: scale(.97); }
.v2-btn-primary { background: #C6F52E; color: #0A0C10; box-shadow: 0 0 22px rgba(198,245,46,.35); }
.v2-btn-ghost { background: rgba(255,255,255,.06); color: #E8EDF5; border: 1px solid rgba(255,255,255,.16); }
.v2-btn-copied { background: rgba(198,245,46,.15); color: #C6F52E; border: 1px solid rgba(198,245,46,.5); }
.v2-drivelink { display: inline-block; margin-top: 12px; font-size: 11.5px; color: #8B94A7; text-decoration: underline dotted; }
.v2-donehead { display: flex; justify-content: space-between; font-size: 12px; font-weight: 700;
  letter-spacing: .08em; text-transform: uppercase; color: #8B94A7; margin: 20px 2px 10px; }
.v2-kitsmall { display: flex; gap: 10px; align-items: center; padding: 12px 14px; margin-bottom: 8px; }
.v2-kit-ok { flex: 0 0 auto; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
  font-size: 13px; font-weight: 800; color: #C6F52E; background: rgba(198,245,46,.1); border: 1px solid rgba(198,245,46,.35); }

/* --- görsel stüdyosu --- */
.v2-imglabel { font-size: 12.5px; color: #8B94A7; margin-bottom: 10px; line-height: 1.45; }
.v2-imgprompt { width: 100%; box-sizing: border-box; background: rgba(0,0,0,.3); border: 1px solid rgba(255,255,255,.1);
  border-radius: 14px; color: #F4F7FB; font-size: 14px; padding: 10px 12px; resize: vertical; outline: none;
  font-family: inherit; }
.v2-imgprompt::placeholder { color: #6B7385; }
.v2-imgprompt:focus { border-color: rgba(198,245,46,.55); box-shadow: 0 0 0 3px rgba(198,245,46,.12); }
.v2-imgrow { display: flex; gap: 8px; margin-top: 10px; align-items: center; flex-wrap: wrap; }
.v2-imgfile { font-size: 12px; color: #C9D2E0; background: rgba(255,255,255,.05);
  border: 1px dashed rgba(255,255,255,.2); padding: 9px 12px; border-radius: 12px; cursor: pointer; }
.v2-imgfile:active { transform: scale(.98); }
.v2-imgfile input { display: none; }
.v2-imggen { margin-left: auto; border: none; font-size: 14px; font-weight: 800; color: #0A0C10;
  background: #C6F52E; padding: 10px 20px; border-radius: 14px; cursor: pointer;
  box-shadow: 0 0 22px rgba(198,245,46,.35); transition: transform .08s ease; }
.v2-imggen:active { transform: scale(.97); }
.v2-imggen:disabled { opacity: .45; cursor: default; box-shadow: none; }
.v2-imgprev { width: 100%; max-height: 220px; object-fit: contain; border-radius: 14px; margin-top: 10px;
  border: 1px solid rgba(255,255,255,.09); background: rgba(0,0,0,.25); }
.v2-imgout { width: 100%; border-radius: 14px; border: 1px solid rgba(255,255,255,.09); }
.v2-errline { color: #FF8A8A; font-size: 12.5px; margin-top: 10px; line-height: 1.5; }

/* --- sistem --- */
.v2-okline { font-size: 14px; font-weight: 700; color: #C6F52E; padding: 6px 0 12px; }
.v2-warnline { font-size: 14px; font-weight: 700; color: #FFC53D; padding: 6px 0 12px; }
.v2-sysmeta { display: flex; gap: 18px; border-top: 1px solid rgba(255,255,255,.08); padding-top: 12px; }
.v2-ring-wrap { display: flex; align-items: center; gap: 16px; }
.v2-ring-num { fill: #fff; font-size: 17px; font-weight: 800; }
.v2-ring-lbl { fill: #8B94A7; font-size: 8px; letter-spacing: .12em; text-transform: uppercase; }
.v2-ring-title { font-size: 15px; font-weight: 800; }
.v2-ring-sub { font-size: 11.5px; color: #8B94A7; margin-top: 3px; max-width: 170px; line-height: 1.45; }
.v2-wlist { display: flex; flex-direction: column; }
.v2-wrow { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; border-top: 1px solid rgba(255,255,255,.06); }
.v2-wrow:first-child { border-top: none; padding-top: 0; }
.v2-dot { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 50%; margin-top: 5px; }
.v2-dot-ok { background: #34D399; box-shadow: 0 0 8px rgba(52,211,153,.6); }
.v2-dot-warn { background: #FFC53D; box-shadow: 0 0 8px rgba(255,197,61,.6); }
.v2-dot-err { background: #F87171; box-shadow: 0 0 8px rgba(248,113,113,.6); }
.v2-foot { text-align: center; font-size: 11px; color: #6B7385; margin-top: 6px; line-height: 1.7; }
.v2-backlink { color: #8B94A7; text-decoration: underline dotted; }

/* --- hata / yükleme --- */
.v2-errcard { text-align: center; padding: 26px; }
.v2-errtitle { font-size: 15px; font-weight: 800; }
.v2-errsub { font-size: 12px; color: #8B94A7; margin: 6px 0 14px; }
.v2-skel { min-height: 90px; animation: v2skel 1.4s ease-in-out infinite; }
@keyframes v2skel { 0%,100% { opacity: .5; } 50% { opacity: .9; } }

/* --- kartal ajan --- */
.v2-agent-title { font-size: 22px; font-weight: 850; letter-spacing: -.02em; margin-top: 8px; color: #fff; }
.v2-agent-status { display: flex; align-items: center; gap: 9px; margin-top: 12px; font-size: 12.5px;
  line-height: 1.5; color: #AAB3C4; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.09);
  border-radius: 14px; padding: 11px 13px; }
.v2-agent-led { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%; }
.v2-agent-led.on { background: #34D399; box-shadow: 0 0 10px rgba(52,211,153,.8); animation: v2pulse 1.8s ease-in-out infinite; }
.v2-agent-led.off { background: #FFC53D; box-shadow: 0 0 8px rgba(255,197,61,.6); }
.v2-agent-on { border-color: rgba(52,211,153,.35); }
.v2-agent-err { font-size: 12px; font-weight: 600; color: #F87171; margin-top: 10px; }
.v2-agent-send { width: 100%; margin-top: 12px; }
.v2-agent-send:disabled { opacity: .5; }
.v2-agent-dot { flex: 0 0 auto; width: 27px; height: 27px; border-radius: 50%; display: grid; place-items: center;
  font-size: 13px; font-weight: 800; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.12); }
.v2-adot-ok { color: #34D399; border-color: rgba(52,211,153,.5); }
.v2-adot-err { color: #F87171; border-color: rgba(248,113,113,.5); }
.v2-adot-run { color: #C6F52E; border-color: rgba(198,245,46,.55); animation: v2pulse 1.6s ease-in-out infinite; }
.v2-adot-warn { color: #FFC53D; border-color: rgba(255,197,61,.45); }
.v2-agent-durum { font-weight: 800; }
.v2-agent-durum.v2-adot-ok { color: #34D399; }
.v2-agent-durum.v2-adot-err { color: #F87171; }
.v2-agent-durum.v2-adot-run { color: #C6F52E; }
.v2-agent-durum.v2-adot-warn { color: #FFC53D; }

/* --- alt nav --- */
.v2-nav { position: fixed; bottom: 0; left: 0; right: 0; z-index: 2; display: flex; justify-content: space-around;
  background: rgba(10,12,16,.82); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  border-top: 1px solid rgba(255,255,255,.08); padding: 8px 6px calc(8px + env(safe-area-inset-bottom));
  max-width: 100%; }
.v2-navitem { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; background: none; border: none;
  color: #6B7385; font-size: 10.5px; font-weight: 700; cursor: pointer; padding: 6px 2px; border-radius: 12px; }
.v2-navicon { font-size: 18px; filter: grayscale(1) opacity(.7); transition: filter .15s ease; }
.v2-navitem-on { color: #C6F52E; }
.v2-navitem-on .v2-navicon { filter: none; }
.v2-navitem-on { background: rgba(198,245,46,.08); }
`;
