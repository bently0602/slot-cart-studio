# HorizonJS runtime

Vendored from [HorizonJS/HorizonJS](https://github.com/HorizonJS/HorizonJS), release
`1.0.0`, commit `06973f7671bc8d318f9ef8d62c8a23a57785d575`.

Archive: [horizonjs-1.0.0.zip](https://github.com/HorizonJS/HorizonJS/releases/download/1.0.0/horizonjs-1.0.0.zip).

Archive SHA-256: `631ee1288d2d03f747d125edc2c9de7553eba067aacd7961ac8aad53689dddb3`.

The runtime exposes the original `Ext` namespace. The studio calls this runtime
Horizon in its UI module. The JavaScript adapter, full library, readable library
source, CSS, and default/gray image assets are copied unchanged from the release.
The upstream license and LGPL/GPL license texts are included alongside them.
Docs, examples, alternative adapters, and unrelated themes are not shipped.

`checksums.json` records the exact included upstream assets. `npm run build`
verifies those files and copies the distribution into `web/vendor/horizonjs`.
That directory is served locally and embedded in both desktop executables; the
application does not load its framework from a CDN. Original copyright headers
remain intact and `ext-all-debug.js` provides the readable distributed source.
