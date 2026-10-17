import { isMiraSessionCookie } from "@/lib/mira-auth";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;


type PixabayHit = {
  id: number;
  pageURL: string;
  webformatURL: string;
  largeImageURL?: string;
  tags?: string;
};

export async function POST(req: Request) {
  try {
    const cookies = req.headers.get("cookie") ?? "";
    if (!isMiraSessionCookie(cookies)) {
      return NextResponse.json({ error: "Önce Mira'ya giriş yapmalısın." }, { status: 401 });
    }

    const apiKey = process.env.PIXABAY_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json({ error: "Pixabay anahtarı Railway'de bulunamadı. PIXABAY_API_KEY değişkenini kontrol et." }, { status: 503 });
    }

    const body = await req.json().catch(() => ({})) as { query?: unknown };
    const requestedQuery = typeof body.query === "string" ? body.query : "";
    // Keep searches focused on the intended photo-search feature.
    const query = requestedQuery.trim().slice(0, 100) || "body selfie sensual girl";
    const params = new URLSearchParams({
      key: apiKey,
      q: query,
      image_type: "photo",
      orientation: "vertical",
      safesearch: "true",
      order: "popular",
      per_page: "20",
      lang: "en",
    });

    const response = await fetch(`https://pixabay.com/api/?${params.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      console.error("Pixabay API request failed", { status: response.status });
      return NextResponse.json({ error: `Pixabay fotoğraf araması başarısız oldu (HTTP ${response.status}). API anahtarını ve Pixabay erişimini kontrol et.` }, { status: 502 });
    }

    const data = await response.json() as { hits?: PixabayHit[]; totalHits?: number };
    const hits = Array.isArray(data.hits)
      ? data.hits.filter((hit) => typeof hit.webformatURL === "string" && /^https:\/\//i.test(hit.webformatURL) && typeof hit.pageURL === "string")
      : [];

    if (!hits.length) {
      return NextResponse.json({ error: "Pixabay bu aramayla fotoğraf bulamadı. Daha genel bir arama terimi deneyebilirsin." }, { status: 404 });
    }

    // Rank results by how closely their Pixabay tags match the requested style.
    // Keep a small random choice among the strongest matches so results do not feel fixed.
    const queryTerms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 2 && !["the", "and", "with", "body"].includes(term));
    const styleTerms = ["selfie", "woman", "girl", "portrait", "fashion", "outfit", "mirror", "pose", "bedroom", "model"];
    const ranked = hits
      .map((hit) => {
        const tags = (hit.tags ?? "").toLowerCase();
        const tagWords = new Set(tags.split(/[^a-z0-9]+/).filter(Boolean));
        const queryScore = queryTerms.reduce((score, term) => score + (tagWords.has(term) ? 3 : 0), 0);
        const styleScore = styleTerms.reduce((score, term) => score + (tagWords.has(term) ? 1 : 0), 0);
        return { hit, score: queryScore + styleScore };
      })
      .sort((a, b) => b.score - a.score);

    const bestScore = ranked[0]?.score ?? 0;
    const bestMatches = ranked.filter((item) => item.score === bestScore).slice(0, 5);
    const chosen = bestMatches[Math.floor(Math.random() * bestMatches.length)]?.hit ?? hits[0];

    return NextResponse.json({
      reply: "Al canım, iyi mi?",
      imageUrl: chosen.webformatURL,
      sourceUrl: chosen.pageURL,
      tags: chosen.tags ?? "",
      totalHits: typeof data.totalHits === "number" ? data.totalHits : hits.length,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("Pixabay photo search failed:", reason);
    return NextResponse.json({ error: "Pixabay fotoğraf araması tamamlanamadı. Biraz sonra tekrar dene." }, { status: 502 });
  }
}
