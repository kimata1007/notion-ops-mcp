import { z } from "zod";

import {
  DEFAULT_OUTPUT_BYTES,
  MAX_BATCH_DOCUMENTS,
  MAX_INPUT_MARKDOWN_BYTES,
  MAX_PUBLISH_OPERATIONS,
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

export const ReadDocumentToolInputSchema = z
  .object({
    source: ReadSourceSchema.optional().describe("One Notion document to read"),
    sources: z
      .array(ReadSourceSchema)
      .min(1)
      .max(MAX_BATCH_DOCUMENTS)
      .optional()
      .describe("One to eight Notion documents to read in input order"),
    ...CommonReadOptions,
  })
  .strict()
  .superRefine((input, context) => {
    const parsed = ReadDocumentInputSchema.safeParse(input);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  });

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

const CreatePageSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    markdown: MarkdownSchema,
  })
  .strict();

const BatchCreateTargetSchema = z
  .object({
    type: z.literal("create_batch"),
    parent: ParentSchema,
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

const PublishOperationsSchema = z
  .array(PublishOperationSchema)
  .min(1)
  .max(MAX_PUBLISH_OPERATIONS)
  .superRefine((operations, context) => {
    if (
      operations.length > 1 &&
      operations.some((operation) => operation.type === "replace_document")
    ) {
      context.addIssue({
        code: "custom",
        message: "replace_document must be the only operation",
      });
    }
  });

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

const BatchCreateDocumentInputSchema = z
  .object({
    target: BatchCreateTargetSchema,
    pages: z.array(CreatePageSchema).min(1).max(MAX_BATCH_DOCUMENTS),
    ...CommonPublishOptions,
  })
  .strict()
  .refine(
    (input) =>
      input.pages.reduce((total, page) => total + Buffer.byteLength(page.markdown, "utf8"), 0) <=
      MAX_INPUT_MARKDOWN_BYTES,
    `Combined Markdown must be at most ${MAX_INPUT_MARKDOWN_BYTES} UTF-8 bytes`,
  );

const UpdateDocumentInputSchema = z
  .object({
    target: ExistingTargetSchema,
    operation: PublishOperationSchema,
    base_revision: RevisionSchema.optional(),
    conflict_policy: z.enum(["auto_rebase", "fail_on_change"]).optional().default("fail_on_change"),
    ...CommonPublishOptions,
  })
  .strict();

const BatchUpdateDocumentInputSchema = z
  .object({
    target: ExistingTargetSchema,
    operations: PublishOperationsSchema,
    base_revision: RevisionSchema.optional(),
    conflict_policy: z.enum(["auto_rebase", "fail_on_change"]).optional().default("fail_on_change"),
    ...CommonPublishOptions,
  })
  .strict();

export const PublishDocumentInputSchema = z.union([
  CreateDocumentInputSchema,
  BatchCreateDocumentInputSchema,
  UpdateDocumentInputSchema,
  BatchUpdateDocumentInputSchema,
]);

export const PublishDocumentToolInputSchema = z
  .object({
    target: z
      .union([ExistingTargetSchema, CreateTargetSchema, BatchCreateTargetSchema])
      .describe("Existing page, single-page creation, or batch creation target"),
    markdown: MarkdownSchema.optional().describe("Markdown for single-page creation"),
    pages: z
      .array(CreatePageSchema)
      .min(1)
      .max(MAX_BATCH_DOCUMENTS)
      .optional()
      .describe("One to eight pages for a create_batch target"),
    operation: PublishOperationSchema.optional().describe("One edit for an existing page"),
    operations: PublishOperationsSchema.optional().describe(
      "One to ten ordered edits for an existing page",
    ),
    base_revision: RevisionSchema.optional(),
    conflict_policy: z.enum(["auto_rebase", "fail_on_change"]).optional(),
    dry_run: z.boolean().optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const parsed = PublishDocumentInputSchema.safeParse(input);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  });

export type PublishDocumentInput = z.infer<typeof PublishDocumentInputSchema>;
export type PublishOperation = z.infer<typeof PublishOperationSchema>;
