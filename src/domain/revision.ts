import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

export const RevisionSchema = z
  .object({
    version: z.literal(1),
    last_edited_time: z.iso.datetime({ offset: true }),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    last_edited_time_source: z.enum(["page", "snapshot"]).optional(),
  })
  .strict();

export type Revision = z.infer<typeof RevisionSchema>;

export function contentSha256(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

export function createRevision(markdown: string, lastEditedTime: string): Revision {
  const revision = {
    version: 1 as const,
    last_edited_time: lastEditedTime,
    content_sha256: contentSha256(markdown),
  };
  return RevisionSchema.parse(revision);
}

export function revisionsEqual(left: Revision, right: Revision): boolean {
  const leftHash = Buffer.from(left.content_sha256, "hex");
  const rightHash = Buffer.from(right.content_sha256, "hex");
  return (
    left.last_edited_time === right.last_edited_time &&
    leftHash.length === rightHash.length &&
    timingSafeEqual(leftHash, rightHash)
  );
}

export function contentEqual(left: Revision, right: Revision): boolean {
  const leftHash = Buffer.from(left.content_sha256, "hex");
  const rightHash = Buffer.from(right.content_sha256, "hex");
  return leftHash.length === rightHash.length && timingSafeEqual(leftHash, rightHash);
}
