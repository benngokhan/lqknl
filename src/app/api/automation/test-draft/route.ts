import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json({
    ok: false,
    error: "Test taslağı uç noktası kapatıldı. Yeni içerik üretmek için Taslaklar kuyruğundaki seçili başlığı kullanın.",
  }, { status: 410 });
}
