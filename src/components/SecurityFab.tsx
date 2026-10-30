"use client";
import { useState } from "react";
import { usePathname } from "next/navigation";

// Navigation recreates the panel, clearing both its message and password fields.
export default function SecurityFab() {
  const pathname = usePathname();
  if (pathname === "/login") return null;
  return <SecurityFabPanel key={pathname} />;
}

// Sağ altta kilit düğmesi: şifre değiştir + oturumu kapat.
function SecurityFabPanel() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function changePw(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setMsg({ ok: false, text: "Yeni şifreler aynı değil." });
      return;
    }
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current, next, confirm }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !data.ok) {
      setMsg({ ok: false, text: data.error || "Değiştirilemedi" });
      return;
    }
    setMsg({ ok: true, text: "Şifre güncellendi. Oturumun devam ediyor." });
    setCurrent("");
    setNext("");
    setConfirm("");
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.replace("/login");
  }

  const input =
    "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-amber-400/60";

  return (
    <>
      <button
        onClick={() => {
          setMsg(null);
          setOpen((v) => !v);
        }}
        title="Güvenlik (şifre / çıkış)"
        className="fixed bottom-4 right-4 z-50 flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-[#161028]/90 text-lg shadow-lg backdrop-blur transition hover:bg-[#221842]"
      >
        🔒
      </button>
      {open && (
        <div className="fixed bottom-16 right-4 z-50 w-80 rounded-2xl border border-white/10 bg-[#120c22] p-5 shadow-2xl">
          <h3 className="text-sm font-bold text-white">Güvenlik</h3>
          {msg && (
            <p className={`mt-2 text-xs ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</p>
          )}
          <form onSubmit={changePw} className="mt-3 space-y-2">
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Mevcut şifre" className={input} />
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="Yeni şifre (en az 4)" className={input} />
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Yeni şifre (tekrar)" className={input} />
            <button
              type="submit"
              disabled={busy || !current || !next}
              className="w-full rounded-lg bg-amber-400 py-2 text-sm font-semibold text-black transition hover:bg-amber-300 disabled:opacity-40"
            >
              {busy ? "Kaydediliyor…" : "Şifreyi Değiştir"}
            </button>
          </form>
          <button
            onClick={logout}
            className="mt-3 w-full rounded-lg border border-white/10 py-2 text-sm text-white/70 transition hover:bg-white/5"
          >
            Oturumu Kapat
          </button>
        </div>
      )}
    </>
  );
}
