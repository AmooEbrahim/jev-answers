// Deliberately pessimistic. ASCII (mostly code) averages a bit under 4 chars per token, so we
// count 1/3.5 per character; anything else (Persian, CJK, emoji) tokenizes far worse, about one
// token per character (two for astral code points).
export function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 128) ascii++;
    else other += cp > 0xffff ? 2 : 1;
  }
  return Math.ceil(ascii / 3.5 + other);
}

export function estimateJsonTokens(value) {
  return estimateTokens(JSON.stringify(value));
}
