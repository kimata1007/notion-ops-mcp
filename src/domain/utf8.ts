import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

export interface TruncatedText {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

export function truncateUtf8(text: string, maximumBytes: number): TruncatedText {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maximumBytes) {
    return { text, truncated: false, originalBytes: bytes.byteLength };
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = maximumBytes;
  while (end > 0) {
    try {
      return {
        text: decoder.decode(bytes.subarray(0, end)),
        truncated: true,
        originalBytes: bytes.byteLength,
      };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated: true, originalBytes: bytes.byteLength };
}
