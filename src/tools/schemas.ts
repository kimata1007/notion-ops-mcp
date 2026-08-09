import { z } from "zod";

import { DEFAULT_OUTPUT_BYTES, MAX_INPUT_MARKDOWN_BYTES } from "../constants.js";
import { normalizeNotionPageUrl, normalizePageId } from "../notion/url.js";

const PageIdSchema = z.string().trim().transform(normalizePageId);
const NotionUrlSchema = z.string().trim().transform(normalizeNotionPageUrl);

export const ReadDocumentInputSchema = z
  .object({
    source: z.discriminatedUnion("type", [
      z.object({ type: z.literal("page_id"), page_id: PageIdSchema }).strict(),
      z.object({ type: z.literal("url"), url: NotionUrlSchema }).strict(),
      z.object({ type: z.literal("search"), query: z.string().trim().min(1).max(500) }).strict(),
    ]),
    max_output_bytes: z.number().int().min(1024).max(DEFAULT_OUTPUT_BYTES).optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

export type ReadDocumentInput = z.infer<typeof ReadDocumentInputSchema>;

export const MarkdownSchema = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_INPUT_MARKDOWN_BYTES,
    `Markdown must be at most ${MAX_INPUT_MARKDOWN_BYTES} UTF-8 bytes`,
  );
