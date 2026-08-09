import { redact } from "./security/redact.js";

export type LogSink = (line: string) => void;

export class SafeLogger {
  readonly #sink: LogSink;

  constructor(sink: LogSink = (line) => process.stderr.write(`${line}\n`)) {
    this.#sink = sink;
  }

  info(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.#write("info", event, fields);
  }

  error(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.#write("error", event, fields);
  }

  #write(level: "info" | "error", event: string, fields: Readonly<Record<string, unknown>>): void {
    this.#sink(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...(redact(fields) as Record<string, unknown>),
      }),
    );
  }
}
