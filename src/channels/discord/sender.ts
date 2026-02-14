export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0 || splitAt < limit * 0.5) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt <= 0 || splitAt < limit * 0.5) {
      splitAt = limit;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
