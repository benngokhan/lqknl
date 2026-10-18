import { compareYoutubeTags } from "./youtube-tag-verification";

export type ExpectedYoutubeUpload = {
  title: string;
  description: string;
  tags: string[];
  privacyStatus: string;
  publishAt?: string;
};

export type YoutubeVideoSnapshot = {
  title: string;
  description: string;
  tags: string[];
  privacyStatus: string;
  publishAt?: string;
};

export type YoutubeUploadComparison = {
  matches: boolean;
  mismatches: string[];
};

/** Pure comparison used after uploads and in regression tests. */
export function compareYoutubeUploadMetadata(
  expected: ExpectedYoutubeUpload,
  actual: YoutubeVideoSnapshot,
): YoutubeUploadComparison {
  const mismatches: string[] = [];
  if (actual.title.trim() !== expected.title.trim()) mismatches.push("title");
  if (actual.description.replace(/\r\n/g, "\n").trim() !== expected.description.replace(/\r\n/g, "\n").trim()) {
    mismatches.push("description");
  }

  const tagComparison = compareYoutubeTags(expected.tags, actual.tags);
  if (!tagComparison.matches) {
    const details = [
      tagComparison.missing.length ? "missing=" + tagComparison.missing.slice(0, 5).join(",") : "",
      tagComparison.unexpected.length ? "unexpected=" + tagComparison.unexpected.slice(0, 5).join(",") : "",
    ].filter(Boolean).join("; ");
    mismatches.push("tags" + (details ? " (" + details + ")" : ""));
  }

  if (actual.privacyStatus !== expected.privacyStatus) mismatches.push("privacyStatus");

  if (expected.publishAt) {
    const expectedMs = Date.parse(expected.publishAt);
    const actualMs = actual.publishAt ? Date.parse(actual.publishAt) : Number.NaN;
    if (!Number.isFinite(expectedMs) || !Number.isFinite(actualMs) || Math.abs(expectedMs - actualMs) > 1000) {
      mismatches.push("publishAt");
    }
  }

  return { matches: mismatches.length === 0, mismatches };
}
