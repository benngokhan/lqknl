export type VideoResearchItem = {
  rank: number;
  title: string;
  channel: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
  videoId: string;
  url: string;
};

export type VideoResearchResult = {
  source: "YouTube Data API";
  searchedAt: string;
  windowHours: number;
  regionCode: string;
  items: VideoResearchItem[];
};

// YouTube search.list is quota-expensive (typically 100 units per call).
// Cache identical research queries briefly and share concurrent requests.
const VIDEO_RESEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const videoResearchCache = new Map<string, { expiresAt: number; value: VideoResearchResult }>();
const videoResearchInFlight = new Map<string, Promise<VideoResearchResult>>();

export async function researchShortVideos(
  query = "",
  windowHours = 24,
  regionCode = "TR",
  maxResults = 10,
): Promise<VideoResearchResult> {
  const safeWindow = Math.min(Math.max(windowHours, 1), 168);
  const safeMaxResults = Math.min(Math.max(maxResults, 1), 25);
  const normalizedQuery = query.trim().slice(0, 100);
  const key = JSON.stringify([normalizedQuery, safeWindow, regionCode, safeMaxResults]);
  const cached = videoResearchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const pending = videoResearchInFlight.get(key);
  if (pending) return pending;

  const request = fetchResearchShortVideosUncached(normalizedQuery, safeWindow, regionCode, safeMaxResults)
    .then((value) => {
      videoResearchCache.set(key, { expiresAt: Date.now() + VIDEO_RESEARCH_CACHE_TTL_MS, value });
      return value;
    })
    .finally(() => videoResearchInFlight.delete(key));
  videoResearchInFlight.set(key, request);
  return request;
}


async function fetchResearchShortVideosUncached(
  query = "",
  windowHours = 24,
  regionCode = "TR",
  maxResults = 10,
): Promise<VideoResearchResult> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YOUTUBE_API_KEY missing");

  const safeWindow = Math.min(Math.max(windowHours, 1), 168);
  const publishedAfter = new Date(Date.now() - safeWindow * 60 * 60 * 1000).toISOString();

  const searchParams = new URLSearchParams({
    part: "snippet",
    type: "video",
    videoDuration: "short",
    order: "viewCount",
    publishedAfter,
    regionCode,
    maxResults: String(Math.min(Math.max(maxResults, 1), 25)),
    key,
  });
  if (query.trim()) searchParams.set("q", query.trim().slice(0, 100));

  const searchRes = await fetch(
    "https://www.googleapis.com/youtube/v3/search?" + searchParams.toString(),
    { cache: "no-store" },
  );
  if (!searchRes.ok) {
    const body = (await searchRes.text()).slice(0, 600);
    throw new Error(`YouTube search ${searchRes.status}: ${body}`);
  }

  const searchData: { items?: Array<{ id?: { videoId?: string } }> } = await searchRes.json();
  const searchItems = Array.isArray(searchData.items) ? searchData.items : [];
  const ids: string[] = searchItems
    .map((item) => item.id?.videoId)
    .filter((id): id is string => typeof id === "string");

  if (!ids.length) {
    return {
      source: "YouTube Data API",
      searchedAt: new Date().toISOString(),
      windowHours: safeWindow,
      regionCode,
      items: [],
    };
  }

  const videoParams = new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    id: ids.join(","),
    maxResults: String(ids.length),
    key,
  });
  const videoRes = await fetch(
    "https://www.googleapis.com/youtube/v3/videos?" + videoParams.toString(),
    { cache: "no-store" },
  );
  if (!videoRes.ok) {
    const body = (await videoRes.text()).slice(0, 600);
    throw new Error(`YouTube videos ${videoRes.status}: ${body}`);
  }

  const videoData = await videoRes.json();
  const rankById = new Map<string, number>(ids.map((id: string, index: number) => [id, index]));

  const items = (videoData.items ?? [])
    .map((item: {
      id?: string;
      snippet?: { title?: string; channelTitle?: string; publishedAt?: string };
      statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
    }) => {
      const id = item.id ?? "";
      return {
        id,
        rank: (rankById.get(id) ?? 999) + 1,
        title: item.snippet?.title ?? "(başlıksız)",
        channel: item.snippet?.channelTitle ?? "(kanal bilinmiyor)",
        publishedAt: item.snippet?.publishedAt ?? "",
        views: Number(item.statistics?.viewCount ?? 0),
        likes: Number(item.statistics?.likeCount ?? 0),
        comments: Number(item.statistics?.commentCount ?? 0),
        videoId: id,
        url: `https://www.youtube.com/shorts/${id}`,
      };
    })
    .filter((item: { videoId: string }) => Boolean(item.videoId))
    .sort((a: { views: number }, b: { views: number }) => b.views - a.views)
    .slice(0, maxResults)
    .map((item: Omit<VideoResearchItem, "rank">, index: number) => ({
      ...item,
      rank: index + 1,
    }));

  return {
    source: "YouTube Data API",
    searchedAt: new Date().toISOString(),
    windowHours: safeWindow,
    regionCode,
    items,
  };
}
