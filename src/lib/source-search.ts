/**
 * src/lib/source-search.ts — BİLGİ DOZU akademik kaynak keşfisi (keysiz/free 3 motor)
 *
 * DuckDuckGo HTML kazımasının boşa gittiği ana boğumu çözer: taslak seslendirmesindeki
 * iddianın karşılığını YAPISAL akademik indekslerden (OpenAlex, Crossref, PubMed) bulur.
 * Üçü de API anahtarı istemez (open/free); hata durumunda hiçbir şey kırılmaz, arayana
 * boş liste döner ve eski DDG yedeği katman olarak çalışmaya devam eder.
 *
 * Sözleşme: Dönen URL'ler worker tarafındaki isTrustedSourceUrl(listesinde sayılır —
 * sayfa-final doğrulaması ve iddia-karşılaştırması olduğu için bu modül filtrelemez;
 * sadece aday havuzu üretir.
 */

export interface AcademicSearchResult {
  urls: string[];
  engines: { openalex: number; crossref: number; pubmed: number };
  errors: string[];
}

const UA = "MiraFactCheck/1.1 (bilgi-dozu; contact: railway-app)";

function uniq(urls: string[]): string[] {
  return [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
}

async function fetchJson(url: string, timeoutMs = 9000): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": UA, Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** OpenAlex works search → DOI (tercih) veya openalex kayıt URL'si. */
async function searchOpenAlex(query: string, cap: number): Promise<string[]> {
  const u = new URL("https://api.openalex.org/works");
  u.searchParams.set("search", query.slice(0, 220));
  u.searchParams.set("per-page", String(Math.min(cap, 4)));
  u.searchParams.set("select", "doi,id,title");
  const data = await fetchJson(u.toString()) as { results?: Array<{ doi?: string; id?: string }> };
  const out: string[] = [];
  for (const r of data.results ?? []) {
    if (typeof r.doi === "string" && r.doi.startsWith("https://doi.org/")) out.push(r.doi);
    else if (typeof r.id === "string") out.push(r.id);
  }
  return out;
}

/** Crossref works search → https://doi.org/<doi> */
async function searchCrossref(query: string, cap: number): Promise<string[]> {
  const u = new URL("https://api.crossref.org/works");
  u.searchParams.set("query", query.slice(0, 220));
  u.searchParams.set("rows", String(Math.min(cap, 4)));
  u.searchParams.set("select", "DOI,title");
  const data = await fetchJson(u.toString()) as { message?: { items?: Array<{ DOI?: string }> } };
  const out: string[] = [];
  for (const r of data.message?.items ?? []) {
    if (r.DOI) out.push(`https://doi.org/${r.DOI.trim()}`);
  }
  return out;
}

/** PubMed esearch → https://pubmed.ncbi.nlm.nih.gov/<pmid>/ */
async function searchPubMed(query: string, cap: number): Promise<string[]> {
  const u = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
  u.searchParams.set("db", "pubmed");
  u.searchParams.set("retmode", "json");
  u.searchParams.set("retmax", String(Math.min(cap, 3)));
  u.searchParams.set("term", query.slice(0, 200));
  const data = await fetchJson(u.toString()) as { esearchresult?: { idlist?: string[] } };
  return (data.esearchresult?.idlist ?? []).map((pmid) => `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`);
}

/**
 * Akademik kaynak adayı bul: üç motoru paralel koştur, indirimde sessiz düş.
 * Tam eşsoru q1 boş ise topic-only q2 ile bir tur daha dene (Türkçe uzun kuyruklar
 * akademik indekslerde 0 vurur; konu kelimeleriyle ikinci şans).
 */
export async function searchAcademicSources(topic: string, narration: string, cap = 5): Promise<AcademicSearchResult> {
  const qTerms = `${topic} ${narration}`.replace(/\s+/g, " ").slice(0, 180).trim();
  const engines = { openalex: 0, crossref: 0, pubmed: 0 };
  const errors: string[] = [];
  let urls: string[] = [];

  async function round(query: string): Promise<void> {
    const [a, c, p] = await Promise.allSettled([
      searchOpenAlex(query, 3),
      searchCrossref(query, 3),
      searchPubMed(query, 2),
    ]);
    if (a.status === "fulfilled") { engines.openalex += a.value.length; urls.push(...a.value); } else errors.push(`openalex: ${a.reason instanceof Error ? a.reason.message.slice(0, 90) : a.reason}`);
    if (c.status === "fulfilled") { engines.crossref += c.value.length; urls.push(...c.value); } else errors.push(`crossref: ${c.reason instanceof Error ? c.reason.message.slice(0, 90) : c.reason}`);
    if (p.status === "fulfilled") { engines.pubmed += p.value.length; urls.push(...p.value); } else errors.push(`pubmed: ${p.reason instanceof Error ? p.reason.message.slice(0, 90) : p.reason}`);
  }

  await round(qTerms);
  urls = uniq(urls);
  if (urls.length === 0 && topic.trim().length > 3 && topic.trim() !== qTerms) {
    await round(topic.trim().slice(0, 120));
    urls = uniq(urls);
  }
  return { urls: urls.slice(0, cap), engines, errors };
}
