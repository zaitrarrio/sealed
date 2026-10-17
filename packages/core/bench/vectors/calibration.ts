import { RAMP_PATCH, calibrationLayout } from "../../src/facet/layout";
import { b64, print } from "./util";

const tier = Number(process.argv[2] ?? "1") as 1 | 2 | 3;
const cal = calibrationLayout(tier);
print({ RAMP_PATCH, symbols: b64(cal.symbols), ramp: b64(cal.ramp), rampCenters: cal.rampCenters });
