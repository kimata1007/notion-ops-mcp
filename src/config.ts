import { DEFAULT_UPSTREAM_URL } from "./constants.js";

export interface RuntimeConfig {
  upstreamEndpoint: URL;
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const rawEndpoint = environment["NOTION_MCP_URL"]?.trim() || DEFAULT_UPSTREAM_URL;
  let upstreamEndpoint: URL;
  try {
    upstreamEndpoint = new URL(rawEndpoint);
  } catch {
    throw new Error("NOTION_MCP_URL must be a valid URL");
  }

  if (
    upstreamEndpoint.protocol !== "https:" ||
    upstreamEndpoint.username ||
    upstreamEndpoint.password ||
    upstreamEndpoint.hash
  ) {
    throw new Error("NOTION_MCP_URL must be an HTTPS URL without credentials or a fragment");
  }

  return { upstreamEndpoint };
}
