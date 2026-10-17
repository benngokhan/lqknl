import { isMiraSessionCookie } from "@/lib/mira-auth";
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contentAssets } from "@/db/schema";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  // Önizleme: site giriş çerezi (review arayüzü) veya otomasyon anahtarı
  const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (secret && req.headers.get("x-mira-key") === secret) return true;
  return isMiraSessionCookie(req.headers.get("cookie"));
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const { id } = await params;
  const n = Number(id);
  const url = new URL(req.url);
  const contentParam = Number(url.searchParams.get("content"));

  let rows;
  if (Number.isInteger(n) && n > 0) {
    rows = await db.select().from(contentAssets).where(eq(contentAssets.id, n)).limit(1);
  } else if (Number.isInteger(contentParam) && contentParam > 0) {
    // ?content=ID → o içeriğin en yeni videosu (onay arayüzü için)
    rows = await db.select().from(contentAssets)
      .where(eq(contentAssets.contentId, contentParam))
      .orderBy(desc(contentAssets.id)).limit(1);
  } else {
    return NextResponse.json({ error: "Geçersiz istek" }, { status: 400 });
  }

  const asset = rows[0];
  if (!asset) return new NextResponse("Bulunamadı", { status: 404 });

  const bytes = Buffer.from(asset.data, "base64");
  if (!bytes.length) return new NextResponse("Varlık boş", { status: 502 });

  return new NextResponse(bytes as BodyInit, {
    headers: {
      "Content-Type": asset.mime,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=60",
      "X-Mira-Asset-Id": String(asset.id),
      "X-Mira-Content-Id": String(asset.contentId),
    },
  });
}
