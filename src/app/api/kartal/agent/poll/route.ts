import { NextResponse } from "next/server";
import { noteHeartbeat, tabletTokenOk, claimNextCommand } from "@/lib/kartal-agent";

export const dynamic = "force-dynamic";

/**
 * GET /api/kartal/agent/poll?token=…  — tablet 5 sn'de bir çağırır.
 * Sırada komut varsa onu CALISIYOR yapar ve döndürür; yoksa { idle: true }.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const token = q.get("token") || req.headers.get("x-kartal-token") || "";
  if (!tabletTokenOk(token)) return NextResponse.json({ error: "Yetkisiz tablet" }, { status: 401 });

  const hb = await noteHeartbeat();
  const cmd = await claimNextCommand();
  if (!cmd) return NextResponse.json({ idle: true, online: hb.online });

  return NextResponse.json({
    idle: false,
    id: cmd.id,
    komut: cmd.title,
    created_at: cmd.createdAt.toISOString(),
  });
}
