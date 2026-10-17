import { GLYPH_COUNT, glyphFills, glyphFillsForTier, meanFill, glyphTiles, blurredTemplate, downsampleBlurred, gaussianBlur, templateDistance, minPairwiseDistance } from "../../src/facet/glyphs";
import { print } from "./util";

const tiles = [1, 2, 3, 4, 7].flatMap((px) => [4, 8].map((colors) => ({ px, colors, tiles: glyphTiles(px, colors).map((t) => Array.from(t)) })));
const templates = [
  { colors: 4, res: 2, sigma: 0.6, oversample: 8 },
  { colors: 8, res: 4, sigma: 0.45, oversample: 4 },
  { colors: 8, res: 2, sigma: 0, oversample: 4 },
].map((c) => {
  const t = Array.from({ length: GLYPH_COUNT }, (_, s) => blurredTemplate(s, c.colors, c.res, c.sigma, c.oversample));
  return { ...c, templates: t.map((x) => Array.from(x)), minPairwise: minPairwiseDistance(t), d01: templateDistance(t[0]!, t[1]!) };
});
const img = new Float32Array(6 * 5);
for (let i = 0; i < img.length; i++) img[i] = ((i * 37) % 11) / 10;
const blur = Array.from(gaussianBlur(img, 6, 5, 1.2));
const blurSmall = Array.from(gaussianBlur(img, 6, 5, 0.2));
const ds = new Float32Array(8 * 8);
for (let i = 0; i < ds.length; i++) ds[i] = ((i * 13) % 7) / 6;
const down = Array.from(downsampleBlurred(ds, 8, 4, 0.3));
print({
  GLYPH_COUNT,
  fills4: Array.from(glyphFills(4)),
  fills8: Array.from(glyphFills(8)),
  fillsTier: [1, 2, 3].map((t) => Array.from(glyphFillsForTier(t as 1 | 2 | 3)).length),
  meanFill: [4, 8].map((c) => meanFill(c)),
  tiles,
  templates,
  blur,
  blurSmall,
  down,
});
