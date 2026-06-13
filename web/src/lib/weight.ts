// Byte/char weight proxy — no tokenizer (§4.6). The default weight bar is a UTF-8
// byte count: free, already what the host's `utf8Bytes` reports, and a fine proxy
// for relative bulk + spotting growth. It carries an "≈" so nobody mistakes it for
// an exact token count. An exact tokenizer is opt-in and lives in its own workspace
// (never core, never a hard server dep) — absent ⇒ this byte proxy.

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** UTF-8 byte length of a string (matches the host's utf8Bytes proxy). */
export function utf8Bytes(text: string): number {
  if (encoder) return encoder.encode(text).length;
  // Fallback for environments without TextEncoder: count code units' UTF-8 cost.
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // surrogate pair → 4 bytes
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Human-readable ≈byte weight, e.g. "≈1.8 KB", "≈455 B". */
export function formatWeight(bytes: number): string {
  if (bytes < 1024) return `≈${bytes} B`;
  return `≈${(bytes / 1024).toFixed(1)} KB`;
}

/** A signed byte delta, e.g. "+312 B", "−1.2 KB". Empty string for zero. */
export function formatDelta(delta: number): string {
  if (delta === 0) return '';
  const sign = delta > 0 ? '+' : '−';
  const abs = Math.abs(delta);
  const mag = abs < 1024 ? `${abs} B` : `${(abs / 1024).toFixed(1)} KB`;
  return `${sign}${mag}`;
}
