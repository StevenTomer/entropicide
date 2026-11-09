# Barcode reader

For browsers without a barcode reader of their own (desktop Chrome on Linux, Firefox), the
Inventory page's scanner uses this: barcode-detector 3.2.3 (MIT) with the zxing-wasm 3.1.6
reader (MIT; ZXing-C++ inside is Apache-2.0). `zxing_reader.wasm` is loaded from here, never
from a CDN (static/inventory.js sets where). Rebuild in a scratch directory:

    npm install barcode-detector@3.2.3 esbuild
    npx esbuild entry.js --bundle --format=esm --minify --outfile=barcode.js

and copy `node_modules/zxing-wasm/dist/reader/zxing_reader.wasm` here.
