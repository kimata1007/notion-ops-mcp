export type JsonObject = Record<string, unknown>;

export interface UpstreamToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties?: Readonly<Record<string, object>>;
    readonly required?: readonly string[];
    readonly [key: string]: unknown;
  };
}

export type UpstreamToolRole = "search" | "fetch" | "createPages" | "updatePage" | "getAsyncTask";

export type UpstreamToolNames = Readonly<
  Record<"search" | "fetch" | "createPages" | "updatePage", string> &
    Partial<Record<"getAsyncTask", string>>
>;

export interface UpstreamCallResult {
  readonly value: unknown;
  readonly rawTextBytes: number;
}
