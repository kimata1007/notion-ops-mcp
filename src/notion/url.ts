import { OpsError } from "../errors.js";

const NOTION_HOSTS = new Set(["notion.so", "www.notion.so", "notion.com", "www.notion.com"]);
const PAGE_ID = /(?:^|[-/])([0-9a-f]{32})(?:$|[/?#])/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPACT_ID = /^[0-9a-f]{32}$/i;

export function normalizePageId(value: string): string {
  const trimmed = value.trim();
  if (UUID.test(trimmed)) return trimmed.toLowerCase();
  if (!COMPACT_ID.test(trimmed)) throw new OpsError("failed", "invalid Notion page ID");
  return [
    trimmed.slice(0, 8),
    trimmed.slice(8, 12),
    trimmed.slice(12, 16),
    trimmed.slice(16, 20),
    trimmed.slice(20),
  ]
    .join("-")
    .toLowerCase();
}

export function normalizeNotionPageUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpsError("failed", "invalid Notion page URL");
  }
  if (
    url.protocol !== "https:" ||
    !NOTION_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new OpsError("failed", "Notion page URL is not allowed");
  }
  if (!PAGE_ID.test(`${url.pathname}/`)) {
    throw new OpsError("failed", "Notion page URL does not contain a page ID");
  }
  return url.toString();
}

export function pageIdFromUrl(value: string): string {
  const url = new URL(normalizeNotionPageUrl(value));
  const match = `${url.pathname}/`.match(PAGE_ID);
  const compact = match?.[1];
  if (!compact) throw new OpsError("failed", "Notion page URL does not contain a page ID");
  return normalizePageId(compact);
}

export function isAllowedNotionPageUrl(value: string): boolean {
  try {
    normalizeNotionPageUrl(value);
    return true;
  } catch {
    return false;
  }
}
