import { z } from "zod";

import { OpsError } from "../errors.js";
import { isAllowedNotionPageUrl, pageIdFromUrl } from "./url.js";

export interface SearchCandidate {
  id: string;
  url: string;
  title: string;
  lastEditedTime?: string;
}

export interface PageSnapshot {
  id: string;
  url: string;
  title: string;
  markdown: string;
  lastEditedTime: string;
  lastEditedTimeSource: "page" | "snapshot";
  upstreamTruncated: boolean;
}

const IsoTimestampSchema = z.iso.datetime({ offset: true });

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringAt(value: unknown, keys: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    current = record(current)?.[key];
  }
  return typeof current === "string" ? current : undefined;
}

function titleFrom(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const combined = value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      return stringAt(entry, ["plain_text"]) ?? stringAt(entry, ["text", "content"]) ?? "";
    })
    .join("");
  return combined || undefined;
}

function extractContentEnvelope(text: string): string {
  const match = text.match(/<content>\r?\n?([\s\S]*?)\r?\n?<\/content>/i);
  return match?.[1] ?? text;
}

function extractSnapshotTime(text: string): string | undefined {
  const match = text.match(/\bas of (\d{4}-\d{2}-\d{2}T[^:\s]+:[^\s]+Z)\s*:/i);
  const candidate = match?.[1];
  return candidate && IsoTimestampSchema.safeParse(candidate).success ? candidate : undefined;
}

export function normalizeSearchResult(
  value: unknown,
  maximumCandidates: number,
): SearchCandidate[] {
  const results = record(value)?.["results"];
  if (!Array.isArray(results)) {
    throw new OpsError("upstream_incompatible", "Notion search result has no results array");
  }

  const candidates: SearchCandidate[] = [];
  for (const entry of results) {
    const item = record(entry);
    if (!item) continue;
    const url = typeof item["url"] === "string" ? item["url"] : undefined;
    if (!url || !isAllowedNotionPageUrl(url)) continue;
    const idValue = typeof item["id"] === "string" ? item["id"] : undefined;
    const title = titleFrom(item["title"]) ?? "Untitled";
    const id = idValue ?? pageIdFromUrl(url);
    const timestamp =
      typeof item["last_edited_time"] === "string"
        ? item["last_edited_time"]
        : typeof item["timestamp"] === "string"
          ? item["timestamp"]
          : undefined;
    candidates.push({
      id,
      url,
      title,
      ...(timestamp && IsoTimestampSchema.safeParse(timestamp).success
        ? { lastEditedTime: timestamp }
        : {}),
    });
    if (candidates.length >= maximumCandidates) break;
  }
  return candidates;
}

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function preferExactTitleMatches(
  candidates: SearchCandidate[],
  query: string,
): SearchCandidate[] {
  const expected = normalizedTitle(query);
  const exact = candidates.filter((candidate) => normalizedTitle(candidate.title) === expected);
  return exact.length > 0 ? exact : candidates;
}

export function normalizeFetchResult(value: unknown): PageSnapshot {
  const root = record(value);
  if (!root) throw new OpsError("upstream_incompatible", "Notion fetch result is not an object");
  const metadataType = stringAt(root, ["metadata", "type"]);
  if (metadataType && metadataType !== "page") {
    throw new OpsError("not_found", "target is not a Notion page");
  }

  const url = stringAt(root, ["url"]) ?? stringAt(root, ["page", "url"]);
  if (!url || !isAllowedNotionPageUrl(url)) {
    throw new OpsError("upstream_incompatible", "Notion fetch result has no valid page URL");
  }
  const id = stringAt(root, ["id"]) ?? stringAt(root, ["page", "id"]) ?? pageIdFromUrl(url);
  const title = titleFrom(root["title"]) ?? titleFrom(record(root["properties"])?.["title"]);
  if (!title) throw new OpsError("upstream_incompatible", "Notion fetch result has no page title");

  const rawText =
    stringAt(root, ["markdown"]) ??
    stringAt(root, ["text"]) ??
    stringAt(root, ["page", "markdown"]);
  if (rawText === undefined) {
    throw new OpsError("upstream_incompatible", "Notion fetch result has no page content");
  }
  const markdown = stringAt(root, ["markdown"]) ? rawText : extractContentEnvelope(rawText);

  const explicitLastEdited =
    stringAt(root, ["last_edited_time"]) ??
    stringAt(root, ["page", "last_edited_time"]) ??
    stringAt(root, ["metadata", "last_edited_time"]);
  const snapshotTime = extractSnapshotTime(rawText);
  const lastEditedTime = explicitLastEdited ?? snapshotTime;
  if (!lastEditedTime || !IsoTimestampSchema.safeParse(lastEditedTime).success) {
    throw new OpsError("upstream_incompatible", "Notion fetch result has no revision timestamp");
  }

  return {
    id,
    url,
    title,
    markdown,
    lastEditedTime,
    lastEditedTimeSource: explicitLastEdited ? "page" : "snapshot",
    upstreamTruncated: root["truncated"] === true,
  };
}
