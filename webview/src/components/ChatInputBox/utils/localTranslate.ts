/**
 * Local prompt translation helpers.
 *
 * The draft is masked on the DOM walk before it goes to the bridge: `.file-tag` and
 * `.quote-tag` chips become `⟦LTcN⟧`, fenced blocks and inline code become `⟦LTkN⟧`.
 * The model sees one plain string. On apply, the original chip elements are moved back
 * into their placeholders, so chips stay the very same DOM nodes and code spans are
 * restored byte for byte.
 */

export type TranslateShortcut = 'cmdEnter' | 'shiftEnter';

/**
 * How long the webview waits for one bridge translation.
 * Java may split the masked text into several model calls, each bounded by a 15s HTTP timeout.
 * Short drafts stay at 25s. A long reply gets more time, capped at three minutes.
 */
export function translationWaitMs(maskedLength: number): number {
  const chunks = Math.max(1, Math.ceil(Math.max(maskedLength, 1) / 800));
  return Math.min(180_000, Math.max(25_000, chunks * 20_000));
}

const PLACEHOLDER_RE = /⟦LT([ck])(\d+)⟧/g;
/** Fenced block (``` or ~~~), possibly unterminated at the end of the draft, then inline code. */
const CODE_RE = /(```|~~~)[\s\S]*?(?:\1|$)|(`+)[^`\n]+?\2/g;

export interface MaskedDraft {
  /** The single string sent to the model. */
  text: string;
  /** Chip placeholder id (e.g. `c0`) → the original chip element. */
  chips: Map<string, HTMLElement>;
  /** Code placeholder id (e.g. `k0`) → the original code text, fences and backticks included. */
  code: Map<string, string>;
  /** True when anything but placeholders and whitespace remains for the model. */
  hasProse: boolean;
}

export type ApplyTranslationResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'placeholder' };

function chipPlaceholder(index: number): string {
  return `⟦LTc${index}⟧`;
}

function codePlaceholder(index: number): string {
  return `⟦LTk${index}⟧`;
}

/**
 * Walk the contenteditable the way `useTextContent` does, but emit placeholders for chips
 * instead of their `@path` / quote-token serialization, then mask code spans.
 */
export function maskDraft(editable: HTMLElement): MaskedDraft {
  const parts: string[] = [];
  const chips = new Map<string, HTMLElement>();
  let endsWithNewline = false;

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const content = node.textContent || '';
      if (content) {
        parts.push(content);
        endsWithNewline = content.endsWith('\n');
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    const tagName = element.tagName.toLowerCase();
    if (tagName === 'br') {
      parts.push('\n');
      endsWithNewline = true;
    } else if (tagName === 'div' || tagName === 'p') {
      if (parts.length > 0 && !endsWithNewline) {
        parts.push('\n');
        endsWithNewline = true;
      }
      element.childNodes.forEach(walk);
    } else if (element.classList.contains('file-tag') || element.classList.contains('quote-tag')) {
      const placeholder = chipPlaceholder(chips.size);
      chips.set(`c${chips.size}`, element);
      parts.push(placeholder);
      endsWithNewline = false;
    } else {
      element.childNodes.forEach(walk);
    }
  };
  editable.childNodes.forEach(walk);

  let joined = parts.join('');
  // Same trailing-newline rule as useTextContent: drop a JCEF-added final newline.
  if (joined.endsWith('\n') && editable.childNodes.length > 0) {
    const lastChild = editable.lastChild;
    if (
      lastChild?.nodeType !== Node.ELEMENT_NODE ||
      (lastChild as HTMLElement).tagName?.toLowerCase() !== 'br'
    ) {
      joined = joined.slice(0, -1);
    }
  }

  const code = new Map<string, string>();
  const text = joined.replace(CODE_RE, (match) => {
    const placeholder = codePlaceholder(code.size);
    code.set(`k${code.size}`, match);
    return placeholder;
  });

  const prose = text.replace(PLACEHOLDER_RE, '').replace(/[\u200B-\u200D\uFEFF]/g, '');
  return { text, chips, code, hasProse: prose.trim().length > 0 };
}

export interface MaskedMarkdown {
  text: string;
  code: Map<string, string>;
  hasProse: boolean;
}

/**
 * Mask code spans in assistant markdown without chip processing.
 */
export function maskMarkdown(text: string): MaskedMarkdown {
  const code = new Map<string, string>();
  const maskedText = text.replace(CODE_RE, (match) => {
    const placeholder = codePlaceholder(code.size);
    code.set(`k${code.size}`, match);
    return placeholder;
  });

  const prose = maskedText.replace(PLACEHOLDER_RE, '').replace(/[\u200B-\u200D\uFEFF]/g, '');
  return { text: maskedText, code, hasProse: prose.trim().length > 0 };
}

/**
 * Restore masked code spans into translated markdown. Rejects model output if any
 * code placeholder was dropped, duplicated, or invented, or if any chip placeholder appears.
 */
export function restoreMarkdown(
  output: string,
  code: Map<string, string>,
): ApplyTranslationResult {
  const normalized = output.replace(/\r\n?/g, '\n');
  const counts = countPlaceholders(normalized);
  if (!placeholdersIntact(counts, code.keys(), 'k')) {
    return { ok: false, reason: 'placeholder' };
  }
  for (const id of counts.keys()) {
    if (id.startsWith('c')) return { ok: false, reason: 'placeholder' };
  }

  const restored = normalized.replace(PLACEHOLDER_RE, (match, kind, index) => {
    if (kind === 'k') {
      return code.get(`k${index}`) ?? match;
    }
    return match;
  });

  return { ok: true, text: restored };
}

/**
 * Checks whether an assistant text block has translatable English prose.
 * Not eligible when:
 * - hasProse is false (only code, placeholders, or whitespace)
 * - Unicode letter count is 0
 * - Cyrillic letters account for 50% or more of all letters
 */
export function isReplyTranslatable(text: string): boolean {
  if (!text) return false;
  const masked = maskMarkdown(text);
  if (!masked.hasProse) return false;
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (letters === 0) return false;
  const cyrillic = (text.match(/\p{sc=Cyrillic}/gu) || []).length;
  return cyrillic / letters < 0.5;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/**
 * Computes lowercase hex SHA-256 digest of UTF-8 string synchronously.
 */
export function sha256Hex(str: string): string {
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const bytes = new TextEncoder().encode(str);
  const l = bytes.length;
  const bitLen = l * 8;
  const padLen = (l % 64 < 56) ? 56 - (l % 64) : 120 - (l % 64);
  const totalLen = l + padLen + 8;
  const buf = new Uint8Array(totalLen);
  buf.set(bytes);
  buf[l] = 0x80;
  const view = new DataView(buf.buffer);
  view.setBigUint64(totalLen - 8, BigInt(bitLen), false);

  const W = new Int32Array(64);
  for (let i = 0; i < totalLen; i += 64) {
    for (let t = 0; t < 16; t++) {
      W[t] = view.getInt32(i + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = ((W[t - 15] >>> 7) | (W[t - 15] << 25)) ^ ((W[t - 15] >>> 18) | (W[t - 15] << 14)) ^ (W[t - 15] >>> 3);
      const s1 = ((W[t - 2] >>> 17) | (W[t - 2] << 15)) ^ ((W[t - 2] >>> 19) | (W[t - 2] << 13)) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ ((~e) & g);
      const temp1 = (h + S1 + ch + SHA256_K[t] + W[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const toHex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(toHex).join('');
}

/** Count every placeholder id in `text`. */
function countPlaceholders(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const id = `${match[1]}${match[2]}`;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Each expected id exactly once, and no id the mask did not produce. */
function placeholdersIntact(counts: Map<string, number>, expected: Iterable<string>, kind: 'c' | 'k'): boolean {
  const expectedSet = new Set(expected);
  for (const id of expectedSet) {
    if (counts.get(id) !== 1) return false;
  }
  for (const id of counts.keys()) {
    if (id.startsWith(kind) && !expectedSet.has(id)) return false;
  }
  return true;
}

/**
 * Validate the model output and, when every placeholder survived exactly once, rebuild the
 * editor content from it. Newlines become `<br>`; chip elements are moved, not cloned.
 * Never assigns `innerText`/`innerHTML`. On any placeholder mismatch the DOM is untouched.
 */
export function applyTranslation(
  editable: HTMLElement,
  masked: MaskedDraft,
  output: string,
): ApplyTranslationResult {
  // Models on Windows hosts may answer with \r\n or bare \r; the editor only knows \n.
  const normalized = output.replace(/\r\n?/g, '\n');
  const codeCounts = countPlaceholders(normalized);
  if (!placeholdersIntact(codeCounts, masked.code.keys(), 'k')) {
    return { ok: false, reason: 'placeholder' };
  }
  // Count chips on the model output. Restored code is literal text and may itself
  // contain a placeholder token; scanning it would reject a correct translation.
  const chipCounts = countPlaceholders(normalized);
  if (!placeholdersIntact(chipCounts, masked.chips.keys(), 'c')) {
    return { ok: false, reason: 'placeholder' };
  }

  const doc = editable.ownerDocument;
  const fragment = doc.createDocumentFragment();
  const plainParts: string[] = [];
  const appendText = (segment: string) => {
    plainParts.push(segment);
    const lines = segment.split('\n');
    lines.forEach((line, i) => {
      if (i > 0) fragment.appendChild(doc.createElement('br'));
      if (line) fragment.appendChild(doc.createTextNode(line));
    });
  };

  let lastIndex = 0;
  for (const match of normalized.matchAll(PLACEHOLDER_RE)) {
    const start = match.index ?? 0;
    appendText(normalized.slice(lastIndex, start));
    if (match[1] === 'k') {
      appendText(masked.code.get(`k${match[2]}`) ?? match[0]);
    } else {
      const chip = masked.chips.get(`c${match[2]}`);
      if (chip) fragment.appendChild(chip);
    }
    lastIndex = start + match[0].length;
  }
  appendText(normalized.slice(lastIndex));

  editable.replaceChildren(fragment);
  return { ok: true, text: plainParts.join('') };
}

/** Place the caret after the last node of the editor. */
export function placeCaretAtEnd(editable: HTMLElement): void {
  const doc = editable.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection) return;
  const range = doc.createRange();
  range.selectNodeContents(editable);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Any draft whose first non-whitespace token is a slash command (e.g. `/clear`, `/review`,
 * `/explain this`) is skipped so the model cannot drop or reword the leading slash token.
 */
const SLASH_COMMAND_TOKEN_RE = /^\/[A-Za-z][\w:-]*(?=\s|$)/;

export function isLocalCommandDraft(text: string, _provider = 'claude'): boolean {
  const trimmed = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  return SLASH_COMMAND_TOKEN_RE.test(trimmed);
}
