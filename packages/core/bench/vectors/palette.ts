import { BACKGROUND, WHITE, PALETTE_8, paletteFor, srgbToLinear, linearToSrgb, SRGB_TO_LINEAR_8, encodeLinear8, linear, LINEAR_BACKGROUND, LINEAR_WHITE, excess, paletteExcess, GRAY_RAMP } from "../../src/facet/palette";
import { print } from "./util";

const samples = Array.from({ length: 201 }, (_, i) => i / 200).concat([-0.5, 1.5, 0.04045, 0.0031308, 1e-9]);
print({
  BACKGROUND,
  WHITE,
  PALETTE_8,
  paletteFor: [0, 1, 2, 3].map((t) => paletteFor(t as 0 | 1 | 2 | 3)),
  srgbToLinear: samples.map((v) => srgbToLinear(v)),
  linearToSrgb: samples.map((v) => linearToSrgb(v)),
  SRGB_TO_LINEAR_8: Array.from(SRGB_TO_LINEAR_8),
  encodeLinear8: samples.map((v) => encodeLinear8(v)),
  encodeLinear8Fine: Array.from({ length: 4097 }, (_, i) => encodeLinear8(i / 4096)).join(","),
  linear: PALETTE_8.map((c) => linear(c)),
  LINEAR_BACKGROUND,
  LINEAR_WHITE,
  excess: PALETTE_8.map((c) => excess(c)),
  paletteExcess: [0, 1, 2, 3].map((t) => Array.from(paletteExcess(t as 0 | 1 | 2 | 3))),
  GRAY_RAMP,
});
