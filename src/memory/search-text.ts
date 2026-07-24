const CHUNKS = /[\p{Script=Han}]+|[\p{L}\p{N}]+/gu;

export function memorySearchTokens(value: string, limit = 48): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const normalized = value.normalize("NFKC").toLocaleLowerCase("und");
  for (const match of normalized.matchAll(CHUNKS)) {
    const chunk = match[0];
    const tokens = /[\p{Script=Han}]/u.test(chunk) ? hanTokens(chunk) : [chunk];
    for (const token of tokens) {
      if (!token || seen.has(token)) continue;
      seen.add(token);
      result.push(token);
      if (result.length >= limit) return result;
    }
  }
  return result;
}

export function memorySearchText(value: string): string {
  return memorySearchTokens(value).join(" ");
}

export function memoryFtsQuery(value: string): string {
  return memorySearchTokens(value, 24)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function hanTokens(value: string): string[] {
  const characters = [...value];
  if (characters.length <= 1) return characters;
  return characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`);
}
