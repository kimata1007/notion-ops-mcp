import { z } from "zod";

import {
  DEFAULT_OUTPUT_BYTES,
  MAX_BATCH_DOCUMENTS,
  MAX_INPUT_MARKDOWN_BYTES,
} from "../constants.js";
import { RevisionSchema } from "../domain/revision.js";
import { normalizeNotionPageUrl, normalizePageId } from "../notion/url.js";

const PageIdSchema = z.string().trim().transform(normalizePageId);
const NotionUrlSchema = z.string().trim().transform(normalizeNotionPageUrl);

export const ReadSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page_id"), page_id: PageIdSchema }).strict(),
  z.object({ type: z.literal("url"), url: NotionUrlSchema }).strict(),
  z.object({ type: z.literal("search"), query: z.string().trim().min(1).max(500) }).strict(),
]);

const CommonReadOptions = {
  max_output_bytes: z.number().int().min(1024).max(DEFAULT_OUTPUT_BYTES).optional(),
  timeout_ms: z.number().int().positive().optional(),
};

const SingleReadDocumentInputSchema = z
  .object({
    source: ReadSourceSchema,
    ...CommonReadOptions,
  })
  .strict();

const BatchReadDocumentInputSchema = z
  .object({
    sources: z.array(ReadSourceSchema).min(1).max(MAX_BATCH_DOCUMENTS),
    ...CommonReadOptions,
  })
  .strict();

export const ReadDocumentInputSchema = z.union([
  SingleReadDocumentInputSchema,
  BatchReadDocumentInputSchema,
]);

export type ReadDocumentInput = z.infer<typeof ReadDocumentInputSchema>;
export type ReadSource = z.infer<typeof ReadSourceSchema>;

export const MarkdownSchema = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_INPUT_MARKDOWN_BYTES,
    `Markdown must be at most ${MAX_INPUT_MARKDOWN_BYTES} UTF-8 bytes`,
  );

const ExistingTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page_id"), page_id: PageIdSchema }).strict(),
  z.object({ type: z.literal("url"), url: NotionUrlSchema }).strict(),
  z.object({ type: z.literal("search"), query: z.string().trim().min(1).max(500) }).strict(),
]);

const ParentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page_id"), page_id: PageIdSchema }).strict(),
  z
    .object({
      type: z.literal("data_source_id"),
      data_source_id: z
        .string()
        .trim()
        .regex(/^(?:collection:\/\/)?[0-9a-f-]{32,36}$/i),
    })
    .strict(),
]);

const CreateTargetSchema = z
  .object({
    type: z.literal("create"),
    parent: ParentSchema,
    title: z.string().trim().min(1).max(200),
  })
  .strict();

export const AnchorSchema = z
  .object({
    kind: z.enum(["heading", "context"]),
    text: z.string().min(1).max(2_000),
  })
  .strict();

export const PublishOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("append"), markdown: MarkdownSchema }).strict(),
  z.object({ type: z.literal("prepend"), markdown: MarkdownSchema }).strict(),
  z
    .object({ type: z.literal("insert_after"), anchor: AnchorSchema, markdown: MarkdownSchema })
    .strict(),
  z
    .object({ type: z.literal("insert_before"), anchor: AnchorSchema, markdown: MarkdownSchema })
    .strict(),
  z
    .object({
      type: z.literal("replace_text"),
      old_text: z.string().min(1).max(MAX_INPUT_MARKDOWN_BYTES),
      new_text: MarkdownSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("replace_document"),
      markdown: MarkdownSchema,
      confirm_replace_document: z.literal(true),
    })
    .strict(),
]);

const CommonPublishOptions = {
  dry_run: z.boolean().optional().default(false),
  timeout_ms: z.number().int().positive().optional(),
};

const CreateDocumentInputSchema = z
  .object({
    target: CreateTargetSchema,
    markdown: MarkdownSchema,
    ...CommonPublishOptions,
  })
  .strict();

const UpdateDocumentInputSchema = z
  .object({
    target: ExistingTargetSchema,
    operation: PublishOperationSchema,
    base_revision: RevisionSchema.optional(),
    conflict_policy: z.enum(["auto_rebase", "fail_on_change"]).optional().default("fail_on_change"),
    ...CommonPublishOptions,
  })
  .strict();

export const PublishDocumentInputSchema = z.union([
  CreateDocumentInputSchema,
  UpdateDocumentInputSchema,
]);

export type PublishDocumentInput = z.infer<typeof PublishDocumentInputSchema>;
export type PublishOperation = z.infer<typeof PublishOperationSchema>;
