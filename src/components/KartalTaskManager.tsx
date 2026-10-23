"use client";

import React, { useEffect, useState, useCallback } from "react";

interface WorkerItem {
  id: string;
  name: string;
  role: string;
  status: string;
  updated_at: string;
  telegram_last?: string;
  last_action: string;
}

interface VideoItem {
  no: number;
  file: string;
  title: string;
  status: string;
  views: number;
  likes: number;
  comments: number;
  published_at: string;
  url: string;
}

interface AlertItem {
  id: string;
  level: string;
  worker: string;
  time: string;
  title: string;
  detail: string;
  action: string;
}

interface StatusReport {
  system_name: string;
  updated_at: string;
  overall_status: string;
  channel: {
    name: string;
    subscribers: number;
    total_views: number;
    published_videos: number;
    ready_shorts_stock: number;
    ready_long_stock: number;
  };
  workers: WorkerItem[];
  videos: VideoItem[];
  alerts: AlertItem[];
}

interface CustomConnection {
  id: string;
  platform: string;
  account: string;
  endpoint: string;
  status: "Hazır" | "Beklemede";
  addedAt: string;
}

function getShortCleanTitle(rawTitle: string): { shortTitle: string; fullClean: string; hashtags: string[] } {
  if (!rawTitle) return { shortTitle: "Başlıksız Video", fullClean: "", hashtags: [] };
  const hashtags = rawTitle.match(/#[\wçğıöşüÇĞİÖŞÜ]+/g) || [];
  // Remove hashtags and emojis
  const withoutTags = rawTitle
    .replace(/#[\wçğıöşüÇĞİÖŞÜ]+/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = withoutTags.split(" ").filter(Boolean);
  const shortTitle = words.slice(0, 5).join(" ") + (words.length > 5 ? "…" : "");
  return {
    shortTitle: shortTitle || rawTitle.slice(0, 28),
    fullClean: withoutTags || rawTitle,
    hashtags,
  };
}

function isWorkerTimestampStale(ts: string): boolean {
  if (!ts) return true;
  // Normalize "2026.10.23 - 21:24" or "2026-10-23 21:24"
  const m = ts.match(/(\d{4})[.-](\d{2})[.-](\d{2})\s*-?\s*(\d{2}):(\d{2})/);
  if (!m) return false;
  const parsed = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+03:00`);
  if (Number.isNaN(parsed.getTime())) return false;
  const diffHours = (Date.now() - parsed.getTime()) / (1000 * 3600);
  // If worker hasn't updated in more than 12 hours, mark as stale
  return diffHours > 12;
}

export default function KartalTaskManager({
  onSwitchToVoice,
}: {
  onSwitchToVoice?: () => void;
}) {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [lastTelegramTime, setLastTelegramTime] = useState<string>("21:24");
  const [activeTab, setActiveTab] = useState<"workers" | "videos" | "connections" | "alerts">("workers");
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<string>("");
  const [expandedVideoNo, setExpandedVideoNo] = useState<number | null>(null);

  // Manuel Bağlantı Ekleme Zemini
  const [customConnections, setCustomConnections] = useState<CustomConnection[]>([
    {
      id: "conn-tiktok",
      platform: "TikTok",
      account: "@bilgidozuofficial",
      endpoint: "TikTok Content Posting API / Manuel Bağlantı Zemini Hazır",
      status: "Beklemede",
      addedAt: "2026.10.24",
    },
    {
      id: "conn-ig",
      platform: "Instagram Reels",
      account: "@bilgidozuofficial",
      endpoint: "Instagram Graph API / Reels Otomatik Paylaşım Zemini Hazır",
      status: "Beklemede",
      addedAt: "2026.10.24",
    },
  ]);
  const [newPlatform, setNewPlatform] = useState<string>("TikTok");
  const [newAccount, setNewAccount] = useState<string>("");
  const [newEndpoint, setNewEndpoint] = useState<string>("");

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`/api/kartal/status?t=${Date.now()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Durum verisi alınamadı");
      }
      setReport(data.report);
      if (data.last_telegram_time) {
        setLastTelegramTime(data.last_telegram_time);
      }
      const now = new Date();
      setLastRefreshedAt(
        now.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bağlantı hatası");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch(`/api/kartal/status?t=${Date.now()}`, { cache: "no-store" })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!active) return;
        if (!ok || !data.ok) {
          setError(data.error || "Durum verisi alınamadı");
        } else {
          setReport(data.report);
          if (data.last_telegram_time) {
            setLastTelegramTime(data.last_telegram_time);
          }
          const now = new Date();
          setLastRefreshedAt(
            now.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
          );
        }
        setLoading(false);
      })
      .catch((e) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Bağlantı hatası");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleAddConnection = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAccount.trim() && !newEndpoint.trim()) return;
    const item: CustomConnection = {
      id: `conn-${Date.now()}`,
      platform: newPlatform,
      account: newAccount.trim() || "@bilgidozuofficial",
      endpoint: newEndpoint.trim() || "Manuel API / Webhook bağlantısı tanımlandı",
      status: "Hazır",
      addedAt: new Date().toLocaleDateString("tr-TR"),
    };
    setCustomConnections((prev) => [item, ...prev]);
    setNewAccount("");
    setNewEndpoint("");
  };

  // Dürüst Üst Başlık Hesabı: Herhangi bir işçide Dikkat/Sorun varsa VEYA kayıt eskiyse "Dikkat gerek" göster
  const hasStaleWorker =
    report?.workers?.some((w) => isWorkerTimestampStale(w.updated_at)) ?? false;
  const hasWarningWorker =
    report?.workers?.some((w) => w.status !== "Çalışıyor") ?? false;
  const hasWarningAlert =
    report?.alerts?.some((a) => a.level === "Dikkat gerek" || a.level === "Sorun var") ?? false;

  const honestOverallStatus =
    !report
      ? "Kontrol ediliyor"
      : hasWarningWorker || hasWarningAlert || hasStaleWorker
      ? "Dikkat gerek"
      : "Her şey çalışıyor";

  const statusBadge = (status: string, isStale = false) => {
    const effectiveStatus = isStale && status === "Çalışıyor" ? "Dikkat gerek" : status;
    const isOk = effectiveStatus === "Çalışıyor" || effectiveStatus === "Her şey çalışıyor" || effectiveStatus === "Yüklendi" || effectiveStatus === "Hazır";
    const isWarn = effectiveStatus === "Dikkat gerek" || effectiveStatus === "Beklemede";
    const bg = isOk ? "#ecfdf5" : isWarn ? "#fffbeb" : "#fef2f2";
    const text = isOk ? "#047857" : isWarn ? "#b45309" : "#b91c1c";
    const dot = isOk ? "#10b981" : isWarn ? "#f59e0b" : "#ef4444";
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "4px 10px",
          borderRadius: "9999px",
          fontSize: "12px",
          fontWeight: 600,
          backgroundColor: bg,
          color: text,
          border: `1px solid ${dot}33`,
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            width: "7px",
            height: "7px",
            borderRadius: "9999px",
            backgroundColor: dot,
          }}
        />
        {isStale && status === "Çalışıyor" ? "Dikkat gerek (Eski kayıt)" : status}
      </span>
    );
  };

  const filteredVideos =
    report?.videos.filter(
      (v) =>
        v.title.toLowerCase().includes(search.toLowerCase()) ||
        v.file.toLowerCase().includes(search.toLowerCase())
    ) || [];

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#f8fafc",
        color: "#0f172a",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      {/* ÜST BAŞLIK ÇUBUĞU */}
      <header
        style={{
          backgroundColor: "#ffffff",
          borderBottom: "1px solid #e2e8f0",
          padding: "14px 24px",
          position: "sticky",
          top: 0,
          zIndex: 20,
        }}
      >
        <div
          style={{
            maxWidth: "1080px",
            margin: "0 auto",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "19px", fontWeight: 800, letterSpacing: "-0.02em", color: "#0f172a" }}>
              KartaL AI
            </span>
            {report && statusBadge(honestOverallStatus)}
            <span style={{ fontSize: "12px", color: "#475569", fontWeight: 500 }}>
              Telegram&apos;a son bildirim: <strong>{lastTelegramTime}</strong>
              {lastRefreshedAt ? ` · Panel yenileme: ${lastRefreshedAt}` : ""}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            {/* BELİRGİN YENİLE DÜĞMESİ */}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              style={{
                padding: "8px 16px",
                fontSize: "13px",
                fontWeight: 700,
                borderRadius: "8px",
                border: "2px solid #0f172a",
                backgroundColor: refreshing ? "#e2e8f0" : "#ffffff",
                color: "#0f172a",
                cursor: refreshing ? "wait" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                boxShadow: "0 1px 2px rgba(15, 23, 42, 0.08)",
              }}
            >
              <span style={{ fontSize: "15px", lineHeight: 1 }}>↻</span>
              {refreshing ? "Yenileniyor…" : "Yenile"}
            </button>

            {onSwitchToVoice ? (
              <button
                onClick={onSwitchToVoice}
                style={{
                  padding: "8px 14px",
                  fontSize: "13px",
                  fontWeight: 600,
                  borderRadius: "8px",
                  border: "1px solid #cbd5e1",
                  backgroundColor: "#0f172a",
                  color: "#ffffff",
                  cursor: "pointer",
                }}
              >
                🎙️ Sesli Asistan
              </button>
            ) : (
              <a
                href="/?voice=1"
                style={{
                  padding: "8px 14px",
                  fontSize: "13px",
                  fontWeight: 600,
                  borderRadius: "8px",
                  border: "1px solid #cbd5e1",
                  backgroundColor: "#0f172a",
                  color: "#ffffff",
                  textDecoration: "none",
                }}
              >
                🎙️ Sesli Asistan
              </a>
            )}
          </div>
        </div>
      </header>

      {/* ANA İÇERİK */}
      <main style={{ maxWidth: "1080px", margin: "0 auto", padding: "20px 24px 48px" }}>
        {/* KANAL ÖZET ŞERİDİ */}
        {report && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
              gap: "12px",
              marginBottom: "20px",
            }}
          >
            <div
              style={{
                backgroundColor: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "12px 16px",
              }}
            >
              <div style={{ fontSize: "12px", color: "#64748b" }}>Yayındaki Video</div>
              <div style={{ fontSize: "20px", fontWeight: 700, marginTop: "2px" }}>
                {report.channel.published_videos}
              </div>
            </div>
            <div
              style={{
                backgroundColor: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "12px 16px",
              }}
            >
              <div style={{ fontSize: "12px", color: "#64748b" }}>Toplam İzlenme</div>
              <div style={{ fontSize: "20px", fontWeight: 700, marginTop: "2px" }}>
                {report.channel.total_views.toLocaleString("tr-TR")}
              </div>
            </div>
            <div
              style={{
                backgroundColor: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "12px 16px",
              }}
            >
              <div style={{ fontSize: "12px", color: "#64748b" }}>Kalan Shorts Stoku</div>
              <div style={{ fontSize: "20px", fontWeight: 700, marginTop: "2px" }}>
                {report.channel.ready_shorts_stock}
              </div>
            </div>
            <div
              style={{
                backgroundColor: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "12px 16px",
              }}
            >
              <div style={{ fontSize: "12px", color: "#64748b" }}>Kalan Uzun Video</div>
              <div style={{ fontSize: "20px", fontWeight: 700, marginTop: "2px" }}>
                {report.channel.ready_long_stock}
              </div>
            </div>
          </div>
        )}

        {/* SEKMELER: İŞÇİLER · VİDEOLAR · BAĞLANTILAR · UYARILAR */}
        <div
          style={{
            display: "flex",
            gap: "8px",
            borderBottom: "1px solid #e2e8f0",
            marginBottom: "16px",
            flexWrap: "wrap",
          }}
        >
          {[
            { id: "workers", label: `İşçiler (${report?.workers.length ?? 5})` },
            { id: "videos", label: `Videolar (${report?.videos.length ?? 0})` },
            { id: "connections", label: `Bağlantılar (${3 + customConnections.length})` },
            { id: "alerts", label: `Uyarılar (${report?.alerts.length ?? 0})` },
          ].map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() =>
                  setActiveTab(tab.id as "workers" | "videos" | "connections" | "alerts")
                }
                style={{
                  padding: "10px 16px",
                  fontSize: "14px",
                  fontWeight: active ? 700 : 500,
                  color: active ? "#0f172a" : "#64748b",
                  backgroundColor: "transparent",
                  border: "none",
                  borderBottom: active ? "2px solid #0f172a" : "2px solid transparent",
                  cursor: "pointer",
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {loading && !report && (
          <div
            style={{
              backgroundColor: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "10px",
              padding: "24px",
              fontSize: "14px",
              color: "#64748b",
            }}
          >
            Yükleniyor…
          </div>
        )}

        {error && (
          <div
            style={{
              backgroundColor: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: "10px",
              padding: "16px",
              fontSize: "14px",
              color: "#b91c1c",
              marginBottom: "16px",
            }}
          >
            {error}
          </div>
        )}

        {/* 1. SEKME: İŞÇİLER */}
        {report && activeTab === "workers" && (
          <div
            style={{
              backgroundColor: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "10px",
              overflow: "hidden",
            }}
          >
            {report.workers.map((w, idx) => {
              const stale = isWorkerTimestampStale(w.updated_at);
              return (
                <div
                  key={w.id}
                  style={{
                    padding: "16px 18px",
                    borderBottom:
                      idx < report.workers.length - 1 ? "1px solid #f1f5f9" : "none",
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: "8px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>
                        {w.name}
                      </span>
                      <span style={{ fontSize: "13px", color: "#64748b" }}>— {w.role}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "12px", color: "#334155", fontWeight: 500 }}>
                        Son güncelleme: <strong>{w.updated_at}</strong>
                        {(w.id === "uploader" || w.id === "telegram") && (
                          <> · Telegram&apos;a son bildirim: <strong>{w.telegram_last || lastTelegramTime}</strong></>
                        )}
                      </span>
                      {statusBadge(w.status, stale)}
                    </div>
                  </div>
                  <div style={{ fontSize: "13px", color: "#334155", lineHeight: 1.5 }}>
                    {w.last_action}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 2. SEKME: VİDEOLAR (SADE BAŞLIK + TIKLAYINCA TAM METİN) */}
        {report && activeTab === "videos" && (
          <div
            style={{
              backgroundColor: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "10px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid #e2e8f0",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
                flexWrap: "wrap",
              }}
            >
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Video adı veya dosya ara (örn. video_33)…"
                style={{
                  flex: "1 1 260px",
                  padding: "8px 12px",
                  fontSize: "13px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  outline: "none",
                }}
              />
              <span style={{ fontSize: "12px", color: "#64748b" }}>
                💡 Tam başlığı ve etiketleri görmek için video satırına dokunun.
              </span>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "13px",
                  textAlign: "left",
                }}
              >
                <thead>
                  <tr
                    style={{
                      backgroundColor: "#f8fafc",
                      borderBottom: "1px solid #e2e8f0",
                      color: "#475569",
                    }}
                  >
                    <th style={{ padding: "10px 14px", fontWeight: 600 }}>Video (Kısa Başlık)</th>
                    <th style={{ padding: "10px 14px", fontWeight: 600 }}>Durum</th>
                    <th style={{ padding: "10px 14px", fontWeight: 600 }}>Tarih</th>
                    <th style={{ padding: "10px 14px", fontWeight: 600, textAlign: "right" }}>
                      İzlenme
                    </th>
                    <th style={{ padding: "10px 14px", fontWeight: 600, textAlign: "right" }}>
                      Yorum
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredVideos.map((v) => {
                    const { shortTitle, fullClean, hashtags } = getShortCleanTitle(v.title);
                    const isExpanded = expandedVideoNo === v.no;
                    return (
                      <React.Fragment key={v.no}>
                        <tr
                          onClick={() => setExpandedVideoNo(isExpanded ? null : v.no)}
                          style={{
                            borderBottom: isExpanded ? "none" : "1px solid #f1f5f9",
                            cursor: "pointer",
                            backgroundColor: isExpanded ? "#f8fafc" : "#ffffff",
                          }}
                        >
                          <td style={{ padding: "12px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <span style={{ fontSize: "11px", color: "#64748b" }}>
                                {isExpanded ? "▾" : "▸"}
                              </span>
                              <div>
                                <span style={{ fontWeight: 600, color: "#0f172a" }}>
                                  {shortTitle}
                                </span>
                                <span
                                  style={{
                                    marginLeft: "8px",
                                    fontSize: "11px",
                                    color: "#64748b",
                                    backgroundColor: "#f1f5f9",
                                    padding: "2px 6px",
                                    borderRadius: "4px",
                                  }}
                                >
                                  {v.file}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: "12px 14px" }}>{statusBadge(v.status)}</td>
                          <td style={{ padding: "12px 14px", color: "#475569", whiteSpace: "nowrap" }}>
                            {v.published_at}
                          </td>
                          <td
                            style={{
                              padding: "12px 14px",
                              textAlign: "right",
                              fontWeight: 600,
                            }}
                          >
                            {v.views.toLocaleString("tr-TR")}
                          </td>
                          <td style={{ padding: "12px 14px", textAlign: "right", color: "#475569" }}>
                            {v.comments}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr
                            style={{
                              backgroundColor: "#f8fafc",
                              borderBottom: "1px solid #e2e8f0",
                            }}
                          >
                            <td colSpan={5} style={{ padding: "10px 18px 14px 34px" }}>
                              <div style={{ fontSize: "13px", color: "#0f172a", fontWeight: 600, marginBottom: "4px" }}>
                                Tam Başlık: <span style={{ fontWeight: 500 }}>{fullClean}</span>
                              </div>
                              {hashtags.length > 0 && (
                                <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "8px" }}>
                                  Etiketler: {hashtags.join(" ")}
                                </div>
                              )}
                              <div style={{ display: "flex", alignItems: "center", gap: "14px", fontSize: "12px" }}>
                                <a
                                  href={v.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  style={{
                                    color: "#2563eb",
                                    fontWeight: 600,
                                    textDecoration: "none",
                                  }}
                                >
                                  ▶️ YouTube&apos;da Aç ({v.url})
                                </a>
                                <span style={{ color: "#64748b" }}>
                                  Beğeni: <strong>{v.likes}</strong> · Yorum: <strong>{v.comments}</strong>
                                </span>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 3. SEKME: BAĞLANTILAR (YOUTUBE, TELEGRAM, DRIVE + TIKTOK/INSTAGRAM & MANUEL EKLEME ZEMİNİ) */}
        {activeTab === "connections" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div
              style={{
                backgroundColor: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "16px 18px",
              }}
            >
              <div style={{ fontSize: "15px", fontWeight: 700, marginBottom: "12px" }}>
                Aktif ve Hazır Platform Bağlantıları
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "12px",
                    border: "1px solid #f1f5f9",
                    borderRadius: "8px",
                    flexWrap: "wrap",
                    gap: "8px",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: "14px" }}>
                      YouTube Data API v3 — @bilgidozuofficial
                    </div>
                    <div style={{ fontSize: "12px", color: "#64748b" }}>
                      Otomatik video yükleme, özel kapak ve ilk sabit yorum (youtube.force-ssl)
                    </div>
                  </div>
                  {statusBadge("Çalışıyor")}
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "12px",
                    border: "1px solid #f1f5f9",
                    borderRadius: "8px",
                    flexWrap: "wrap",
                    gap: "8px",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: "14px" }}>
                      Telegram Bot — Asistan-Mira_bot
                    </div>
                    <div style={{ fontSize: "12px", color: "#64748b" }}>
                      Yükleme sonrası tek tıkla kopyalanabilir sabit yorum ve kalan stok bildirimi (Son: {lastTelegramTime})
                    </div>
                  </div>
                  {statusBadge("Çalışıyor")}
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "12px",
                    border: "1px solid #f1f5f9",
                    borderRadius: "8px",
                    flexWrap: "wrap",
                    gap: "8px",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: "14px" }}>
                      Google Drive & E-Tablo Stoku
                    </div>
                    <div style={{ fontSize: "12px", color: "#64748b" }}>
                      bilgidozu_yukleme_tablosu.xlsx · 57 Shorts ve 10 Uzun Video hazır
                    </div>
                  </div>
                  {statusBadge("Çalışıyor")}
                </div>

                {customConnections.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "12px",
                      border: "1px solid #f1f5f9",
                      borderRadius: "8px",
                      flexWrap: "wrap",
                      gap: "8px",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700, fontSize: "14px" }}>
                        {c.platform} — {c.account}
                      </div>
                      <div style={{ fontSize: "12px", color: "#64748b" }}>
                        {c.endpoint} · Eklenme: {c.addedAt}
                      </div>
                    </div>
                    {statusBadge(c.status)}
                  </div>
                ))}
              </div>
            </div>

            {/* MANUEL BAĞLANTI EKLEME FORMU */}
            <form
              onSubmit={handleAddConnection}
              style={{
                backgroundColor: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "16px 18px",
              }}
            >
              <div style={{ fontSize: "15px", fontWeight: 700, marginBottom: "4px" }}>
                + Yeni Kanal / Manuel Bağlantı Ekle
              </div>
              <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "14px" }}>
                TikTok, Instagram Reels veya özel Webhook bağlantı bilgilerini buradan sisteme tanımlayabilirsiniz.
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: "10px",
                  marginBottom: "12px",
                }}
              >
                <select
                  value={newPlatform}
                  onChange={(e) => setNewPlatform(e.target.value)}
                  style={{
                    padding: "9px 12px",
                    fontSize: "13px",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    backgroundColor: "#ffffff",
                  }}
                >
                  <option value="TikTok">TikTok</option>
                  <option value="Instagram Reels">Instagram Reels</option>
                  <option value="YouTube Yedek Kanal">YouTube Yedek Kanal</option>
                  <option value="Özel Webhook / API">Özel Webhook / API</option>
                </select>
                <input
                  type="text"
                  value={newAccount}
                  onChange={(e) => setNewAccount(e.target.value)}
                  placeholder="Hesap adı (örn. @bilgidozuofficial)"
                  style={{
                    padding: "9px 12px",
                    fontSize: "13px",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                  }}
                />
                <input
                  type="text"
                  value={newEndpoint}
                  onChange={(e) => setNewEndpoint(e.target.value)}
                  placeholder="API Anahtarı / Webhook URL / Not"
                  style={{
                    padding: "9px 12px",
                    fontSize: "13px",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                  }}
                />
              </div>
              <button
                type="submit"
                style={{
                  padding: "8px 16px",
                  fontSize: "13px",
                  fontWeight: 700,
                  borderRadius: "8px",
                  border: "none",
                  backgroundColor: "#0f172a",
                  color: "#ffffff",
                  cursor: "pointer",
                }}
              >
                Bağlantıyı Kaydet
              </button>
            </form>
          </div>
        )}

        {/* 4. SEKME: UYARILAR */}
        {report && activeTab === "alerts" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {report.alerts.map((a) => (
              <div
                key={a.id}
                style={{
                  backgroundColor: "#ffffff",
                  border: "1px solid #e2e8f0",
                  borderRadius: "10px",
                  padding: "16px 18px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                    marginBottom: "6px",
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: "14px" }}>{a.title}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "12px", color: "#64748b" }}>{a.time}</span>
                    {statusBadge(a.level)}
                  </div>
                </div>
                <div style={{ fontSize: "13px", color: "#334155", marginBottom: "6px" }}>
                  {a.detail}
                </div>
                <div style={{ fontSize: "12px", color: "#0f172a", fontWeight: 600 }}>
                  Öneri: {a.action}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
