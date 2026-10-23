import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch(
      "https://raw.githubusercontent.com/benngokhan/yt_auto_uploader/main/status_report.json",
      { cache: "no-store", signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) {
      throw new Error(`status_report.json okunamadı (HTTP ${res.status})`);
    }
    const data = await res.json();
    return NextResponse.json({ ok: true, report: data });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Durum verisi alınamadı",
      },
      { status: 502 }
    );
  }
}
