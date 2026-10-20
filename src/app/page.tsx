'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSpeaker } from '@/components/useSpeaker';

type IntegrationStatus = { status: "online" | "offline" | "unknown"; detail: string };
interface IntegrationHealth { checkedAt: string; drive: IntegrationStatus; youtube: IntegrationStatus }
interface LatestPublicationData {
  ok: boolean;
  error?: string;
  checkedAt?: string;
  lastPublished: { title: string; publishedAt: string; url: string } | null;
  nextScheduled: { title: string; publishAt: string; url: string; fileName: string } | null;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  imageUrl?: string;
}

interface ContentDraft {
  id: number;
  title: string;
  platform: string;
  topic: string | null;
  status: string;
  generatedScript: string | null;
  generation: { provider?: string | null; model?: string | null } | null;
  previewPath?: string;
  hasVideo?: boolean;
}

interface QueueItem {
  id: number;
  title: string;
  topic: string | null;
  platform: string;
  status: string;
  createdAt: string;
}

interface ManagedContent extends ContentDraft {
  createdAt: string;
  updatedAt: string;
}

interface DraftAnalysis {
  report: string | null;
  createdAt: string | null;
  titles: Array<{ id: number; title: string }>;
  provider: string | null;
  model: string | null;
}

interface VideoProgressEvent {
  id: number;
  stage: string;
  status: string;
  percentage: number;
  detail?: string;
  nextAction?: string;
  createdAt: string;
}

const COMMANDS = [
  { command: '/yardım', description: 'Mira komutlarını gösterir' },
  { command: '/durum', description: 'Mira ve veritabanı durumunu kontrol eder' },
  { command: '/drive-katalog', description: 'Google Drive’daki gerçek başlık ve video dosyalarını okur' },
];

function renderPanelInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const tokenPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const key = `${keyPrefix}-${nodes.length}`;
    if (match[1] && match[2]) {
      nodes.push(<a key={key} href={match[2]} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline decoration-sky-300/50 underline-offset-2 break-all hover:text-sky-200">{match[1]}</a>);
    } else if (match[3]) {
      const rawUrl = match[3];
      const url = rawUrl.replace(/[.,!?;:]+$/, "");
      const trailing = rawUrl.slice(url.length);
      nodes.push(<a key={key} href={url} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline decoration-sky-300/50 underline-offset-2 break-all hover:text-sky-200">{url}</a>);
      if (trailing) nodes.push(trailing);
    } else if (match[4] || match[5]) {
      nodes.push(<strong key={key} className="font-bold text-white">{match[4] ?? match[5]}</strong>);
    } else if (match[6] || match[7]) {
      nodes.push(<em key={key} className="italic">{match[6] ?? match[7]}</em>);
    } else if (match[8]) {
      nodes.push(<code key={key} className="rounded bg-slate-950/80 px-1.5 py-0.5 text-amber-200 text-[0.95em]">{match[8]}</code>);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderPanelMarkdown(content: string): ReactNode {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const cls = level <= 2 ? "text-base font-bold text-white" : "text-sm font-bold text-white";
      blocks.push(<div key={`heading-${i}`} className={cls}>{renderPanelInlineMarkdown(heading[2], `heading-${i}`)}</div>);
      i += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*[-*+]\s+/, "");
        items.push(<li key={`li-${i}`}>{renderPanelInlineMarkdown(item, `li-${i}`)}</li>);
        i += 1;
      }
      blocks.push(<ul key={`ul-${i}`} className="list-disc space-y-1 pl-5">{items}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*\d+[.)]\s+/, "");
        items.push(<li key={`oli-${i}`}>{renderPanelInlineMarkdown(item, `oli-${i}`)}</li>);
        i += 1;
      }
      blocks.push(<ol key={`ol-${i}`} className="list-decimal space-y-1 pl-5">{items}</ol>);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s{0,3}#{1,6}\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push(<p key={`p-${i}`} className="whitespace-pre-wrap break-words">{renderPanelInlineMarkdown(paragraph.join("\n"), `p-${i}`)}</p>);
  }
  return <div className="space-y-2 text-slate-100">{blocks}</div>;
}

function renderAnalysisReport(report: string | null | undefined): ReactNode[] {
  if (!report) return [];
  const lines = report.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0;

  const isTableSeparator = (line: string) =>
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

  const parseCells = (line: string) =>
    line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) =>
      cell.trim().replace(/<br\s*\/?\s*>/gi, '\n')
    );

  while (i < lines.length) {
    if (lines[i].trim().startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = parseCells(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(parseCells(lines[i]));
        i += 1;
      }
      blocks.push(
        <div key={`table-${i}`} className="max-w-full overflow-x-auto rounded-lg border border-slate-700">
          <table className="w-full min-w-[900px] border-collapse text-left text-xs sm:text-sm">
            <thead className="bg-slate-800 text-slate-100">
              <tr>
                {headers.map((header, index) => (
                  <th key={index} className="border-b border-slate-600 px-3 py-3 font-semibold align-top">{header.replace(/\*\*/g, '')}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex} className={rowIndex % 2 === 0 ? 'bg-slate-900' : 'bg-slate-800/60'}>
                  {headers.map((_, cellIndex) => (
                    <td key={cellIndex} className="border-b border-slate-700 px-3 py-3 align-top whitespace-pre-wrap break-words text-slate-200">
                      {(row[cellIndex] ?? '').replace(/\*\*/g, '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && !(lines[i].trim().startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))) {
      paragraph.push(lines[i].replace(/<br\s*\/?\s*>/gi, '\n'));
      i += 1;
    }
    const text = paragraph.join('\n').trim();
    if (text) {
      blocks.push(<div key={`text-${i}`} className="whitespace-pre-wrap break-words text-slate-200">{text.replace(/\*\*/g, '')}</div>);
    }
  }

  return blocks;
}

export default function Home() {
  const [entered, setEntered] = useState(false);
  const [integrationHealth, setIntegrationHealth] = useState<IntegrationHealth | null>(null);
  const [integrationHealthError, setIntegrationHealthError] = useState(false);
  const [latestPublication, setLatestPublication] = useState<LatestPublicationData | null>(null);
  const [latestPublicationLoading, setLatestPublicationLoading] = useState(false);
  const [latestPublicationError, setLatestPublicationError] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [chatActivity, setChatActivity] = useState<Array<{ id: number; message: string; status: 'running' | 'success' | 'error'; createdAt: string }>>([]);
  const chatActivitySequence = useRef(0);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [drafts, setDrafts] = useState<ContentDraft[]>([]);
  const [draftPanelOpen, setDraftPanelOpen] = useState(true);
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const [showWorkspacePanels, setShowWorkspacePanels] = useState(false);
  const [managedDrafts, setManagedDrafts] = useState<ManagedContent[]>([]);
  const [managedLoading, setManagedLoading] = useState(false);
  const [managedError, setManagedError] = useState('');
  const [managedNotice, setManagedNotice] = useState('');
  const [taskCenterFilter, setTaskCenterFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [selectedManagedIds, setSelectedManagedIds] = useState<Set<number>>(new Set());
  const [editingManagedId, setEditingManagedId] = useState<number | null>(null);
  const [managedTitle, setManagedTitle] = useState('');
  const [managedTopic, setManagedTopic] = useState('');
  const [managedScript, setManagedScript] = useState('');
  const [managedBusyId, setManagedBusyId] = useState<number | null>(null);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [reviewBusyId, setReviewBusyId] = useState<number | null>(null);
  const [draftsError, setDraftsError] = useState('');
  const [reviewNotice, setReviewNotice] = useState('');
  const [videoProgress, setVideoProgress] = useState<{ contentId: number; title: string; percentage: number; stage: string; status: string } | null>(null);
  const [videoEvents, setVideoEvents] = useState<VideoProgressEvent[]>([]);
  const [readyVideos, setReadyVideos] = useState<ContentDraft[]>([]);
  const [readyPanelOpen, setReadyPanelOpen] = useState(true);
  const [readyLoading, setReadyLoading] = useState(false);
  const [readyError, setReadyError] = useState('');
  const [publishBusyId, setPublishBusyId] = useState<number | null>(null);
  const [publishResult, setPublishResult] = useState('');
  const [analysis, setAnalysis] = useState<DraftAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const [analysisRunLoading, setAnalysisRunLoading] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(true);
  const [manualTopic, setManualTopic] = useState('Konu 1 — TMSF v2: Banka batarsa mevduat güvencesi ve 2026 TMSF limiti. Önce resmi TMSF kaynağını doğrula; kaynak doğrulanmadan sayı/iddia kullanma. Referans: s11_tmsf.');
  const [manualTopicLoading, setManualTopicLoading] = useState(false);
  const [manualTopicResult, setManualTopicResult] = useState('');
  const [manualScriptProgress, setManualScriptProgress] = useState<{ contentId: number; title: string; events: VideoProgressEvent[]; status: string } | null>(null);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueBusyId, setQueueBusyId] = useState<number | null>(null);
  const [expandedQueueIds, setExpandedQueueIds] = useState<Set<number>>(new Set());
  const [queueEventDetails, setQueueEventDetails] = useState<Record<number, VideoProgressEvent[]>>({});
  const [queueDetailsLoading, setQueueDetailsLoading] = useState<Set<number>>(new Set());
  const { speak, voiceError } = useSpeaker();

  async function loadAnalysis() {
    setAnalysisLoading(true);
    setAnalysisError('');
    try {
      const res = await fetch('/api/content/analysis', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Analiz raporu alınamadı (HTTP ${res.status}).`);
      setAnalysis(data && typeof data === 'object' ? data as DraftAnalysis : null);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : 'Analiz raporu alınamadı.');
    } finally {
      setAnalysisLoading(false);
    }
  }

  async function loadLatestPublication() {
    setLatestPublicationLoading(true);
    setLatestPublicationError('');
    try {
      const res = await fetch('/api/youtube/last-publication', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.ok !== true) throw new Error(data?.error || `YouTube yayın bilgisi alınamadı (HTTP ${res.status}).`);
      setLatestPublication(data as LatestPublicationData);
    } catch (error) {
      setLatestPublicationError(error instanceof Error ? error.message : 'YouTube yayın bilgisi alınamadı.');
    } finally {
      setLatestPublicationLoading(false);
    }
  }

  async function runDraftAnalysis() {
    if (analysisRunLoading) return;
    setAnalysisRunLoading(true);
    setAnalysisError('');
    try {
      const res = await fetch('/api/automation/analyze-drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'review-panel' }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Analiz başlatılamadı (HTTP ${res.status}).`);
      if (data?.analyzed !== true || typeof data?.report !== 'string') {
        throw new Error(typeof data?.message === 'string' ? data.message : 'Analiz edilecek yeni taslak bulunamadı.');
      }
      await loadAnalysis();
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : 'Taslak analizi tamamlanamadı.');
    } finally {
      setAnalysisRunLoading(false);
    }
  }

  const progressPollingIds = useRef<Set<number>>(new Set());

  async function loadManualQueue() {
    setQueueLoading(true);
    try {
      const res = await fetch('/api/automation/queue', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (res.ok && Array.isArray(data)) {
        const items = data as QueueItem[];
        setQueueItems(items);
        // Panel yeniden açıldığında da "processing" görevlerinin canlı akışına otomatik bağlan.
        for (const item of items) {
          if (item.status === 'processing' && !progressPollingIds.current.has(item.id)) {
            progressPollingIds.current.add(item.id);
            void pollManualScriptProgress(item.id, item.title)
              .finally(() => progressPollingIds.current.delete(item.id));
          }
        }
      }
    } finally {
      setQueueLoading(false);
    }
  }

  async function toggleQueueDetails(item: QueueItem) {
    const isOpen = expandedQueueIds.has(item.id);
    if (isOpen) {
      setExpandedQueueIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      return;
    }

    setExpandedQueueIds((current) => new Set(current).add(item.id));
    setQueueDetailsLoading((current) => new Set(current).add(item.id));
    try {
      const res = await fetch('/api/automation/produce-events?contentId=' + item.id, { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || ('Hata ayrıntıları alınamadı (HTTP ' + res.status + ').'));
      const events = Array.isArray(data?.events) ? data.events as VideoProgressEvent[] : [];
      setQueueEventDetails((current) => ({ ...current, [item.id]: events }));
    } catch (error) {
      setQueueEventDetails((current) => ({
        ...current,
        [item.id]: [{
          id: -item.id,
          stage: 'Hata ayrıntıları alınamadı',
          status: 'failed',
          percentage: 0,
          detail: error instanceof Error ? error.message : 'Ayrıntılar alınamadı.',
          nextAction: 'Bağlantıyı kontrol edip konu ayrıntılarını yeniden aç.',
          createdAt: new Date().toISOString(),
        }],
      }));
    } finally {
      setQueueDetailsLoading((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  }

  async function startManualVideo(item: QueueItem) {
    if (queueBusyId !== null) return;
    if (!window.confirm(`“${item.title}” konusu için Mira şimdi yalnızca araştırma ve senaryo taslağı hazırlasın mı? Video üretimi, senaryoyu kontrol edip ayrıca onayladıktan sonra başlar.`)) return;
    setQueueBusyId(item.id);
    setManualTopicResult(`#${item.id} için araştırma ve senaryo hazırlığı başlatıldı. Video üretimi ve YouTube yüklemesi bu adımda yapılmayacak.`);
    try {
      const res = await fetch(`/api/automation/worker?contentId=${item.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manualProduce: false }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Üretim başlatılamadı (HTTP ${res.status}).`);
      setQueueItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: 'processing' } : entry));
      setManualTopicResult(`#${item.id} senaryo hazırlığına alındı. Taslağı kontrol edip ayrıca “Onayla ve video üret” demeden video üretimi başlamaz.`);
    } catch (error) {
      setManualTopicResult(error instanceof Error ? error.message : 'Üretim başlatılamadı.');
    } finally {
      setQueueBusyId(null);
      void loadManualQueue();
    }
  }

  async function startManualProduction(item: QueueItem) {
    if (queueBusyId !== null) return;
    if (!window.confirm(`“${item.title}” konusu için Mira şimdi senaryo ve video üretimini başlatsın mı? Bu işlem planlı saat ayarlarını değiştirmez ve YouTube'a otomatik yükleme yapmaz.`)) return;
    setQueueBusyId(item.id);
    setManualTopicResult(`#${item.id} için manuel video üretimi başlatılıyor. Planlı saat ayarları değiştirilmiyor; YouTube'a otomatik yükleme yapılmayacak.`);
    try {
      const res = await fetch(`/api/automation/worker?contentId=${item.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manualProduce: true }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Video üretimi başlatılamadı (HTTP ${res.status}).`);
      setQueueItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: 'processing' } : entry));
      setManualTopicResult(`#${item.id} için manuel üretim başlatıldı. Bu tıklama planlı saatleri değiştirmez. Üretimin tamamlandığı ve private YouTube yüklemesi ayrıca doğrulanmalı.`);
    } catch (error) {
      setManualTopicResult(error instanceof Error ? error.message : 'Video üretimi başlatılamadı.');
    } finally {
      setQueueBusyId(null);
      void loadManualQueue();
    }
  }

  async function retryManualItem(item: QueueItem) {
    if (queueBusyId !== null) return;
    if (!window.confirm(`“${item.title}” (#${item.id}) aynı kayıt üzerinden yeniden denensin mi? Yeni konu oluşturulmayacak; YouTube'a yükleme yapılmayacak.`)) return;
    setQueueBusyId(item.id);
    setManualTopicResult(`#${item.id} mevcut görevi yeniden kuyruğa alıyor…`);
    try {
      const retryRes = await fetch('/api/automation/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retryContentId: item.id }),
      });
      const retryData = await retryRes.json().catch(() => null);
      if (!retryRes.ok || retryData?.ok !== true) throw new Error(retryData?.error || `Yeniden kuyruğa alınamadı (HTTP ${retryRes.status}).`);

      const workerRes = await fetch(`/api/automation/worker?contentId=${item.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manualProduce: false, manualTopic: true }),
      });
      const workerData = await workerRes.json().catch(() => null);
      if (!workerRes.ok || workerData?.started !== true) throw new Error(workerData?.error || 'Mira yeniden denemeyi başlatamadı.');
      setQueueItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: 'processing' } : entry));
      setManualTopicResult(`#${item.id} aynı kayıt üzerinden yeniden denendi. Mira güncel kaynak aramasını çalıştırıyor; yeni bir içerik oluşturulmadı ve YouTube yüklemesi başlatılmadı.`);
      void pollManualScriptProgress(item.id, item.title);
    } catch (error) {
      setManualTopicResult(error instanceof Error ? error.message : 'Yeniden deneme başlatılamadı.');
    } finally {
      setQueueBusyId(null);
      void loadManualQueue();
    }
  }

  async function pollManualScriptProgress(contentId: number, title: string) {
    // Süre sınırı yok: uzun kaynak kontrolü/LLM/render adımları sürerken canlı akış kapanmasın.
    // Başarı durumu 5 saniye değişmeden kalırsa terminal kabul edilir; arada yeni aşama gelirse izlemeye devam edilir.
    let lastSignature = '';
    let terminalSince: number | null = null;
    while (true) {
      try {
        const res = await fetch('/api/automation/produce-events?contentId=' + contentId, { cache: 'no-store' });
        if (!res.ok) throw new Error('İlerleme API HTTP ' + res.status);
        const data = await res.json().catch(() => null);
        const events = Array.isArray(data?.events) ? data.events as VideoProgressEvent[] : [];
        const latest = events[events.length - 1];
        setManualScriptProgress({ contentId, title, events, status: latest?.status || 'running' });
        const terminal = Boolean(latest && (
          latest.status === 'failed' ||
          (latest.status === 'success' && /senaryo hazır|video hazır|üretim tamamlandı/i.test(latest.stage))
        ));
        const signature = latest ? String(latest.id) + ':' + latest.status + ':' + latest.stage : '';
        if (terminal) {
          if (signature !== lastSignature) {
            lastSignature = signature;
            terminalSince = Date.now();
          } else if (terminalSince !== null && Date.now() - terminalSince >= 5000) {
            return;
          }
        } else {
          lastSignature = signature;
          terminalSince = null;
        }
      } catch {
        // Geçici ağ/API hatasında akış kapanmaz; sonraki turda yeniden denenir.
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }

  async function addManualTopic() {
    const topic = manualTopic.trim();
    if (!topic || manualTopicLoading) return;
    const topicTitleLine = topic.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || topic;
    const topicTitle = topicTitleLine.replace(/^konu\s*:\s*/i, '').slice(0, 80) || 'Yeni senaryo';
    setManualTopicLoading(true);
    setManualTopicResult('Konu kuyruğa alınıyor…');
    setManualScriptProgress(null);
    try {
      const res = await fetch('/api/automation/queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: topicTitle, topic, platform: 'youtube' }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Konu eklenemedi (HTTP ' + res.status + ').');
      const contentId = Number(data?.content?.id);
      if (!Number.isInteger(contentId) || contentId <= 0) throw new Error('Konu kaydedildi ancak içerik kimliği alınamadı.');
      setManualTopic('');
      setManualTopicResult('Konu #' + contentId + ' alındı. Mira senaryo, kaynak ve doğruluk kontrolüne başladı.');
      setManualScriptProgress({ contentId, title: topicTitle, events: [], status: 'running' });
      void loadManualQueue();
      const workerRes = await fetch('/api/automation/worker?contentId=' + contentId, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manualProduce: false, manualTopic: true }),
      });
      const workerData = await workerRes.json().catch(() => null);
      if (!workerRes.ok || workerData?.started !== true) throw new Error(workerData?.error || 'Mira görevi başlatılamadı.');
      setManualTopicResult('Konu #' + contentId + ': Mira görevi devraldı. Canlı adımları aşağıda görebilirsin.');
      void pollManualScriptProgress(contentId, topicTitle);
      setTimeout(() => { void loadManualQueue(); }, 3000);
    } catch (error) {
      setManualTopicResult(error instanceof Error ? error.message.slice(0, 180) : 'Senaryo üretimi başlatılamadı.');
    } finally {
      setManualTopicLoading(false);
    }
  }

  async function loadManagedDrafts() {
    setManagedLoading(true);
    setManagedError('');
    try {
      const res = await fetch('/api/content/manage', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Görev Merkezi kayıtları alınamadı (HTTP ${res.status}).`);
      setManagedDrafts(Array.isArray(data) ? data as ManagedContent[] : []);
    } catch (error) {
      setManagedError(error instanceof Error ? error.message : 'Görev Merkezi kayıtları alınamadı.');
    } finally {
      setManagedLoading(false);
    }
  }

  function beginManagedEdit(item: ManagedContent) {
    setEditingManagedId(item.id);
    setManagedTitle(item.title || '');
    setManagedTopic(item.topic || '');
    setManagedScript(item.generatedScript || '');
    setManagedError('');
    setManagedNotice('');
  }

  async function saveManagedDraft(id: number) {
    if (managedBusyId !== null) return;
    setManagedBusyId(id);
    setManagedError('');
    setManagedNotice('');
    try {
      const res = await fetch('/api/content/manage', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, title: managedTitle, topic: managedTopic, generatedScript: managedScript }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Taslak kaydedilemedi (HTTP ${res.status}).`);
      setManagedNotice(data?.message || 'Taslak kaydedildi.');
      setEditingManagedId(null);
      await loadManagedDrafts();
    } catch (error) {
      setManagedError(error instanceof Error ? error.message : 'Taslak kaydedilemedi.');
    } finally {
      setManagedBusyId(null);
    }
  }

  async function manageContentAction(id: number, action: 'archive' | 'restore' | 'permanent_delete') {
    const prompts = {
      archive: 'Bu taslağı arşive taşımak istiyor musun?',
      restore: 'Bu kaydı taslaklara geri yüklemek istiyor musun?',
      permanent_delete: 'Bu taslağı, senaryoyu, ilişkili medyayı ve kayıt izlerini kalıcı olarak yok etmek istiyor musun? Bu işlem geri alınamaz.',
    };
    if (!window.confirm(prompts[action]) || managedBusyId !== null) return;
    setManagedBusyId(id);
    setManagedError('');
    setManagedNotice('');
    try {
      const res = await fetch('/api/content/manage', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `İşlem başarısız (HTTP ${res.status}).`);
      setManagedNotice(data?.message || 'İşlem tamamlandı.');
      if (editingManagedId === id) setEditingManagedId(null);
      await loadManagedDrafts();
    } catch (error) {
      setManagedError(error instanceof Error ? error.message : 'İşlem tamamlanamadı.');
    } finally {
      setManagedBusyId(null);
    }
  }

  async function deleteSelectedManagedDrafts() {
    const visibleItems = managedDrafts.filter((item) =>
      taskCenterFilter === 'all' ||
      (taskCenterFilter === 'active' ? !['archived', 'deleted'].includes(item.status) : item.status === taskCenterFilter)
    );
    const selectedIds = visibleItems.filter((item) => selectedManagedIds.has(item.id)).map((item) => item.id);
    if (selectedIds.length === 0 || managedBusyId !== null) return;
    if (!window.confirm(`Seçili ${selectedIds.length} kaydı, senaryolarını ve ilişkili medyalarını kalıcı olarak silmek istiyor musun? Bu işlem geri alınamaz.`)) return;

    setManagedBusyId(-1);
    setManagedError('');
    setManagedNotice('');
    const failures: number[] = [];
    try {
      for (const id of selectedIds) {
        try {
          const res = await fetch('/api/content/manage', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, action: 'permanent_delete' }),
          });
          if (!res.ok) failures.push(id);
        } catch {
          failures.push(id);
        }
      }
      setSelectedManagedIds((previous) => {
        const next = new Set(previous);
        selectedIds.filter((id) => !failures.includes(id)).forEach((id) => next.delete(id));
        return next;
      });
      if (failures.length > 0) {
        setManagedError(`${selectedIds.length - failures.length} kayıt silindi; şu kayıtlar silinemedi: ${failures.map((id) => '#' + id).join(', ')}. Yenile ve tekrar kontrol et.`);
      } else {
        setManagedNotice(`${selectedIds.length} kayıt kalıcı olarak silindi.`);
      }
      await loadManagedDrafts();
    } finally {
      setManagedBusyId(null);
    }
  }

  async function loadDrafts() {
    setDraftsLoading(true);
    setDraftsError('');
    try {
      const res = await fetch('/api/content/review', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Taslaklar alınamadı (HTTP ${res.status}).`);
      setDrafts(Array.isArray(data) ? data : []);
    } catch (error) {
      setDraftsError(error instanceof Error ? error.message : 'Taslaklar alınamadı.');
    } finally {
      setDraftsLoading(false);
    }
  }

  async function loadReadyVideos() {
    setReadyLoading(true);
    setReadyError('');
    try {
      const res = await fetch('/api/content/review?status=ready', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Videolar alınamadı (HTTP ${res.status}).`);
      setReadyVideos(Array.isArray(data) ? data : []);
    } catch (error) {
      setReadyError(error instanceof Error ? error.message : 'Videolar alınamadı.');
    } finally {
      setReadyLoading(false);
    }
  }

  async function publishVideo(id: number) {
    if (publishBusyId !== null) return;
    if (!window.confirm('Bu video YouTube\'a yüklensin mi? Varsayılan gizlilik: private (sonradan public yapabilirsin).')) return;
    setPublishBusyId(id);
    setPublishResult('');
    try {
      const res = await fetch('/api/youtube/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentId: id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Yükleme başarısız (HTTP ${res.status}).`);
      setReadyVideos((current) => current.filter((item) => item.id !== id));
      setPublishResult(`Yüklendi: ${data.url || 'link alınamadı'} (${data.privacyStatus || 'private'})`);
    } catch (error) {
      setReadyError(error instanceof Error ? error.message : 'Yükleme tamamlanamadı.');
    } finally {
      setPublishBusyId(null);
    }
  }

  async function reviewDraft(id: number, action: 'approve_video' | 'approve_text' | 'reject' | 'generate_script') {
    if (reviewBusyId !== null) return;
    const prompt = action === 'approve_video'
      ? 'Bu içeriği onaylayıp video üretimini başlatmak istiyor musun? Bu testte YouTube yüklemesi otomatik yapılmayacak.'
      : action === 'approve_text'
        ? 'Bu içeriği onaylayıp video üretmeden saklamak istiyor musun?'
        : action === 'generate_script'
          ? 'Bu taslak için senaryoyu şimdi üretmek istiyor musun? 1-2 dakika sürebilir.'
          : 'Bu taslağı reddetmek istiyor musun?';
    if (!window.confirm(prompt)) return;
    setReviewBusyId(id);
    setDraftsError('');
    setReviewNotice('');
    if (action === 'approve_video') {
      setVideoProgress({ contentId: id, title: drafts.find((draft) => draft.id === id)?.title || `İçerik #${id}`, percentage: 2, stage: 'Video üretimi başlatılıyor', status: 'running' });
      setVideoEvents([{ id: Date.now(), stage: 'Video üretimi başlatılıyor', status: 'running', percentage: 2, createdAt: new Date().toISOString() }]);
    }
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const res = await fetch('/api/content/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `İşlem başarısız (HTTP ${res.status}).`);
      if (action === 'generate_script') {
        setReviewNotice(data?.message || 'Senaryo oluşturuldu; taslak kartı güncelleniyor.');
        void loadDrafts();
        void loadManagedDrafts();
        return;
      }
      setDrafts((current) => current.filter((draft) => draft.id !== id));
      void loadManagedDrafts();
      if (action === 'reject' || action === 'approve_text' || action === 'approve_video') {
        setAnalysis((current) => current ? {
          ...current,
          titles: current.titles.filter((item) => item.id !== id),
        } : current);
      }

      if (action !== 'approve_video') {
        setReviewNotice(action === 'approve_text' ? 'Taslak onaylandı; video üretilmedi.' : 'Taslak reddedildi.');
        return;
      }

      setReviewNotice('Onay kaydedildi. Video üretimi başladı.');
      const refreshProgress = async () => {
        try {
          const progressRes = await fetch(`/api/automation/produce-status?contentId=${id}`, { cache: 'no-store' });
          const progress = await progressRes.json().catch(() => null);
          if (progressRes.ok && progress && typeof progress.percentage === 'number') {
            setVideoProgress({ contentId: id, title: drafts.find((draft) => draft.id === id)?.title || `İçerik #${id}`, percentage: progress.percentage, stage: String(progress.stage || 'Video hazırlanıyor'), status: String(progress.status || 'running') });
          }
          const eventsRes = await fetch(`/api/automation/produce-events?contentId=${id}`, { cache: 'no-store' });
          const eventData = await eventsRes.json().catch(() => null);
          if (eventsRes.ok && Array.isArray(eventData?.events)) {
            setVideoEvents(eventData.events as VideoProgressEvent[]);
          }
        } catch {
          // Progress polling errors must not interrupt video production.
        }
      };
      void refreshProgress();
      progressTimer = setInterval(() => { void refreshProgress(); }, 1200);
      try {
        const produceRes = await fetch('/api/automation/produce', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentId: id }),
        });
        const produced = await produceRes.json().catch(() => null);
        if (!produceRes.ok || produced?.ok !== true || produced?.produced !== true) {
          throw new Error(produced?.error || produced?.message || `Video üretimi başarısız (HTTP ${produceRes.status}).`);
        }

        if (progressTimer) { clearInterval(progressTimer); progressTimer = undefined; }
        setVideoProgress({ contentId: id, title: drafts.find((draft) => draft.id === id)?.title || `İçerik #${id}`, percentage: 100, stage: 'Video üretimi tamamlandı; YouTube yüklemesi yapılmadı', status: 'success' });
        setReviewNotice('Video üretimi tamamlandı. Bu testte YouTube’a yükleme yapılmadı; Telegram video/onay akışı ayrıca doğrulanacak.');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Video üretim/yükleme işlemi tamamlanamadı.';
        setVideoProgress((current) => current?.contentId === id ? { ...current, status: 'failed', stage: `İşlem durdu: ${message}` } : current);
        setVideoEvents((current) => [...current, { id: Date.now(), stage: `HATA: ${message}`, status: 'failed', percentage: 0, createdAt: new Date().toISOString() }]);
        setReviewNotice(`Onay kaydedildi, ancak video hattı tamamlanmadı: ${message}`);
      } finally {
        if (progressTimer) { clearInterval(progressTimer); progressTimer = undefined; }
      }
    } catch (error) {
      if (action === 'approve_video') {
        const message = error instanceof Error ? error.message : 'İşlem tamamlanamadı.';
        setVideoProgress((current) => current?.contentId === id ? { ...current, status: 'failed', stage: `İşlem durdu: ${message}` } : current);
      }
      setDraftsError(error instanceof Error ? error.message : 'İşlem tamamlanamadı.');
    } finally {
      setReviewBusyId(null);
    }
  }
  async function resumeVideoProduction(contentId: number, title: string) {
    if (reviewBusyId !== null) return;
    setReviewBusyId(contentId);
    setVideoProgress({ contentId, title, percentage: 2, stage: 'Kaydedilmiş aşamalar kontrol ediliyor; üretime devam ediliyor', status: 'running' });
    setVideoEvents((current) => [...current, { id: Date.now(), stage: 'Kaldığı yerden devam etme isteği gönderildi', status: 'running', percentage: 2, createdAt: new Date().toISOString() }]);
    setReviewNotice('');
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const refresh = async () => {
        try {
          const progressRes = await fetch(`/api/automation/produce-status?contentId=${contentId}`, { cache: 'no-store' });
          const progress = await progressRes.json().catch(() => null);
          if (progressRes.ok && progress && typeof progress.percentage === 'number') {
            setVideoProgress({ contentId, title, percentage: progress.percentage, stage: String(progress.stage || 'Video hazırlanıyor'), status: String(progress.status || 'running') });
          }
          const eventsRes = await fetch(`/api/automation/produce-events?contentId=${contentId}`, { cache: 'no-store' });
          const data = await eventsRes.json().catch(() => null);
          if (eventsRes.ok && Array.isArray(data?.events)) setVideoEvents(data.events as VideoProgressEvent[]);
        } catch {
          // Görüntüleme hatası üretim isteğini kesmez.
        }
      };
      void refresh();
      timer = setInterval(() => { void refresh(); }, 1200);
      const res = await fetch('/api/automation/produce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.ok !== true || data?.produced !== true) {
        throw new Error(data?.error || data?.message || `Üretim yeniden başlatılamadı (HTTP ${res.status}).`);
      }
      setVideoProgress({ contentId, title, percentage: 100, stage: 'Video üretimi tamamlandı; YouTube yüklemesi yapılmadı', status: 'success' });
      setReviewNotice('Video üretimi tamamlandı. YouTube’a yükleme yapılmadı; Telegram video/onay akışı ayrıca doğrulanacak.');
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Üretim yeniden başlatılamadı.';
      setVideoProgress({ contentId, title, percentage: 0, stage: `Beklemede; sorun çözüldüğünde tekrar devam edilebilir: ${message}`, status: 'waiting' });
      setVideoEvents((current) => [...current, { id: Date.now(), stage: `Yeniden deneme sonucu: ${message}`, status: 'waiting', percentage: 0, createdAt: new Date().toISOString() }]);
      setReviewNotice(`Görev korunuyor. Yeniden deneme sonucu: ${message}`);
    } finally {
      if (timer) clearInterval(timer);
      setReviewBusyId(null);
    }
  }

  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!entered) return;
    let active = true;
    const check = async () => {
      try {
        const response = await fetch("/api/integrations/status", { cache: "no-store" });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.ok) throw new Error("Durum alınamadı");
        if (active) {
          setIntegrationHealth(data as IntegrationHealth);
          setIntegrationHealthError(false);
        }
      } catch {
        if (active) setIntegrationHealthError(true);
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [entered]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  useEffect(() => {
    fetch('/api/auth/login', { method: 'GET' })
      .then((res) => {
        if (res.ok) setEntered(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!entered) return;
    let active = true;
    setHistoryLoaded(false);
    void fetch('/api/chat/history', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Sohbet geçmişi alınamadı (HTTP ${res.status}).`);
        const data = await res.json();
        if (active && Array.isArray(data?.messages)) {
          const isMessage = (item: unknown): item is Message => {
            if (!item || typeof item !== 'object') return false;
            const candidate = item as Partial<Message>;
            return (candidate.role === 'user' || candidate.role === 'assistant') && typeof candidate.content === 'string';
          };
          let cached: Message[] = [];
          try {
            const stored = localStorage.getItem('mira_chat_history_v1');
            const parsed: unknown = stored ? JSON.parse(stored) : [];
            if (Array.isArray(parsed)) cached = parsed.filter(isMessage);
          } catch {
            // A broken local cache should not prevent restoring database history.
          }
          const restored = cached.length > 0 ? cached : data.messages.filter(isMessage);
          setMessages(restored);
        }
      })
      .catch((error) => console.error('Sohbet geçmişi yüklenemedi:', error))
      .finally(() => { if (active) setHistoryLoaded(true); });
    void loadDrafts();
    void loadAnalysis();
    void loadReadyVideos();
    void loadManualQueue();
    void loadLatestPublication();
    return () => { active = false; };
  }, [entered]);

  useEffect(() => {
    if (!historyLoaded) return;
    try {
      localStorage.setItem('mira_chat_history_v1', JSON.stringify(messages.slice(-200)));
    } catch (error) {
      console.error('Sohbet geçmişi bu cihazda saklanamadı:', error);
    }
  }, [messages, historyLoaded]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || authLoading) return;
    setAuthLoading(true);
    setAuthError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAuthError(typeof data.error === 'string' ? data.error : 'Şifre yanlış.');
        setPassword('');
        return;
      }
      setPassword('');
      setEntered(true);
    } catch {
      setAuthError('Giriş doğrulaması yapılamadı. Tekrar dene.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInput(value);
    if (value.startsWith('/')) {
      setShowSuggestions(true);
    } else {
      setShowSuggestions(false);
    }
  };

  const selectCommand = (cmd: string) => {
    setInput(cmd);
    setShowSuggestions(false);
    if (inputRef.current) {
      inputRef.current.focus();
    }
  };

  const appendChatActivity = (message: string, status: 'running' | 'success' | 'error') => {
    setChatActivity((current) => [...current, { id: ++chatActivitySequence.current, message, status, createdAt: new Date().toISOString() }]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading || !historyLoaded) return;

    const userMessage = input.trim();
    setInput('');
    setShowSuggestions(false);
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setChatActivity([]);
    setLoading(true);

    try {
      const wantsOnlinePhoto = /(?:mira.*(?:fotoğrafını at|fotoğraf at|fotoğraf bul|internetten fotoğraf)|(?:internetten|online|webden).*fotoğraf|fotoğrafını at)/i.test(userMessage);
      const wantsSelfie = !wantsOnlinePhoto && /(?:selfie|selfini|selfie çek|fotoğrafını çek|kendi fotoğrafını|resmini çek)/i.test(userMessage);
      const endpoint = wantsOnlinePhoto ? '/api/image/search' : wantsSelfie ? '/api/image/selfie' : '/api/chat';
      appendChatActivity(`İstek gönderildi: ${endpoint}. Sunucudan gerçek yanıt bekleniyor.`, 'running');
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wantsOnlinePhoto ? { query: 'body selfie sensual girl' } : wantsSelfie ? {} : { message: userMessage }),
      });

      // Do not blindly call res.json(): deployment/proxy errors can return
      // plain text or HTML and cause "Unexpected token ... is not valid JSON".
      appendChatActivity(`Sunucu yanıt verdi: HTTP ${res.status}.`, res.ok ? 'running' : 'error');
      const raw = await res.text();
      let data: unknown = null;

      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        const preview = raw.replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 500);
        throw new Error(
          preview
            ? `Sunucu JSON yerine metin döndürdü (HTTP ${res.status}): ${preview}`
            : `Sunucu geçerli JSON döndürmedi (HTTP ${res.status}).`,
        );
      }

      if (!res.ok) {
        const error =
          data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : `HTTP ${res.status}`;
        throw new Error(error);
      }

      const reply =
        data && typeof data === 'object' && 'reply' in data && typeof data.reply === 'string'
          ? data.reply
          : data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : 'Yanıt alınamadı.';

      const imageUrl = data && typeof data === 'object' && 'imageUrl' in data && typeof data.imageUrl === 'string'
        ? data.imageUrl
        : undefined;
      setMessages((prev) => [...prev, { role: 'assistant', content: reply, ...(imageUrl ? { imageUrl } : {}) }]);
      appendChatActivity('Mira yanıtı alındı; istek tamamlandı.', 'success');
      speak(reply);
    } catch (err: any) {
      appendChatActivity(`İşlem durdu: ${err?.message || 'Bağlantı hatası'}`, 'error');
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Hata oluştu: ${err.message || 'Bağlantı hatası'}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string, index: number) => {
    const cleanText = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
    navigator.clipboard.writeText(cleanText);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const renderMessageContent = (msg: Message, index: number) => {
    const isCodeBlock = msg.content.startsWith('```');

    if (isCodeBlock) {
      const cleanCode = msg.content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');

      return (
        <div className="relative my-2 rounded-lg bg-slate-950 border border-slate-700 overflow-hidden text-left font-mono text-sm">
          <div className="flex justify-between items-center px-4 py-1.5 bg-slate-800 text-slate-400 text-xs border-b border-slate-700">
            <span>Kod Çıktısı</span>
            <button
              onClick={() => copyToClipboard(msg.content, index)}
              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-xs font-sans transition-colors"
            >
              {copiedIndex === index ? '✓ Kopyalandı' : '📋 Kopyala'}
            </button>
          </div>
          <pre className="p-4 overflow-x-auto text-slate-100 font-mono text-xs leading-relaxed">
            <code>{cleanCode}</code>
          </pre>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {renderPanelMarkdown(msg.content)}
        {msg.imageUrl && (
          <img
            src={msg.imageUrl}
            alt="Mira'nın oluşturduğu selfie"
            className="mt-3 w-full max-w-md rounded-xl border border-slate-700"
          />
        )}
        {msg.role === 'assistant' && (
          <div className="flex justify-end pt-1">
            <button
              onClick={() => copyToClipboard(msg.content, index)}
              className="px-2 py-1 bg-slate-700/50 hover:bg-slate-700 text-slate-300 rounded text-xs transition-colors flex items-center gap-1"
            >
              {copiedIndex === index ? '✓ Kopyalandı' : '📋 Metni Kopyala'}
            </button>
          </div>
        )}
      </div>
    );
  };

  if (!entered) {
    return (
      <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center overflow-hidden">
        <section className="relative w-full min-h-screen flex flex-col items-center justify-center px-6">
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500/10 blur-3xl animate-pulse" />
            <div className="absolute left-1/2 top-1/2 h-44 w-44 -translate-x-1/2 -translate-y-1/2 rounded-full border border-blue-400/20 animate-ping" />
          </div>
          <div className="relative z-10 flex flex-col items-center text-center">
            <div className="mb-7 flex h-28 w-28 items-center justify-center rounded-full border border-blue-400/30 bg-slate-900/80 shadow-2xl shadow-blue-950/40">
              <div className="h-16 w-16 rounded-full bg-blue-500/20 border border-blue-300/30 animate-pulse" />
            </div>
            <p className="mb-2 text-xs uppercase tracking-[0.45em] text-blue-300/70">MIRA</p>
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Hazırım.</h1>
            <p className="mt-4 max-w-md text-sm leading-6 text-slate-400">
              Görevlerine ve otomasyonlarına odaklanan tek çalışma alanı.
            </p>
            <form onSubmit={handleLogin} className="mt-9 w-full max-w-sm">
              <label htmlFor="mira-entry-password" className="sr-only">Mira giriş şifresi</label>
              <input
                id="mira-entry-password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setAuthError('');
                }}
                placeholder="Giriş şifresi"
                autoComplete="current-password"
                className="w-full rounded-full border border-slate-700 bg-slate-900/90 px-5 py-3 text-center text-white placeholder:text-slate-500 outline-none focus:border-blue-500"
              />
              {authError && <p className="mt-2 text-sm text-red-400" role="alert">{authError}</p>}
              <button
                type="submit"
                disabled={authLoading || !password}
                className="mt-3 w-full rounded-full border border-blue-400/30 bg-blue-500/10 px-8 py-3 text-sm font-medium text-blue-100 transition-all duration-300 hover:scale-105 hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {authLoading ? 'Kontrol ediliyor...' : "Mira'ya gir"}
              </button>
            </form>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="flex flex-col h-[100dvh] max-w-4xl mx-auto p-3 sm:p-4 bg-slate-900 text-white relative overflow-hidden">
      <header className="shrink-0 py-3 sm:py-4 border-b border-slate-700 flex justify-between items-center gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">Asistan Mira</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] sm:text-[11px]" aria-label="Google Drive ve YouTube bağlantı durumları">
            {([
              ["Google Drive", integrationHealth?.drive],
              ["YouTube", integrationHealth?.youtube],
            ] as const).map(([label, item]) => {
              const state = integrationHealthError ? "unknown" : item?.status ?? "unknown";
              const dot = state === "online" ? "bg-emerald-400" : state === "offline" ? "bg-red-500" : "bg-amber-400";
              const text = state === "online" ? "Online" : state === "offline" ? "Offline" : "Kontrol ediliyor";
              return <span key={label} className="inline-flex items-center gap-1 text-slate-300" title={item?.detail || (integrationHealthError ? "Durum servisine ulaşılamadı" : "Bağlantı kontrol ediliyor")}>
                <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
                {label} <span className={state === "online" ? "text-emerald-300" : state === "offline" ? "text-red-300" : "text-amber-300"}>{text}</span>
              </span>;
            })}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {voiceError && (
            <span className="text-[11px] text-amber-300/90" role="alert">
              {voiceError}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowWorkspacePanels((open) => !open)}
            aria-expanded={showWorkspacePanels}
            className="text-xs bg-slate-800 text-slate-200 border border-slate-600 px-3 py-2 rounded-lg hover:bg-slate-700"
          >
            {showWorkspacePanels ? 'Panelleri Gizle' : 'Araçlar'}
          </button>
          <button
            type="button"
            onClick={() => {
              const nextOpen = !taskCenterOpen;
              setTaskCenterOpen(nextOpen);
              if (nextOpen) void loadManagedDrafts();
            }}
            aria-expanded={taskCenterOpen}
            className="text-xs bg-blue-600/30 text-blue-300 border border-blue-500/40 px-3 py-2 rounded-lg hover:bg-blue-600/50"
          >
            {taskCenterOpen ? 'Görev Merkezi ▴' : 'Görev Merkezi'}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain my-3 sm:my-4 space-y-4 pr-1 sm:pr-2 pb-2">
        <section className="rounded-xl border border-emerald-500/30 bg-slate-800/90 p-3 sm:p-4 space-y-3" aria-label="Son YouTube yayınları">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-white">YouTube · Son yayın</h2>
            <button type="button" onClick={() => void loadLatestPublication()} disabled={latestPublicationLoading} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50">
              {latestPublicationLoading ? 'Kontrol ediliyor…' : 'Yenile'}
            </button>
          </div>
          {latestPublicationError && <p className="text-xs text-red-300" role="alert">{latestPublicationError}</p>}
          {latestPublicationLoading && !latestPublication && <p className="text-xs text-slate-400">YouTube kanalındaki yayınlar kontrol ediliyor…</p>}
          {latestPublication?.lastPublished ? (
            <div className="rounded-lg border border-emerald-500/20 bg-slate-950/60 p-3">
              <p className="text-[11px] uppercase tracking-wide text-emerald-300">Son herkese açık video</p>
              <p className="mt-1 break-words text-sm font-medium text-white">{latestPublication.lastPublished.title}</p>
              <p className="mt-1 text-xs text-slate-400">Yayın tarihi: {new Date(latestPublication.lastPublished.publishedAt).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })}</p>
              <a href={latestPublication.lastPublished.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs text-sky-300 underline underline-offset-2 hover:text-sky-200">YouTube videosunu aç ↗</a>
            </div>
          ) : latestPublication && !latestPublicationLoading && !latestPublicationError ? (
            <p className="text-xs text-slate-400">Kanalda herkese açık video bulunamadı.</p>
          ) : null}
          {latestPublication?.nextScheduled && (
            <div className="rounded-lg border border-sky-500/20 bg-slate-950/50 p-3">
              <p className="text-[11px] uppercase tracking-wide text-sky-300">Sıradaki planlı video</p>
              <p className="mt-1 break-words text-sm font-medium text-white">{latestPublication.nextScheduled.title}</p>
              <p className="mt-1 text-xs text-slate-400">Planlanan zaman: {new Date(latestPublication.nextScheduled.publishAt).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })}</p>
              <a href={latestPublication.nextScheduled.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs text-sky-300 underline underline-offset-2 hover:text-sky-200">YouTube bağlantısını aç ↗</a>
            </div>
          )}
          <p className="text-[10px] text-slate-500">Son yayın YouTube kanalından okunur; planlanan video ayrı gösterilir.</p>
        </section>
        {taskCenterOpen && (
          <section className="rounded-xl border border-sky-400/40 bg-slate-800/95 p-3 sm:p-4 space-y-3" aria-label="Görev Merkezi taslak yönetimi">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-bold text-white">Görev Merkezi · Taslak Yönetimi</h2>
                <p className="mt-1 text-xs text-slate-400">Kayıtlı konuları ve senaryoları buradan düzenle, arşivle, kalıcı olarak yok et ve durumlarını takip et.</p>
              </div>
              <button type="button" onClick={() => void loadManagedDrafts()} disabled={managedLoading} className="rounded-lg border border-slate-600 px-3 py-2 text-xs hover:bg-slate-700 disabled:opacity-50">
                {managedLoading ? 'Yükleniyor…' : '↻ Yenile'}
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {([
                ['active', 'Aktif taslaklar'],
                ['archived', 'Arşiv'],
                ['all', 'Tüm kayıtlar'],
              ] as const).map(([value, label]) => (
                <button key={value} type="button" onClick={() => setTaskCenterFilter(value)} className={taskCenterFilter === value ? 'rounded-lg border border-sky-400 bg-sky-600/20 px-2 py-2 text-xs font-semibold text-sky-200' : 'rounded-lg border border-slate-600 bg-slate-900/60 px-2 py-2 text-xs text-slate-300 hover:bg-slate-700'}>
                  {label} <span className="ml-1 text-slate-400">({managedDrafts.filter((item) => value === 'all' || (value === 'active' ? item.status !== 'archived' && item.status !== 'deleted' : item.status === value)).length})</span>
                </button>
              ))}
            </div>
            {managedError && <p className="rounded-lg border border-red-500/30 bg-red-950/20 p-2 text-sm text-red-300" role="alert">{managedError}</p>}
            {managedNotice && <p className="rounded-lg border border-emerald-500/20 bg-emerald-950/20 p-2 text-sm text-emerald-300" role="status">{managedNotice}</p>}
            {managedLoading && managedDrafts.length === 0 && <p className="text-sm text-slate-400">Kayıtlar yükleniyor…</p>}
            {!managedLoading && managedDrafts.filter((item) => taskCenterFilter === 'all' || (taskCenterFilter === 'active' ? item.status !== 'archived' && item.status !== 'deleted' : item.status === taskCenterFilter)).length === 0 && !managedError && (
              <p className="rounded-lg border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-400">Bu bölümde kayıt yok.</p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
              <label className="flex items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  checked={managedDrafts.filter((item) => taskCenterFilter === 'all' || (taskCenterFilter === 'active' ? !['archived', 'deleted'].includes(item.status) : item.status === taskCenterFilter)).length > 0 && managedDrafts.filter((item) => taskCenterFilter === 'all' || (taskCenterFilter === 'active' ? !['archived', 'deleted'].includes(item.status) : item.status === taskCenterFilter)).every((item) => selectedManagedIds.has(item.id))}
                  onChange={(event) => {
                    const visibleItems = managedDrafts.filter((item) => taskCenterFilter === 'all' || (taskCenterFilter === 'active' ? !['archived', 'deleted'].includes(item.status) : item.status === taskCenterFilter));
                    setSelectedManagedIds((previous) => {
                      const next = new Set(previous);
                      if (event.target.checked) visibleItems.forEach((item) => next.add(item.id));
                      else visibleItems.forEach((item) => next.delete(item.id));
                      return next;
                    });
                  }}
                  disabled={managedBusyId !== null || managedDrafts.filter((item) => taskCenterFilter === 'all' || (taskCenterFilter === 'active' ? !['archived', 'deleted'].includes(item.status) : item.status === taskCenterFilter)).length === 0}
                  className="h-4 w-4 accent-sky-500"
                />
                Tümünü seç
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-400">{managedDrafts.filter((item) => selectedManagedIds.has(item.id) && (taskCenterFilter === 'all' || (taskCenterFilter === 'active' ? !['archived', 'deleted'].includes(item.status) : item.status === taskCenterFilter))).length} kayıt seçili</span>
                <button type="button" onClick={() => void deleteSelectedManagedDrafts()} disabled={managedBusyId !== null || !managedDrafts.some((item) => selectedManagedIds.has(item.id) && (taskCenterFilter === 'all' || (taskCenterFilter === 'active' ? !['archived', 'deleted'].includes(item.status) : item.status === taskCenterFilter)))} className="rounded-lg border border-red-500/50 bg-red-950/30 px-3 py-2 text-xs font-semibold text-red-200 hover:bg-red-900/50 disabled:opacity-40">
                  {managedBusyId === -1 ? 'Seçilenler siliniyor…' : 'Seçilenleri sil ve yok et'}
                </button>
                <button type="button" onClick={() => setSelectedManagedIds(new Set())} disabled={managedBusyId !== null || selectedManagedIds.size === 0} className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-40">Seçimi temizle</button>
              </div>
            </div>
            <div className="space-y-3">
              {managedDrafts.filter((item) => taskCenterFilter === 'all' || (taskCenterFilter === 'active' ? !['archived', 'deleted'].includes(item.status) : item.status === taskCenterFilter)).map((item) => (
                <article key={item.id} className={selectedManagedIds.has(item.id) ? "rounded-lg border border-sky-400/60 bg-slate-900 p-3 space-y-3" : "rounded-lg border border-slate-700 bg-slate-900 p-3 space-y-3"}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2">
                      <input type="checkbox" aria-label={`#${item.id} ${item.title} seç`} checked={selectedManagedIds.has(item.id)} onChange={(event) => setSelectedManagedIds((previous) => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })} disabled={managedBusyId !== null} className="mt-1 h-4 w-4 shrink-0 accent-sky-500" />
                      <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-white">{item.title}</p>
                      <p className="mt-1 break-words text-xs text-slate-400">#{item.id} · {item.platform} · {item.status} · {new Date(item.updatedAt).toLocaleString('tr-TR')}</p>
                      {item.topic && <p className="mt-1 break-words text-xs text-slate-300">Konu: {item.topic}</p>}
                      </div>
                    </div>
                    <span className={item.status === 'failed' ? 'shrink-0 rounded-full bg-red-500/10 px-2 py-1 text-[10px] text-red-300' : item.status === 'ready' ? 'shrink-0 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300' : 'shrink-0 rounded-full bg-slate-700 px-2 py-1 text-[10px] text-slate-300'}>{item.status}</span>
                  </div>
                  {editingManagedId === item.id ? (
                    <div className="space-y-2">
                      <label className="block text-xs text-slate-300">Başlık
                        <input value={managedTitle} onChange={(event) => setManagedTitle(event.target.value)} maxLength={300} className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-400 focus:outline-none" />
                      </label>
                      <label className="block text-xs text-slate-300">Konu / notlar
                        <textarea value={managedTopic} onChange={(event) => setManagedTopic(event.target.value)} rows={3} maxLength={500} className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-400 focus:outline-none" />
                      </label>
                      <label className="block text-xs text-slate-300">Senaryo / taslak metni
                        <textarea value={managedScript} onChange={(event) => setManagedScript(event.target.value)} rows={8} maxLength={50000} placeholder="Bu kayıtta henüz senaryo yok. Buraya metin yazabilir veya mevcut metni düzenleyebilirsin." className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-400 focus:outline-none" />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => void saveManagedDraft(item.id)} disabled={managedBusyId !== null || !managedTitle.trim()} className="rounded-lg bg-sky-700 px-3 py-2 text-xs font-semibold hover:bg-sky-600 disabled:opacity-50">{managedBusyId === item.id ? 'Kaydediliyor…' : 'Değişiklikleri kaydet'}</button>
                        <button type="button" onClick={() => setEditingManagedId(null)} className="rounded-lg border border-slate-600 px-3 py-2 text-xs hover:bg-slate-700">Vazgeç</button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {item.generatedScript ? <details><summary className="cursor-pointer text-xs text-sky-300">Senaryoyu görüntüle</summary><pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 text-xs text-slate-200 font-sans">{item.generatedScript}</pre></details> : <p className="text-xs text-slate-500">Bu kayıtta senaryo metni yok.</p>}
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => beginManagedEdit(item)} className="rounded-lg border border-sky-400/40 px-3 py-2 text-xs text-sky-200 hover:bg-sky-600/20">✎ Düzenle</button>
                        {item.status === 'archived' ? (
                          <button type="button" onClick={() => void manageContentAction(item.id, 'restore')} disabled={managedBusyId !== null} className="rounded-lg border border-emerald-400/40 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-600/20 disabled:opacity-50">↶ Geri yükle</button>
                        ) : (
                          <button type="button" onClick={() => void manageContentAction(item.id, 'archive')} disabled={managedBusyId !== null} className="rounded-lg border border-amber-400/40 px-3 py-2 text-xs text-amber-200 hover:bg-amber-600/20 disabled:opacity-50">Arşivle</button>
                        )}
                        {item.status === 'queued' && <button type="button" onClick={() => void reviewDraft(item.id, 'generate_script')} disabled={reviewBusyId !== null || managedBusyId !== null} className="rounded-lg border border-sky-400/40 px-3 py-2 text-xs text-sky-200 hover:bg-sky-600/20 disabled:opacity-50">{reviewBusyId === item.id ? 'Senaryo hazırlanıyor…' : 'Senaryo üret'}</button>}
                        {item.status === 'draft' && item.generatedScript && <>
                          <button type="button" onClick={() => void reviewDraft(item.id, 'approve_video')} disabled={reviewBusyId !== null || managedBusyId !== null} className="rounded-lg border border-emerald-400/40 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-600/20 disabled:opacity-50">Onayla ve video üret</button>
                          <button type="button" onClick={() => void reviewDraft(item.id, 'approve_text')} disabled={reviewBusyId !== null || managedBusyId !== null} className="rounded-lg border border-slate-500 px-3 py-2 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50">Onayla, videosuz</button>
                        </>}
                        {item.status === 'failed' && <button type="button" onClick={() => void retryManualItem(item)} disabled={queueBusyId !== null || managedBusyId !== null} className="rounded-lg border border-amber-400/40 px-3 py-2 text-xs text-amber-200 hover:bg-amber-600/20 disabled:opacity-50">↻ Yeniden dene</button>}
                        {!['archived', 'deleted', 'approved', 'rejected'].includes(item.status) && <button type="button" onClick={() => void reviewDraft(item.id, 'reject')} disabled={reviewBusyId !== null || managedBusyId !== null} className="rounded-lg border border-red-400/40 px-3 py-2 text-xs text-red-200 hover:bg-red-600/20 disabled:opacity-50">Reddet</button>}
                        <button type="button" onClick={() => void manageContentAction(item.id, 'permanent_delete')} disabled={managedBusyId !== null} className="rounded-lg border border-red-500/50 bg-red-950/30 px-3 py-2 text-xs font-semibold text-red-200 hover:bg-red-900/50 disabled:opacity-50">{managedBusyId === item.id ? 'Yok ediliyor…' : 'Sil ve yok et'}</button>
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>
            <p className="text-[11px] text-slate-500">“Sil ve yok et” geri alınamaz; taslak, senaryo, ilişkili medya ve başlık izleri temizlenir. Sistem yalnızca başlığı saklamayan tek yönlü bir eşleşme özeti tutarak aynı konunun yeniden üretilmesini engeller. Liste veritabanındaki son 500 içerik kaydını gösterir.</p>
          </section>
        )}
        {showWorkspacePanels && (
          <>
        <section className="rounded-xl border border-violet-500/30 bg-slate-800/80 p-3">
          <div className="hidden">
            <button
              type="button"
              onClick={() => setAnalysisOpen((open) => !open)}
              aria-expanded={analysisOpen}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span className="font-semibold text-white">Mira Taslak Analiz Raporu</span>
              <span className="ml-auto text-slate-400" aria-hidden="true">{analysisOpen ? '▴' : '▾'}</span>
            </button>
            <button
              type="button"
              onClick={() => void runDraftAnalysis()}
              disabled={analysisRunLoading || analysisLoading}
              className="shrink-0 rounded-lg border border-violet-400/50 bg-violet-600/20 px-3 py-2 text-xs hover:bg-violet-600/40 disabled:opacity-50"
            >
              {analysisRunLoading ? 'Analiz ediliyor…' : 'Analiz Yap'}
            </button>

            <button
              type="button"
              onClick={() => void loadAnalysis()}
              disabled={analysisLoading}
              className="shrink-0 rounded-lg border border-slate-600 px-3 py-2 text-xs hover:bg-slate-700 disabled:opacity-50"
            >
              {analysisLoading ? 'Yükleniyor…' : 'Yenile'}
            </button>
          </div>
          <div className="mt-2 flex items-start gap-2">
            <textarea
              rows={5}
              value={manualTopic}
              onChange={(e) => setManualTopic(e.target.value)}
              placeholder={"Konu başlığı yazabilir veya hazır paketi yapıştırabilirsin:\nKonu: …\nKanca: …\nGelişme: …\nKaynaklar (doğrula): …\nBaşlık / Açıklama / Etiketler / Format: …"}
              className="min-h-24 min-w-0 flex-1 resize-y rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void addManualTopic()}
              disabled={manualTopicLoading || !manualTopic.trim()}
              className="shrink-0 rounded-lg border border-sky-400/50 bg-sky-600/20 px-3 py-2 text-xs hover:bg-sky-600/40 disabled:opacity-50"
            >
              {manualTopicLoading ? 'Mira başlatılıyor…' : '▶ Senaryo üret'}
            </button>
          </div>
          {manualTopicResult && <p className="mt-1 text-xs text-sky-300">{manualTopicResult}</p>}
          {manualScriptProgress && <div className="mt-3 rounded-lg border border-violet-500/30 bg-slate-950/80 p-3">
            <div className="flex items-center justify-between gap-2"><p className="text-sm font-semibold text-white">Mira canlı işlem akışı · #{manualScriptProgress.contentId}</p><span className={manualScriptProgress.status === 'success' ? 'text-xs text-emerald-300' : manualScriptProgress.status === 'failed' ? 'text-xs text-red-300' : 'text-xs text-sky-300'}>{manualScriptProgress.status === 'success' ? 'Hazır' : manualScriptProgress.status === 'failed' ? (manualScriptProgress.events[manualScriptProgress.events.length - 1]?.stage.toLocaleLowerCase('tr-TR').includes('doğrulanamadı') || manualScriptProgress.events[manualScriptProgress.events.length - 1]?.stage.toLocaleLowerCase('tr-TR').includes('kaynak/doğruluk') ? 'Doğrulanamadı' : 'Hata') : manualScriptProgress.events.length === 0 ? 'Aşama kaydı bekleniyor' : 'Hazırlanıyor'}</span></div>
            <div className="mt-2 space-y-2">{manualScriptProgress.events.length ? manualScriptProgress.events.map((event) => <div key={event.id} className="flex items-start gap-2 text-xs"><span className={event.status === 'success' ? 'text-emerald-300' : event.status === 'failed' ? 'text-red-300' : 'text-sky-300'}>{event.status === 'success' ? '✓' : event.status === 'failed' ? '!' : '•'}</span><div className="min-w-0 flex-1"><p className={event.status === 'failed' ? 'font-medium text-red-300' : 'font-medium text-slate-100'}>{event.stage}</p>{event.detail && <p className="mt-1 text-slate-300"><span className="text-slate-500">Neden:</span> {event.detail}</p>}{event.nextAction && <p className="mt-1 text-sky-200"><span className="text-sky-400">Sonraki adım:</span> {event.nextAction}</p>}<p className="mt-1 text-slate-500">{new Date(event.createdAt).toLocaleTimeString('tr-TR')} · %{event.percentage}</p></div></div>) : <p className="text-xs text-amber-200">Canlı aşama kaydı henüz alınmadı. Kuyruktaki “İşleniyor” durumu senaryonun hazır olduğunu veya kaynakların doğrulandığını göstermez; görevden gerçek ilerleme kaydı bekleniyor.</p>}</div>
          </div>}
          <div className="mt-3 rounded-lg border border-sky-500/20 bg-slate-900/70 p-3">
            <div className="mb-2 flex items-center justify-between gap-2"><p className="text-sm font-semibold text-white">Manuel konu kuyruğu</p><button type="button" onClick={() => void loadManualQueue()} disabled={queueLoading} className="rounded border border-slate-600 px-2 py-1 text-xs hover:bg-slate-700 disabled:opacity-50">{queueLoading ? 'Yükleniyor…' : 'Kuyruğu yenile'}</button></div>
            <p className="mb-3 text-xs text-slate-400">Tek satırlık konu veya KONU / KANCA / GELİŞME / KAYNAKLAR / BAŞLIK / AÇIKLAMA / ETİKETLER / FORMAT alanları olan hazır paketi yapıştırabilirsin. Mira verdiğin ayrıntıları korur, kaynak adaylarını doğrular ve senaryoyu onayına sunar. Onayın olmadan video üretimi veya YouTube yüklemesi başlamaz.</p>
            {queueItems.length === 0 ? <p className="text-xs text-slate-500">Bekleyen manuel konu yok.</p> : <div className="space-y-2">{queueItems.map((item) => <div key={item.id} className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-950/70 p-3"><div className="min-w-0 flex-1">
                <button type="button" onClick={() => void toggleQueueDetails(item)} aria-expanded={expandedQueueIds.has(item.id)} className="w-full break-words text-left text-sm font-medium text-white hover:text-sky-200 focus:outline-none focus:ring-1 focus:ring-sky-400 rounded">
                  {item.title} <span className="ml-1 text-xs text-sky-300">{expandedQueueIds.has(item.id) ? '▴ Ayrıntıları gizle' : '▾ Hata/işlem ayrıntıları'}</span>
                </button>
                <p className="mt-1 text-xs text-slate-400">#{item.id} · {item.status === 'queued' ? 'Sırada' : item.status === 'processing' ? 'İşleniyor' : 'Hata / yeniden denenebilir'}</p>
              </div><div className="flex flex-wrap gap-2">{item.status === 'failed' && <button type="button" onClick={() => void retryManualItem(item)} disabled={queueBusyId !== null} className="rounded-lg border border-amber-400/50 bg-amber-600/20 px-3 py-2 text-xs font-semibold hover:bg-amber-600/40 disabled:cursor-not-allowed disabled:opacity-40">{queueBusyId === item.id ? 'Yeniden deneniyor…' : '↻ Yeniden dene'}</button>}<button type="button" onClick={() => void startManualVideo(item)} disabled={queueBusyId !== null || item.status !== 'queued'} className="rounded-lg border border-slate-500 px-3 py-2 text-xs font-medium hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40">{queueBusyId === item.id ? 'Başlatılıyor…' : '✍ Senaryo hazırla'}</button><button type="button" onClick={() => void startManualProduction(item)} disabled={queueBusyId !== null || item.status !== 'queued'} className="rounded-lg border border-emerald-400/50 bg-emerald-600/20 px-3 py-2 text-xs font-semibold hover:bg-emerald-600/40 disabled:cursor-not-allowed disabled:opacity-40">{queueBusyId === item.id ? 'Başlatılıyor…' : '▶ Bu videoyu şimdi üret'}</button></div>
              {expandedQueueIds.has(item.id) && <div className="rounded-lg border border-amber-500/30 bg-slate-900/80 p-3 text-xs">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="font-semibold text-amber-200">Konu #{item.id} · İşlem ve hata ayrıntıları</p>
                  <button type="button" onClick={() => void toggleQueueDetails(item)} className="rounded border border-slate-600 px-2 py-1 text-slate-300 hover:bg-slate-700">Kapat</button>
                </div>
                {queueDetailsLoading.has(item.id) ? <p className="text-slate-300">Kayıtlı aşamalar ve hata nedeni alınıyor…</p>
                  : (queueEventDetails[item.id]?.length ?? 0) > 0
                    ? <div className="space-y-3">{queueEventDetails[item.id].map((event) => <div key={event.id} className="border-l-2 border-slate-600 pl-3">
                      <p className={event.status === 'failed' ? 'font-semibold text-red-300' : event.status === 'success' ? 'font-semibold text-emerald-300' : 'font-semibold text-slate-100'}>{event.stage}</p>
                      {event.detail && <p className="mt-1 whitespace-pre-wrap break-words text-slate-300"><span className="text-slate-500">Ayrıntı:</span> {event.detail}</p>}
                      {event.nextAction && <p className="mt-1 whitespace-pre-wrap break-words text-sky-200"><span className="text-sky-400">Önerilen adım:</span> {event.nextAction}</p>}
                      <p className="mt-1 text-slate-500">{new Date(event.createdAt).toLocaleString('tr-TR')} · %{event.percentage} · {event.status === 'failed' ? 'Hata' : event.status === 'success' ? 'Tamamlandı' : 'Devam ediyor'}</p>
                    </div>)}</div>
                    : <p className="text-amber-200">Bu konu için canlı aşama/hata ayrıntısı kaydı bulunamadı. Bu, hatanın nedeninin kaydedildiği anlamına gelmez; olay kaydı backend tarafında ayrıca incelenmelidir.</p>}
              </div>}
            </div>)}</div>}
          </div>
          {analysis && false && analysisOpen && (
            <div className="mt-3 space-y-2">
              {analysisError && <p className="text-sm text-red-300" role="alert">{analysisError}</p>}
              {analysisLoading && !analysis && <p className="text-sm text-slate-400">Son analiz raporu yükleniyor…</p>}
              {!analysisLoading && !analysisError && !analysis?.report && (
                <p className="text-sm text-slate-400">Henüz kaydedilmiş bir analiz raporu bulunamadı. Otomasyonun bir sonraki başarılı analizinden sonra burada görünecek.</p>
              )}
              {analysis?.report && (
                <>
                  <p className="text-xs text-slate-400">
                    {analysis?.createdAt ? `Rapor zamanı: ${new Date(analysis?.createdAt ?? '').toLocaleString('tr-TR')}` : 'Son kaydedilen rapor'}
                    {analysis?.provider ? ` · ${analysis?.provider}` : ''}
                    {analysis?.model ? ` / ${analysis?.model}` : ''}
                  </p>
                  <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm leading-relaxed">{renderAnalysisReport(analysis?.report)}</div>
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-950/10 p-3 space-y-3">
                    <p className="text-xs text-emerald-200">Karar alanı: yalnızca bu raporda analiz edilmiş içerikler burada onaylanır veya reddedilir. Taslak deposundaki kayıtlar bu kararlardan etkilenmeden önce burada değerlendirilir. Kaynak doğrulaması ayrıca yapılmalıdır.</p>
                    {(analysis?.titles ?? []).length === 0 ? (
                      <p className="text-sm text-slate-400">Bu rapor için karar verilebilir içerik listesi bulunamadı.</p>
                    ) : (analysis?.titles ?? []).map((item) => (
                      <div key={item.id} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 p-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-white">{item.title}</p>
                          <p className="text-xs text-slate-500">Taslak #{item.id}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={() => void reviewDraft(item.id, 'approve_video')} disabled={reviewBusyId !== null} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-medium hover:bg-emerald-600 disabled:opacity-50">
                            {reviewBusyId === item.id ? 'İşleniyor…' : 'Onayla ve video üret'}
                          </button>
                          <button type="button" onClick={() => void reviewDraft(item.id, 'approve_text')} disabled={reviewBusyId !== null} className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-medium hover:bg-slate-700 disabled:opacity-50">
                            Onayla, videosuz
                          </button>
                          <button type="button" onClick={() => void reviewDraft(item.id, 'reject')} disabled={reviewBusyId !== null} className="rounded-lg bg-red-900/80 px-3 py-2 text-xs font-medium hover:bg-red-800 disabled:opacity-50">
                            Reddet
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </section>
        <section className={videoProgress ? "rounded-xl border border-blue-500/30 bg-slate-800/80 p-3" : "hidden"}>
          <div className="hidden">
            <button
              type="button"
              onClick={() => setDraftPanelOpen((open) => !open)}
              aria-expanded={draftPanelOpen}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span className="font-semibold text-white">İçerik Deposu · İşçi Taslakları</span>
              <span className="shrink-0 rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
                {drafts.length} içerik
              </span>
              <span className="ml-auto text-slate-400" aria-hidden="true">{draftPanelOpen ? '▴' : '▾'}</span>
            </button>

            <button
              type="button"
              onClick={() => void loadDrafts()}
              disabled={draftsLoading}
              className="shrink-0 rounded-lg border border-slate-600 px-3 py-2 text-xs hover:bg-slate-700 disabled:opacity-50"
            >
              {draftsLoading ? 'Yükleniyor…' : 'Yenile'}
            </button>
          </div>
          {false && draftPanelOpen && (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-slate-400">İşçilerin topladığı içerikler burada birikir. Senaryosu olmayanı önce <b className="text-slate-300">Senaryoyu oluştur</b> ile hazırlat; <b className="text-slate-300">Onayla ve video üret</b> üretimi heaslak yok. Yeni taslaklar burada görünecek.</p>
              {drafts.map((draft) => (
                <article key={draft.id} className="rounded-lg border border-slate-700 bg-slate-900 p-3 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="font-medium text-white">{draft.title}</h3>
                      <p className="text-xs text-slate-400">{draft.platform}{draft.topic ? ` · ${draft.topic}` : ''}</p>
                    </div>
                    <span className={`rounded-full px-2 py-1 text-xs ${draft.status === 'queued' ? 'bg-sky-500/10 text-sky-300' : draft.status === 'processing' ? 'bg-violet-500/10 text-violet-300' : 'bg-amber-500/10 text-amber-300'}`}>
                      {draft.status === 'queued' ? 'Senaryo bekliyor' : draft.status === 'processing' ? 'Senaryo yazılıyor…' : draft.generatedScript ? 'Onaya hazır' : 'Senaryo eksik'}
                    </span>
                  </div>
                  {draft.generatedScript ? (
                    <pre className="whitespace-pre-wrap break-words text-sm text-slate-200 font-sans">{draft.generatedScript}</pre>
                  ) : (
                    <p className="text-sm text-slate-400">Bu kayıt için oluşturulmuş senaryo bulunamadı.</p>
                  )}
                  {draft.generation?.provider && (
                    <p className="text-[11px] text-slate-500">Model: {draft.generation.provider}{draft.generation.model ? ` / ${draft.generation.model}` : ''}</p>
                  )}
                  {/* Her kartın kendi işlemi: duruma göre tek birincil buton */}
                  {draft.status !== 'processing' && (
                    <div className="flex flex-wrap gap-2">
                      {draft.status === 'queued' && (
                        <button
                          type="button"
                          onClick={() => void reviewDraft(draft.id, 'generate_script')}
                          disabled={reviewBusyId !== null}
                          className="rounded-lg bg-sky-700 px-3 py-2 text-xs font-medium hover:bg-sky-600 disabled:opacity-50"
                        >
                          {reviewBusyId === draft.id ? 'Senaryo yazılıyor…' : 'Senaryoyu şimdi oluştur'}
                        </button>
                      )}
                      {draft.status === 'draft' && draft.generatedScript && (
                        <>
                          <button
                            type="button"
                            onClick={() => void reviewDraft(draft.id, 'approve_video')}
                            disabled={reviewBusyId !== null}
                            className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-medium hover:bg-emerald-600 disabled:opacity-50"
                          >
                            {reviewBusyId === draft.id ? 'İşleniyor…' : 'Onayla ve video üret'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void reviewDraft(draft.id, 'approve_text')}
                            disabled={reviewBusyId !== null}
                            className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-medium hover:bg-slate-700 disabled:opacity-50"
                          >
                            Onayla, videosuz
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => void reviewDraft(draft.id, 'reject')}
                        disabled={reviewBusyId !== null}
                        className="rounded-lg bg-red-900/80 px-3 py-2 text-xs font-medium hover:bg-red-800 disabled:opacity-50"
                      >
                        Reddet
                      </button>
                    </div>
                  )}

                </article>
              ))}
            </div>
          )}
          {videoProgress && (
            <div className={`mt-3 rounded-xl border p-3 sm:p-4 ${videoProgress.status === 'failed' ? 'border-red-400/40 bg-red-950/20' : videoProgress.status === 'success' ? 'border-emerald-400/30 bg-emerald-950/15' : 'border-sky-400/30 bg-slate-950/80'}`} role="status" aria-live="polite">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wider text-slate-400">Video üretim monitörü · #{videoProgress.contentId}</p>
                  <h3 className="mt-1 break-words text-sm font-semibold text-white">{videoProgress.title}</h3>
                  <p className="mt-1 text-xs text-slate-300">{videoProgress.stage}</p>
                </div>
                <div className="shrink-0 text-right">
                  <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${videoProgress.status === 'failed' ? 'bg-red-400/15 text-red-300' : videoProgress.status === 'success' ? 'bg-emerald-400/15 text-emerald-300' : 'bg-sky-400/15 text-sky-200'}`}>
                    {videoProgress.status === 'failed' ? 'Hata' : videoProgress.status === 'success' ? 'Tamamlandı' : videoProgress.status === 'waiting' ? 'Bekliyor' : 'Çalışıyor'}
                  </span>
                  <p className={`mt-2 text-xl font-bold tabular-nums ${videoProgress.status === 'failed' ? 'text-red-300' : videoProgress.status === 'success' ? 'text-emerald-300' : 'text-sky-200'}`}>{videoProgress.percentage}%</p>
                </div>
              </div>
              <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
                <div className={`h-full rounded-full transition-all duration-500 ${videoProgress.status === 'failed' ? 'bg-red-400' : videoProgress.status === 'success' ? 'bg-emerald-400' : 'bg-sky-400'}`} style={{ width: `${videoProgress.percentage}%` }} />
              </div>
              <p className="mt-2 text-[11px] text-slate-500">Aşamalar sunucudan düzenli okunur. Başarısız aşamalar kaydedilir; yeniden deneme önceki kayıtlı görsel ve ses dosyalarını kullanır.</p>
              {(videoProgress.status === 'waiting' || videoProgress.status === 'failed') && (
                <button
                  type="button"
                  onClick={() => void resumeVideoProduction(videoProgress.contentId, videoProgress.title)}
                  disabled={reviewBusyId !== null}
                  className="mt-3 w-full rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
                >
                  {reviewBusyId === videoProgress.contentId ? 'Devam ediliyor…' : 'Kaldığı yerden yeniden dene'}
                </button>
              )}
              <div className="mt-4 border-t border-slate-700 pt-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">Canlı işlem günlüğü</h4>
                  <span className="text-[10px] text-slate-500">{videoEvents.length} olay</span>
                </div>
                {videoEvents.length === 0 ? (
                  <p className="text-xs text-slate-500">Sunucudan ilk aşama kaydı bekleniyor…</p>
                ) : (
                  <ol className="space-y-2">
                    {videoEvents.map((event) => (
                      <li key={event.id} className="flex items-start gap-2 text-xs">
                        <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${event.status === 'failed' || /^hata:/i.test(event.stage) ? 'bg-red-500/20 text-red-300' : event.status === 'success' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-sky-500/20 text-sky-300'}`}>
                          {event.status === 'failed' || /^hata:/i.test(event.stage) ? '!' : event.status === 'success' ? '✓' : '·'}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className={`break-words ${event.status === 'failed' || /^hata:/i.test(event.stage) ? 'text-red-300' : 'text-slate-200'}`}>{event.stage}</p>
                          <p className="mt-0.5 text-[10px] text-slate-500">{new Date(event.createdAt).toLocaleTimeString('tr-TR')} · %{event.percentage}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          )}
          {reviewNotice && <p className="mt-3 text-sm text-emerald-300" role="status">{reviewNotice}</p>}
        </section>
        <section className="rounded-xl border border-lime-400/30 bg-slate-800/80 p-3">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setReadyPanelOpen((open) => !open)}
              aria-expanded={readyPanelOpen}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span className="font-semibold text-white">Üretilen Videolar</span>
              <span className="shrink-0 rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
                {readyVideos.length} onay bekliyor
              </span>
              <span className="ml-auto text-slate-400" aria-hidden="true">{readyPanelOpen ? '▴' : '▾'}</span>
            </button>
            <button
              type="button"
              onClick={() => void loadReadyVideos()}
              disabled={readyLoading}
              className="shrink-0 rounded-lg border border-slate-600 px-3 py-2 text-xs hover:bg-slate-700 disabled:opacity-50"
            >
              {readyLoading ? 'Yükleniyor…' : 'Yenile'}
            </button>
          </div>
          {readyPanelOpen && (
            <div className="mt-3 space-y-4">
              <p className="text-xs text-slate-400">Yayınla dediğinde video YouTube&apos;a <b className="text-slate-300">private</b> olarak yüklenir; kanalında görüp onayladıktan sonra public yaparsın.</p>
              {publishResult && <p className="text-sm text-lime-300 break-all">{publishResult}</p>}
              {readyError && <p className="text-sm text-red-300" role="alert">{readyError}</p>}
              {!readyLoading && readyVideos.length === 0 && !readyError && (
                <p className="text-sm text-slate-400">Onay bekleyen üretilmiş video yok. Bir taslağı videolu onaylayıp üretim bittiğinde burada belirecek.</p>
              )}
              {readyVideos.map((item) => (
                <article key={item.id} className="rounded-lg border border-slate-700 bg-slate-900 p-3 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="font-medium text-white">{item.title}</h3>
                      <p className="text-xs text-slate-400">{item.platform}{item.topic ? ` · ${item.topic}` : ''} · #{item.id}</p>
                    </div>
                    <span className="rounded-full bg-lime-500/10 px-2 py-1 text-xs text-lime-300">Yayın onayı bekliyor</span>
                  </div>
                  {item.hasVideo && item.previewPath ? (
                    <video
                      controls
                      playsInline
                      preload="metadata"
                      src={item.previewPath}
                      className="mx-auto w-full max-w-[240px] rounded-lg border border-slate-700 bg-black"
                    />
                  ) : (
                    <p className="text-sm text-slate-400">Bu içerik için video varlığı bulunamadı (üretim tamamlanmamış olabilir).</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void publishVideo(item.id)}
                      disabled={publishBusyId !== null || !item.hasVideo}
                      className="flex-1 rounded-lg bg-lime-500/90 px-3 py-2.5 text-sm font-semibold text-black hover:bg-lime-400 disabled:opacity-50"
                    >
                      {publishBusyId === item.id ? 'Yükleniyor…' : 'YouTube\'a Yayınla'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void reviewDraft(item.id, 'reject').then(() => loadReadyVideos())}
                      disabled={publishBusyId !== null}
                      className="rounded-lg bg-red-900/80 px-3 py-2.5 text-sm font-medium hover:bg-red-800 disabled:opacity-50"
                    >
                      Reddet
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
          </>
        )}
        {messages.length === 0 && (
          <p className="text-slate-400 text-center mt-10">
            Mira hazır. Komut listesini görmek için <code className="bg-slate-800 px-2 py-1 rounded">/</code> tuşuna basabilirsin.
          </p>
        )}
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`p-3 rounded-lg max-w-[90%] ${
              msg.role === 'user'
                ? 'bg-blue-600 ml-auto text-white'
                : 'bg-slate-800 border border-slate-700 text-slate-100'
            }`}
          >
            {renderMessageContent(msg, index)}
          </div>
        ))}
        {(loading || chatActivity.length > 0) && (
          <section className="max-w-[92%] rounded-lg border border-slate-700 bg-slate-950/95 px-3 py-2" aria-label="Mira canlı işlem akışı" aria-live="polite">
            <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-semibold text-slate-300">
              <span>Mira · Canlı işlem akışı</span>
              <span className={loading ? 'text-amber-300' : chatActivity.some((event) => event.status === 'error') ? 'text-red-300' : 'text-emerald-300'}>{loading ? 'Bekliyor' : chatActivity.some((event) => event.status === 'error') ? 'Hata' : 'Tamamlandı'}</span>
            </div>
            <div className="h-[4.5rem] overflow-hidden space-y-1">
              {chatActivity.slice(-3).map((event) => (
                <div key={event.id} className="flex min-w-0 items-start gap-2 text-xs leading-5">
                  <span aria-hidden="true" className={event.status === 'error' ? 'text-red-400' : event.status === 'success' ? 'text-emerald-400' : 'text-amber-300'}>{event.status === 'error' ? '✕' : event.status === 'success' ? '✓' : '…'}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-200">{event.message}</span>
                  <time className="shrink-0 text-[10px] text-slate-500">{new Date(event.createdAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                </div>
              ))}
              {loading && chatActivity.length === 0 && <div className="text-xs leading-5 text-slate-300">İstek hazırlanıyor; henüz sunucu işlemi doğrulanmadı.</div>}
            </div>
            {loading && <div className="mt-1 text-[10px] text-slate-500">Sunucu içindeki dosya/araç adımları ayrıca raporlanmadıkça burada gösterilmez.</div>}
          </section>
        )}
        <div ref={messagesEndRef} aria-hidden="true" className="h-px w-full shrink-0" />
      </div>

      <div className="relative">
        {showSuggestions && (
          <div className="absolute bottom-full mb-2 left-0 right-0 bg-slate-800 border border-slate-700 rounded-lg shadow-xl overflow-hidden z-10">
            <div className="px-3 py-1.5 text-xs text-slate-400 bg-slate-850 border-b border-slate-700 font-semibold">
              Önerilen Komutlar
            </div>
            {COMMANDS.map((item, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => selectCommand(item.command)}
                className="w-full text-left px-4 py-2.5 hover:bg-slate-700 flex justify-between items-center transition-colors border-b border-slate-700/50 last:border-none"
              >
                <code className="text-blue-400 font-bold">{item.command}</code>
                <span className="text-xs text-slate-400">{item.description}</span>
              </button>
            ))}
          </div>
        )}

        <div className="mb-2 flex flex-wrap gap-2" aria-label="Hızlı komutlar">
          {[
            { label: 'Durum', command: '/durum' },
            { label: 'Drive kataloğu', command: '/drive-katalog' },
          ].map((item) => (
            <button
              key={item.command}
              type="button"
              onClick={() => {
                setInput(item.command);
                inputRef.current?.focus();
              }}
              className="rounded-full border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs text-slate-300 transition hover:border-blue-500/60 hover:bg-blue-500/10 hover:text-white"
            >
              {item.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="flex gap-2 border-t border-slate-700 pt-3 pb-[env(safe-area-inset-bottom)]">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={handleInputChange}
            placeholder="Görev veya komut girin..."
            className="min-w-0 flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={loading}
            className="shrink-0 bg-blue-600 hover:bg-blue-500 text-white font-medium px-4 sm:px-6 py-3 rounded-lg disabled:opacity-50"
          >
            Gönder
          </button>
        </form>
      </div>

      <footer className="border-t border-slate-700 px-4 py-4 text-center text-xs text-slate-400">
        <div className="mb-2 flex items-center justify-center gap-2" aria-label="YouTube entegrasyonu">
          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-red-500"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8ZM9.6 15.6V8.4l6.3 3.6-6.3 3.6Z"/></svg>
          <span>YouTube entegrasyonu</span>
        </div>
        <a href="/privacy" className="underline underline-offset-4 hover:text-white">Gizlilik Politikası</a>
      </footer>
    </main>
  );
}
