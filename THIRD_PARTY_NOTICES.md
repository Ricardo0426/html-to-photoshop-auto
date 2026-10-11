# Third-party notices

The browser DOM capture originated in Kevin Bryan's [Open HTML to Figma](https://github.com/kevicebryan/open-htmltofigma), commit `889cd39cb708a00f1a873a9ad907b56b92113218`, under MIT. The original license and copyright are retained in LICENSE. The resource and automatic sizing modules are shared with the separate HTML to Figma importer.

This Photoshop importer uses:

- ag-psd, MIT — layered Photoshop PSD serialization and native text EngineData.
- pngjs, MIT — PNG decoding.
- fflate, MIT — CCX archive packaging.
- Playwright, Apache-2.0 — local Chromium automation. Installed browser software has its own license.

Dependency license files are included in the complete package's node_modules. Fonts and images are read from user-selected projects or installed Photoshop fonts; this plugin does not distribute those fonts or source images.
