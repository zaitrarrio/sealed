/**
 * Node ESM resolve hook for the e2e harness only. @sealed/core imports `qrcode/lib/core/qrcode` without a file
 * extension (fine for bundlers, rejected by Node's ESM resolver). Playwright loads core in Node to generate
 * Facet frames, so this hook retries such CommonJS deep imports with ".js".
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (e && e.code === "ERR_MODULE_NOT_FOUND" && /^qrcode\/lib\//.test(specifier) && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    throw e;
  }
}
