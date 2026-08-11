function normalizedLines(markdown: string): string[] {
  return markdown.replace(/\r\n?/gu, "\n").split("\n");
}

export function canonicalizeNotionMarkdown(markdown: string): string {
  const output: string[] = [];
  let fence: "`" | "~" | undefined;

  for (const rawLine of normalizedLines(markdown)) {
    const line = rawLine.trimEnd();
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];

    if (fence) {
      output.push(line);
      if (marker?.startsWith(fence)) fence = undefined;
      continue;
    }

    if (marker) {
      fence = marker.startsWith("`") ? "`" : "~";
      output.push(line);
      continue;
    }

    // The hosted MCP serializes adjacent Notion blocks on consecutive lines,
    // even when the input Markdown separated those blocks with blank lines.
    if (line.trim().length > 0) output.push(line);
  }

  return output.join("\n").trimEnd();
}

export function notionMarkdownEquivalent(left: string, right: string): boolean {
  return canonicalizeNotionMarkdown(left) === canonicalizeNotionMarkdown(right);
}

export function notionCreateContentEquivalent(actual: string, requested: string): boolean {
  if (notionMarkdownEquivalent(actual, requested)) return true;

  const lines = normalizedLines(requested);
  let firstContentLine = 0;
  while (lines[firstContentLine]?.trim().length === 0) firstContentLine += 1;
  if (!/^#\s+/u.test(lines[firstContentLine] ?? "")) return false;

  let remainderStart = firstContentLine + 1;
  while (lines[remainderStart]?.trim().length === 0) remainderStart += 1;
  return notionMarkdownEquivalent(actual, lines.slice(remainderStart).join("\n"));
}
