import { OpsError } from "../errors.js";
import type { UpstreamToolDefinition, UpstreamToolNames, UpstreamToolRole } from "./types.js";

const CANDIDATES: Readonly<Record<UpstreamToolRole, readonly string[]>> = {
  search: ["notion-search", "search"],
  fetch: ["notion-fetch", "fetch"],
  createPages: ["notion-create-pages"],
  updatePage: ["notion-update-page"],
  getAsyncTask: ["notion-get-async-task"],
};

const EXPECTED_PROPERTIES: Readonly<Record<UpstreamToolRole, readonly string[]>> = {
  search: ["query"],
  fetch: ["id"],
  createPages: ["pages"],
  updatePage: ["page_id", "command"],
  getAsyncTask: ["task_id"],
};

function schemaHasProperty(
  schema: unknown,
  property: string,
  seen = new WeakSet<object>(),
): boolean {
  if (schema === null || typeof schema !== "object") return false;
  if (seen.has(schema)) return false;
  seen.add(schema);
  const record = schema as Record<string, unknown>;
  const properties = record["properties"];
  if (
    properties !== null &&
    typeof properties === "object" &&
    Object.hasOwn(properties, property)
  ) {
    return true;
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = record[key];
    if (
      Array.isArray(branches) &&
      branches.some((branch) => schemaHasProperty(branch, property, seen))
    ) {
      return true;
    }
  }
  return false;
}

export class UpstreamToolCatalog {
  readonly #tools: ReadonlyMap<string, UpstreamToolDefinition>;

  constructor(tools: readonly UpstreamToolDefinition[]) {
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  resolve(options: { requireWrite: boolean; requireAsync?: boolean }): UpstreamToolNames {
    const search = this.#resolveRole("search");
    const fetch = this.#resolveRole("fetch");
    const createPages = options.requireWrite ? this.#resolveRole("createPages") : "";
    const updatePage = options.requireWrite ? this.#resolveRole("updatePage") : "";
    const getAsyncTask = options.requireAsync ? this.#resolveRole("getAsyncTask") : undefined;

    return {
      search,
      fetch,
      createPages,
      updatePage,
      ...(getAsyncTask ? { getAsyncTask } : {}),
    };
  }

  #resolveRole(role: UpstreamToolRole): string {
    const name = CANDIDATES[role].find((candidate) => this.#tools.has(candidate));
    if (!name) {
      throw new OpsError(
        "upstream_incompatible",
        `required upstream tool is unavailable: ${role}`,
        {
          details: { role },
        },
      );
    }

    const tool = this.#tools.get(name);
    if (!tool) throw new OpsError("upstream_incompatible", "upstream tool catalog changed");
    const missing = EXPECTED_PROPERTIES[role].filter(
      (property) => !schemaHasProperty(tool.inputSchema, property),
    );
    if (missing.length > 0) {
      throw new OpsError("upstream_incompatible", `upstream tool schema is incompatible: ${role}`, {
        details: { role, missing },
      });
    }
    return name;
  }
}
