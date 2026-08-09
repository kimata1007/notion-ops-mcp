import { createServer } from "node:http";

import { OpsError } from "../errors.js";

export interface LoopbackRequest {
  method: string;
  url: string;
  host: string;
  remoteAddress: string;
}

export interface LoopbackResponse {
  status: number;
  contentType: string;
  body: string;
  noStore?: boolean;
}

export interface LoopbackListener {
  redirectUri: string;
  close(): void;
}

export type LoopbackHandler = (request: LoopbackRequest) => Promise<LoopbackResponse>;
export type LoopbackFactory = (
  path: string,
  handler: LoopbackHandler,
  signal: AbortSignal,
) => Promise<LoopbackListener>;

export const createLoopbackListener: LoopbackFactory = async (path, handler, signal) => {
  const server = createServer((request, response) => {
    void handler({
      method: request.method ?? "",
      url: request.url ?? "/",
      host: request.headers.host ?? "",
      remoteAddress: request.socket.remoteAddress ?? "",
    })
      .then((result) => {
        response.writeHead(result.status, {
          "Content-Type": result.contentType,
          ...(result.noStore ? { "Cache-Control": "no-store" } : {}),
        });
        response.end(result.body);
      })
      .catch(() => {
        response.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end("Authorization callback failed.");
      });
  });

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      server.close();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new OpsError("failed", "loopback callback did not bind a TCP port");
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}${path}`,
    close: () => server.close(),
  };
};
