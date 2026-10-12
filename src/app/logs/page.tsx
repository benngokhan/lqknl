"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type LogRow = {
  id: number;
  at: string;
  level: string;
  source: string;
  message: string;
  meta: Record<string, unknown>;
};

const LEVEL_META: Record<string, { label: string; color: string; icon: string }> = {
  error: { label: "Hata", color: "#f85149", icon: "❌" },
  warn: { label: "Uyarı", color: "#d29922", icon: "⚠️" },
  success: { label: "Başarı", color: "#3fb950", icon: "✅" },
  info: { label: "Bilgi", color: "#58a6ff", icon: "ℹ️" },
};

const POLL_MS = 4000;

export default function LogsPage() {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [contentId, setContentId] = useState<string>("");
  const [running, setRunning] = useState<boolean>(true);
  const [unauthorized, setUnauthorized] = useState<boolean>(false);
  const [lastFetch, setLastFetch] = useState<string>("");
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set());
  const knownTop = useRef<number>(0);

  const pull = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "120" });
      if (filter) params.set("level", filter);
      if (contentId.trim()) params.set("contentId", contentId.trim());
      const res = await fetch(`/api/automation/logs?${params.toString()}`, { cache: "no-store" });
      if (res.status === 401) { setUnauthorized(true); return; }
      if (!res.ok) return;
      const data = await res.json();
      const rows: LogRow[] = data.logs ?? [];
      const newOnes = knownTop.current
        ? rows.filter((r) => r.id > knownTop.current).map((r) => r.id)
        : [];
      if (rows.length > 0) knownTop.current = Math.max(knownTop.current, ...rows.map((r) => r.id));
      setLogs(rows);
      setFreshIds(new Set(newOnes));
      setLastFetch(new Date().toLocaleTimeString("tr-TR"));
    } catch {
      // ağ hatası: sonraki tur tekrar dener, ekranı bozma
    }
  }, [filter, contentId]);

  useEffect(() => {
    void pull();
  }, [pull]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void pull(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, pull]);

  useEffect(() => {
    if (freshIds.size === 0) return;
    const timer = setTimeout(() => setFreshIds(new Set()), 3500);
    return () => clearTimeout(timer);
  }, [freshIds]);

  if (unauthorized) {
    return (
      <main style={pageStyle}>
        <div style={cardStyle}>
          <h1 style={{ marginTop: 0 }}>🔒 Giriş gerekli</h1>
          <p style={{ lineHeight: 1.6 }}>
            Log ekranını görmek için önce panele giriş yapmalısın.{" "}
            <a href="/" style={{ color: "#58a6ff" }}>Panele git →</a>
          </p>
        </div>
      </main>
    );
  }

  const counts: Record<string, number> = {};
  for (const row of logs) counts[row.level] = (counts[row.level] ?? 0) + 1;

  return (
    <main style={pageStyle}>
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>📜 MİRA · Canlı Log Akışı</h1>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>son çekim: {lastFetch || "—"}</span>
            <button onClick={() => setRunning((v) => !v)} style={btnStyle}>
              {running ? "⏸ Duraklat" : "▶ Devam"}
            </button>
            <a href="/api/automation/logs?limit=200" target="_blank" rel="noreferrer" style={{ ...btnStyle, textDecoration: "none" }}>
              ⬇ JSON
            </a>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, margin: "14px 0", flexWrap: "wrap" }}>
          <button onClick={() => setFilter("")} style={{ ...chipStyle, ...(filter === "" ? chipActive : {}) }}>
            Tümü ({logs.length})
          </button>
          {Object.entries(LEVEL_META).map(([key, meta]) => (
            <button key={key} onClick={() => setFilter(key)} style={{ ...chipStyle, color: meta.color, ...(filter === key ? chipActive : {}) }}>
              {meta.icon} {meta.label} ({counts[key] ?? 0})
            </button>
          ))}
          <input
            value={contentId}
            onChange={(e) => setContentId(e.target.value)}
            placeholder="İçerik # filtrele (ör. 67)"
            style={{ ...chipStyle, minWidth: 190, color: "#c9d1d9" }}
          />
        </div>

        {logs.length === 0 && (
          <div style={cardStyle}>
            <p style={{ margin: 0, opacity: 0.8 }}>Henüz kayıt yok. Mira bir hata/olay ürettiğinde buraya düşecek — ekran her {POLL_MS / 1000} sn kendini yeniler.</p>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {logs.map((row) => {
            const meta = LEVEL_META[row.level] ?? LEVEL_META.info;
            const isFresh = freshIds.has(row.id);
            return (
              <div key={row.id} style={{ ...rowStyle, borderLeft: `3px solid ${meta.color}`, background: isFresh ? "#161b22" : "#0d1117", boxShadow: isFresh ? `0 0 0 1px ${meta.color}55` : "none" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ color: meta.color, fontWeight: 700, fontSize: 12 }}>{meta.icon} {meta.label.toUpperCase()}</span>
                  <span style={{ fontSize: 12, color: "#8b949e" }}>{new Date(row.at).toLocaleString("tr-TR")}</span>
                  <span style={{ fontSize: 11, color: "#58a6ff", background: "#1f6feb22", padding: "1px 8px", borderRadius: 10 }}>{row.source}</span>
                  {typeof row.meta?.contentId === "number" && (
                    <span style={{ fontSize: 11, color: "#d29922" }}>#{String(row.meta.contentId)}</span>
                  )}
                </div>
                <div style={{ marginTop: 4, fontSize: 14, lineHeight: 1.5, wordBreak: "break-word" }}>{row.message}</div>
                {Array.isArray(row.meta?.sourceUrls) && (row.meta.sourceUrls as unknown[]).length > 0 && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "#8b949e" }}>
                    {(row.meta.sourceUrls as string[]).map((u, i) => (
                      <div key={i} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🔗 {u}</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p style={{ fontSize: 11, opacity: 0.5, marginTop: 18 }}>
          Kayıtlar <code>operations</code> tablosunda tutulur (action = mira_log) — Railway restart&apos;ında kaybolmaz. Aynı satırlar
          Railway&apos;nin kendi log panelesine de düşer.
        </p>
      </div>
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "#010409",
  color: "#c9d1d9",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  padding: "24px 16px",
};

const cardStyle: React.CSSProperties = {
  background: "#0d1117",
  border: "1px solid #21262d",
  borderRadius: 10,
  padding: 16,
  maxWidth: 560,
  margin: "40px auto",
};

const btnStyle: React.CSSProperties = {
  background: "#21262d",
  color: "#c9d1d9",
  border: "1px solid #30363d",
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 13,
  cursor: "pointer",
  display: "inline-block",
};

const chipStyle: React.CSSProperties = {
  background: "#161b22",
  border: "1px solid #30363d",
  borderRadius: 14,
  padding: "4px 12px",
  fontSize: 12,
  cursor: "pointer",
  color: "#c9d1d9",
};

const chipActive: React.CSSProperties = {
  border: "1px solid #58a6ff",
  background: "#1f6feb26",
};

const rowStyle: React.CSSProperties = {
  borderRadius: 8,
  padding: "10px 14px",
  border: "1px solid #21262d",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  transition: "background .4s ease",
};
