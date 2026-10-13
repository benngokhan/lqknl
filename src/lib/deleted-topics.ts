import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { operations } from "@/db/schema";
import { normalizeTitleKey } from "@/lib/dedupe-content";

export function deletedTopicHash(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const normalized = normalizeTitleKey(value);
  return normalized ? createHash("sha256").update(normalized, "utf8").digest("hex") : null;
}

export async function isPermanentlyDeletedTopic(db: any, candidates: Array<string | null | undefined>): Promise<boolean> {
  const candidateHashes = new Set(candidates.map(deletedTopicHash).filter((value): value is string => Boolean(value)));
  if (!candidateHashes.size) return false;
  const tombstones = await db.select({ metadata: operations.metadata })
    .from(operations)
    .where(eq(operations.action, "content_permanently_deleted"))
    .orderBy(desc(operations.id))
    .limit(5000);
  for (const row of tombstones) {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
    const hashes = Array.isArray(metadata.deletedTopicHashes) ? metadata.deletedTopicHashes : [];
    if (hashes.some((value) => typeof value === "string" && candidateHashes.has(value))) return true;
  }
  return false;
}
