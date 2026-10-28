import { NextResponse } from "next/server";
import { db } from "@/db";
import { operations, tasks } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { AG, AGENT_SOURCE, noteHeartbeat, tabletTokenOk } from "@/lib/kartal-agent";

export const dynamic = "force-dynamic";

/**
 * POST /api/kartal/agent/result  — tablet komutu bitirince raporlar.
 * Body: { id: number, ok: boolean, sonuc?: string, hata?: string }
 */
export async function POST(req: Request) {
  const token = req.headers.get("x-kartal-token") || "";
  if (!tabletTokenOk(token)) return NextResponse.json({ error: "Yetkisiz tablet" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const id = Number(b.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "id gerekli" }, { status: 400 });

  const ok = b.ok !== false;
  const sonuc = typeof b.sonuc === "string" ? b.sonuc.slice(0, 500) : "";
  const hata = typeof b.hata === "string" ? b.hata.slice(0, 500) : "";
  const status = ok ? AG.BITTI : AG.HATA;
  const notes = JSON.stringify({ sonuc: sonuc || null, hata: ok ? null : hata || null });

  const upd = await db
    .update(tasks)
    .set({ status, notes, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), eq(tasks.source, AGENT_SOURCE), eq(tasks.status, AG.CALISIYOR)))
    .returning();

  await noteHeartbeat();
  if (!upd[0]) return NextResponse.json({ error: "Komut bulunamadı veya zaten sonuçlanmış" }, { status: 409 });

  await db
    .insert(operations)
    .values({
      action: "agent_command_result",
      status: ok ? "success" : "error",
      summary: ok ? `KartaL komutu tamamlandı: ${upd[0].title.slice(0, 100)}` : `KartaL komutu hata: ${upd[0].title.slice(0, 100)}`,
      metadata: { taskId: id, ok, sonuc: sonuc || null, hata: hata || null },
    })
    .catch(() => {});

  return NextResponse.json({ ok: true, id });
}
