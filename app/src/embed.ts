// Model2Vec static embeddings (minishlab/potion-base-8M) in pure JS: the tokenizer.json pipeline, a safetensors table,
// mean of token vectors, L2-normalised. Matches model2vec's StaticModel.encode (unknown tokens dropped, 512-token cap).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MODEL_DIR = process.env.ENGRAM_MODEL_DIR || "/app/model";
// Pinned with the Dockerfile and scripts/fetch-model.sh; part of every stored vector's hash so a new model re-embeds.
export const MODEL_REV = "potion-base-8M@bf8b056651a2c21b8d2565580b8569da283cab23";
const MAX_TOKENS = 512;

type Model = {
  vocab: Map<string, number>; unk: number; dim: number; vecs: Float32Array; added: RegExp | null; addedIds: Map<string, number>;
  clean: boolean; cjk: boolean; strip: boolean; lower: boolean; prefix: string; maxWord: number; maxPiece: number; maxChars: number;
};
let model: Model | null | undefined;

const CJK = /[\u{4E00}-\u{9FFF}\u{3400}-\u{4DBF}\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B920}-\u{2CEAF}\u{F900}-\u{FAFF}\u{2F800}-\u{2FA1F}]/gu;
// BertPreTokenizer splits off Unicode punctuation and every ASCII punctuation char (Rust is_ascii_punctuation includes $+<=>^`|~).
const PIECES = /[\p{P}!-\/:-@\[-`{-~]|[^\p{P}!-\/:-@\[-`{-~]+/gu;

/** Loads once per process (~30 MB); null when the files are absent, and search then stays BM25-only. */
export function loadModel(): Model | null {
  if (model !== undefined) return model;
  const st = join(MODEL_DIR, "model.safetensors"), tj = join(MODEL_DIR, "tokenizer.json");
  if (!existsSync(st) || !existsSync(tj)) { console.warn(`no embedding model in ${MODEL_DIR}: search is BM25 only`); return (model = null); }
  const t0 = performance.now(), tok = JSON.parse(readFileSync(tj, "utf8"));
  const { normalizer: n, pre_tokenizer: pre, model: wp } = tok;
  if (n?.type !== "BertNormalizer" || pre?.type !== "BertPreTokenizer" || wp?.type !== "WordPiece") throw new Error("tokenizer.json is not a BERT WordPiece tokenizer");
  const vocab = new Map<string, number>(Object.entries(wp.vocab as Record<string, number>));
  const added = (tok.added_tokens as { id: number; content: string }[]).filter((a) => a.content);
  const buf = readFileSync(st), hlen = Number(buf.readBigUInt64LE(0)), header = JSON.parse(buf.toString("utf8", 8, 8 + hlen));
  const name = Object.keys(header).find((k) => k !== "__metadata__")!, ten = header[name];
  if (ten.dtype !== "F32" || ten.shape.length !== 2 || ten.shape[0] !== vocab.size) throw new Error(`unexpected tensor ${name}: ${ten.dtype} ${ten.shape}`);
  const off = buf.byteOffset + 8 + hlen + ten.data_offsets[0], len = (ten.data_offsets[1] - ten.data_offsets[0]) / 4;
  const vecs = off % 4 ? new Float32Array(buf.buffer.slice(off, off + len * 4)) : new Float32Array(buf.buffer, off, len);
  // model2vec truncates text to 512 × the median vocab token length (in code points) before tokenizing.
  const lens = [...vocab.keys()].map((k) => [...k].length).sort((a, b) => a - b), mid = lens.length >> 1;
  const median = Math.trunc(lens.length % 2 ? lens[mid] : (lens[mid - 1] + lens[mid]) / 2);
  model = {
    vocab, unk: vocab.get(wp.unk_token) ?? -1, dim: ten.shape[1], vecs,
    added: added.length ? new RegExp(`(${added.map((a) => a.content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "u") : null,
    addedIds: new Map(added.map((a) => [a.content, a.id])),
    clean: n.clean_text !== false, cjk: n.handle_chinese_chars !== false, strip: n.strip_accents ?? n.lowercase !== false, lower: n.lowercase !== false,
    prefix: wp.continuing_subword_prefix ?? "##", maxWord: wp.max_input_chars_per_word ?? 100,
    maxPiece: lens[lens.length - 1], maxChars: MAX_TOKENS * median,
  };
  console.log(`embedding model loaded in ${Math.round(performance.now() - t0)} ms (${vocab.size} × ${model.dim})`);
  return model;
}

function normalize(m: Model, s: string) {
  if (m.clean) s = s.replace(/[\0�]|(?![\t\n\r])\p{C}/gu, "").replace(/\p{White_Space}/gu, " ");
  if (m.cjk) s = s.replace(CJK, " $& ");
  if (m.strip) s = s.normalize("NFD").replace(/\p{Mn}/gu, "");
  // HF lowercases per char, so Σ never becomes the word-final ς that String.toLowerCase would produce.
  return m.lower ? s.replace(/Σ/g, "σ").toLowerCase() : s;
}

function wordpiece(m: Model, word: string, out: number[]) {
  const ch = [...word];
  if (ch.length > m.maxWord) { out.push(m.unk); return; }
  const ids: number[] = [];
  for (let start = 0; start < ch.length;) {
    let end = Math.min(ch.length, start + m.maxPiece), id: number | undefined;
    for (; end > start; end--) if ((id = m.vocab.get((start ? m.prefix : "") + ch.slice(start, end).join(""))) !== undefined) break;
    if (id === undefined) { out.push(m.unk); return; }
    ids.push(id);
    start = end;
  }
  out.push(...ids);
}

export function tokenize(text: string): number[] {
  const m = loadModel();
  if (!m) return [];
  if (text.length > m.maxChars) text = [...text].slice(0, m.maxChars).join("");
  const ids: number[] = [];
  const parts = m.added ? text.split(m.added) : [text];
  parts.forEach((part, i) => {
    if (i % 2) { ids.push(m.addedIds.get(part)!); return; }
    for (const w of normalize(m, part).split(/\p{White_Space}+/u)) for (const p of w.match(PIECES) || []) wordpiece(m, p, ids);
  });
  return ids.filter((id) => id !== m.unk).slice(0, MAX_TOKENS);
}

/** Unit vector for text, or null without a model or without known tokens. Per call: tokenize + one pass over ≤ 512 rows. */
export function embed(text: string): Float32Array | null {
  const m = loadModel(), ids = m ? tokenize(text) : [];
  if (!m || !ids.length) return null;
  const acc = new Float64Array(m.dim);
  for (const id of ids) for (let j = 0, o = id * m.dim; j < m.dim; j++) acc[j] += m.vecs[o + j];
  let sq = 0;
  for (let j = 0; j < m.dim; j++) sq += (acc[j] /= ids.length) ** 2;
  const norm = Math.sqrt(sq) + 1e-32, v = new Float32Array(m.dim);
  for (let j = 0; j < m.dim; j++) v[j] = acc[j] / norm;
  return v;
}

export const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
