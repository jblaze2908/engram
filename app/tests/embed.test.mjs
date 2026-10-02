// Tokenizer and vector parity with the reference model2vec 0.9.0 (Python) output for potion-base-8M. Skips without the model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

process.env.ENGRAM_MODEL_DIR ??= join(new URL("..", import.meta.url).pathname, ".model");
const present = existsSync(join(process.env.ENGRAM_MODEL_DIR, "model.safetensors"));
const { tokenize, embed, dot } = await import("../dist/src/embed.js");

const REF = [
  ["Draft an email in my tone of voice.", [3439, 1025, 9379, 1005, 1032, 3315, 1003, 1382, 18], [-0.12168, 0.11343, -0.10735, -0.07247]],
  // Accents, Greek capital sigma, CJK, every ASCII punctuation class.
  ["Héllo WORLD!! naïve café, Ångström; ΣΟΦΟΣ οδός 東京タワー and don't-stop e-mail@example.com #tag $5+3=8 <ok> ~x|y`z^",
    [6598, 1094, 5, 5, 14749, 6674, 16, 16082, 14693, 31, 179, 28736, 28742, 28736, 28739, 175, 28728, 14303, 885, 761, 715, 29268, 29271, 1004, 1129, 11, 62, 17, 1650, 47, 17, 4659, 36, 1748, 18, 3018, 7, 5421, 8, 25, 15, 23, 33, 28, 32, 6935, 34, 72, 66, 70, 67, 42, 68, 40],
    [-0.00426, -0.21616, -0.40037, -0.13635]],
  // Unknown pieces, literal special tokens ([UNK] dropped, others kept), control and odd whitespace characters.
  ["xqzvbnmkl supercalifragilisticexpialidocious [CLS] tokens [UNK] [MASK]\tand nbsp em​zero\u0000null",
    [66, 3166, 1486, 25499, 1084, 1219, 1249, 1146, 2571, 8295, 9134, 28187, 23417, 3594, 9294, 18318, 20279, 9091, 5319, 2, 18210, 1021, 4, 1004, 56, 4916, 1367, 6867, 5296, 1245, 17089],
    [0.04412, -0.14608, -0.29049, -0.32101]],
];

test("token ids and vectors match model2vec", { skip: !present && "no model (scripts/fetch-model.sh)" }, () => {
  for (const [s, ids, head] of REF) {
    assert.deepEqual(tokenize(s), ids, s);
    const v = embed(s);
    assert.ok(Math.abs(dot(v, v) - 1) < 1e-5, "unit length");
    head.forEach((x, i) => assert.ok(Math.abs(v[i] - x) < 1e-4, `${s} dim ${i}: ${v[i]} vs ${x}`));
  }
  assert.equal(tokenize(" ".repeat(10) + "word ".repeat(2000)).length, 512, "512-token cap");
  assert.equal(embed("!!! ???")?.length, 256);
  assert.equal(embed(""), null);
});
