import { NextResponse } from "next/server";
import { changePanelPassword, verifyPanelPassword } from "@/lib/panel-auth";

export const runtime = "nodejs";

// Panel içi şifre değiştirme: mevcut şifre doğrulanır, yeni hash DB'ye yazılır (kalıcı).
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({})) as Record<string, unknown>;
  const current = typeof b.current === "string" ? b.current : "";
  const next = typeof b.next === "string" ? b.next : "";
  if (!current || !next) {
    return NextResponse.json({ ok: false, error: "Mevcut ve yeni şifre gerekli" }, { status: 400 });
  }
  if (!(await verifyPanelPassword(current))) {
    return NextResponse.json({ ok: false, error: "Mevcut şifre yanlış" }, { status: 401 });
  }
  try {
    await changePanelPassword(next);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Şifre kaydedilemedi" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
