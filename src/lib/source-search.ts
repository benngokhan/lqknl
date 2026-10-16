/**
 * Mira source discovery — search academic indexes, reject off-topic results,
 * and retry with cleaner queries when search returns URLs that are not relevant.
 */

export interface AcademicSearchResult {
  urls: string[];
  engines: { openalex: number; crossref: number; pubmed: number };
  errors: string[];
}

type Candidate = {
  url: string;
  title: string;
  abstract?: string;
};

const UA = "MiraFactCheck/1.2 (bilgi-dozu; contact: railway-app)";
const STOP_WORDS = new Set((
  "about after again against all also and any are because been before being between both but " +
  "can could did do does doing down during each few for from further had has have having he her " +
  "here hers herself him himself his how i if in into is it its itself just me more most my myself " +
  "no nor not of off on once only or other our ours ourselves out over own same she should so some " +
  "such than that the their theirs them themselves then there these they this those through to too " +
  "under until up very was we were what when where which while who whom why will with would you your " +
  "a an the and or as at by be per via using based study studies effect effects role new review " +
  "bir bu şu ve veya ile için gibi göre daha en çok neden nasıl ne mi mı mu mü olan olarak da de " +
  "ki ama çünkü fakat ise gibi kadar sonra önce üzerinde hakkında araştırma çalışma etkisi etkileri " +
  "nedir nedenleri nasıl olur olur mu birinci ikinci"
).split(/\s+/));

function uniq<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item).trim().toLowerCase();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
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

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function reconstructOpenAlexAbstract(index: unknown): string {
  if (!index || typeof index !== "object") return "";
  const positions: Array<[number, string]> = [];
  for (const [word, offsets] of Object.entries(index as Record<string, unknown>)) {
    if (!Array.isArray(offsets)) continue;
    for (const offset of offsets) {
      if (typeof offset === "number") positions.push([offset, word]);
    }
  }
  return positions.sort((a, b) => a[0] - b[0]).map((item) => item[1]).join(" ");
}

function tokens(value: string): string[] {
  return [...new Set(
    value.toLocaleLowerCase("tr-TR")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ı/g, "i")
      .match(/[\p{L}\p{N}]+/gu)?.filter((word) =>
        word.length >= 3 && !STOP_WORDS.has(word) && !/^\d+$/.test(word)
      ) ?? []
  )];
}

const TOPIC_ALIASES: Array<[RegExp, string]> = [
  [/kara\s*delik(?:ler|lerin|lere|lerde|lerden)?/gi, "black hole"],
  [/olay\s*ufku/gi, "event horizon"],
  [/kuantum\s*dolanıklık/gi, "quantum entanglement"],
  [/kuantum\s*ışınlama/gi, "quantum teleportation"],
  [/hipnik\s*jerk/gi, "hypnic jerk"],
  [/kas\s*atonisi/gi, "muscle atonia"],
  [/uyku\s*felci/gi, "sleep paralysis"],
  [/rem\s*uykusu/gi, "REM sleep"],
  [/güneş\s*kütlesi/gi, "solar mass"],
];

function expandTopicAliases(topic: string): string {
  const aliases: string[] = [];
  for (const [pattern, alias] of TOPIC_ALIASES) {
    if (topic.replace(pattern, alias) !== topic) aliases.push(alias);
  }
  return [topic, ...aliases].join(" ");
}

function topicTerms(topic: string): string[] {
  return tokens(expandTopicAliases(topic.replace(/https?:\/\/\S+/gi, " ").slice(0, 240)));
}

function candidateRelevance(candidate: Candidate, topic: string, narration: string): number {
  const topicWords = topicTerms(topic);
  if (!topicWords.length) return 0;
  const titleWords = new Set(tokens(candidate.title));
  const allWords = new Set(tokens(`${candidate.title} ${candidate.abstract ?? ""}`));
  const topicHits = topicWords.filter((word) => allWords.has(word)).length;
  const titleHits = topicWords.filter((word) => titleWords.has(word)).length;
  const narrationWords = tokens(narration.slice(0, 1200));
  const narrationHits = narrationWords.filter((word) => allWords.has(word)).length;

  // Topic match is mandatory. A narration-only overlap can be accidental noise.
  const requiredTopicHits = Math.min(2, topicWords.length);
  if (topicHits < requiredTopicHits) return 0;
  return topicHits * 4 + titleHits * 2 + Math.min(narrationHits, 4);
}

/** OpenAlex works search with title and reconstructed abstract for relevance checks. */
async function searchOpenAlex(query: string, cap: number): Promise<Candidate[]> {
  const u = new URL("https://api.openalex.org/works");
  u.searchParams.set("search", query.slice(0, 220));
  u.searchParams.set("per-page", String(Math.min(cap, 5)));
  u.searchParams.set("select", "doi,id,title,abstract_inverted_index");
  const data = await fetchJson(u.toString()) as {
    results?: Array<{ doi?: string; id?: string; title?: string; abstract_inverted_index?: unknown }>;
  };
  return (data.results ?? []).flatMap((record) => {
    const url = typeof record.doi === "string" && record.doi.startsWith("https://doi.org/")
      ? record.doi
      : typeof record.id === "string" ? record.id : "";
    if (!url || !record.title) return [];
    return [{
      url,
      title: cleanText(record.title),
      abstract: reconstructOpenAlexAbstract(record.abstract_inverted_index),
    }];
  });
}

/** Crossref metadata includes titles and abstracts when the publisher deposited them. */
async function searchCrossref(query: string, cap: number): Promise<Candidate[]> {
  const u = new URL("https://api.crossref.org/works");
  u.searchParams.set("query.bibliographic", query.slice(0, 220));
  u.searchParams.set("rows", String(Math.min(cap, 5)));
  u.searchParams.set("select", "DOI,title,abstract");
  const data = await fetchJson(u.toString()) as {
    message?: { items?: Array<{ DOI?: string; title?: string[]; abstract?: string }> };
  };
  return (data.message?.items ?? []).flatMap((record) => {
    if (!record.DOI || !record.title?.[0]) return [];
    return [{
      url: `https://doi.org/${record.DOI.trim()}`,
      title: cleanText(record.title[0]),
      abstract: cleanText(record.abstract),
    }];
  });
}

/** PubMed search returns titles; PubMed's query syntax also narrows results by topic. */
async function searchPubMed(query: string, cap: number): Promise<Candidate[]> {
  const u = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
  u.searchParams.set("db", "pubmed");
  u.searchParams.set("retmode", "json");
  u.searchParams.set("retmax", String(Math.min(cap, 4)));
  u.searchParams.set("term", query.slice(0, 200));
  const data = await fetchJson(u.toString()) as { esearchresult?: { idlist?: string[] } };
  const ids = (data.esearchresult?.idlist ?? []).slice(0, cap);
  if (!ids.length) return [];

  const summaryUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
  summaryUrl.searchParams.set("db", "pubmed");
  summaryUrl.searchParams.set("retmode", "json");
  summaryUrl.searchParams.set("id", ids.join(","));
  const summary = await fetchJson(summaryUrl.toString()) as {
    result?: Record<string, { title?: string; uid?: string } | string[]>;
  };
  return ids.flatMap((id) => {
    const record = summary.result?.[id];
    if (!record || Array.isArray(record) || !record.title) return [];
    return [{
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      title: cleanText(record.title),
    }];
  });
}

function buildQueries(topic: string, narration: string): string[] {
  const cleanTopic = expandTopicAliases(topic.replace(/https?:\/\/\S+/gi, " ")).replace(/\s+/g, " ").trim().slice(0, 180);
  const firstSentence = narration
    .replace(/https?:\/\/\S+/gi, " ")
    .split(/[.!?؟\n]/)[0]
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) ?? "";
  const words = tokens(`${topic} ${narration.slice(0, 1400)}`);
  const keywordQuery = words.slice(0, 8).join(" ");
  return uniq(
    [cleanTopic, [cleanTopic, firstSentence].filter(Boolean).join(" "), keywordQuery]
      .map((query) => query.trim().slice(0, 220))
      .filter((query) => query.length >= 4),
    (query) => query.toLowerCase()
  );
}

/**
 * Search in progressively cleaner rounds. A non-empty URL list is not success:
 * each result must have a title/abstract matching the requested topic.
 */
export async function searchAcademicSources(topic: string, narration: string, cap = 5): Promise<AcademicSearchResult> {
  const engines = { openalex: 0, crossref: 0, pubmed: 0 };
  const errors: string[] = [];
  const allCandidates: Candidate[] = [];
  const queries = buildQueries(topic, narration);

  for (const query of queries) {
    const [openAlex, crossref, pubmed] = await Promise.allSettled([
      searchOpenAlex(query, 5),
      searchCrossref(query, 5),
      searchPubMed(query, 4),
    ]);

    if (openAlex.status === "fulfilled") {
      engines.openalex += openAlex.value.length;
      allCandidates.push(...openAlex.value);
    } else {
      errors.push(`openalex: ${openAlex.reason instanceof Error ? openAlex.reason.message.slice(0, 90) : String(openAlex.reason)}`);
    }
    if (crossref.status === "fulfilled") {
      engines.crossref += crossref.value.length;
      allCandidates.push(...crossref.value);
    } else {
      errors.push(`crossref: ${crossref.reason instanceof Error ? crossref.reason.message.slice(0, 90) : String(crossref.reason)}`);
    }
    if (pubmed.status === "fulfilled") {
      engines.pubmed += pubmed.value.length;
      allCandidates.push(...pubmed.value);
    } else {
      errors.push(`pubmed: ${pubmed.reason instanceof Error ? pubmed.reason.message.slice(0, 90) : String(pubmed.reason)}`);
    }

    const relevantCount = uniq(
      allCandidates.filter((candidate) => candidateRelevance(candidate, topic, narration) > 0),
      (candidate) => candidate.url
    ).length;

    // Stop early only when enough on-topic candidates exist. Otherwise retry,
    // even when an earlier round returned URLs that were irrelevant.
    if (relevantCount >= cap) break;
  }

  const relevant = uniq(
    allCandidates
      .map((candidate) => ({ ...candidate, score: candidateRelevance(candidate, topic, narration) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score),
    (candidate) => candidate.url
  );

  return { urls: relevant.slice(0, cap).map((candidate) => candidate.url), engines, errors };
}
