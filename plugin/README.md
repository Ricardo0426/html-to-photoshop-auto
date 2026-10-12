# Photoshop UXP panel

The panel is the UI only: it scans the chosen folder, lets you tick pages, and talks to the local rendering service over `http://127.0.0.1:38417`. All layout work and PSD generation happens in that service, so it has to be running.

## Install (normal users)

Do not load this folder by hand. From the package root, double-click **安装插件.cmd**. It copies `plugin/` to the per-user UXP plugin folder:

```
%APPDATA%\Adobe\UXP\Plugins\External\HTML自动分组导入_v0.1.0
```

Then fully quit and reopen Photoshop and pick **增效工具 → HTML 自动分组导入**. No administrator rights and no UXP Developer Tool are needed. Run **卸载插件.cmd** to remove it.

The folder name is what UXP logs as `upic::Loading plugins from user fallback plugins folder`.

## Install (development)

To iterate on the panel source, point Adobe **UXP Developer Tool** at `manifest.json` in this folder and use Load / Reload. That path is for development only and is not what the release instructions use.

## Requirements

- `host.minVersion` is `23.3.0` — Photoshop 2022 (23.3) or later. 23.3 is the floor for `manifestVersion: 5` and `apiVersion: 2`.
- `requiredPermissions.network.domains` must stay `"all"`. A concrete origin with a port (for example `http://127.0.0.1:38417`) fails with `Permission denied to the url ... Manifest entry not found`, so the request never leaves UXP.
- `host.data.loadEvent` must stay `"use"`.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | UXP manifest: id, host version range, permissions, panel entrypoint |
| `index.html` | Panel markup |
| `style.css` | Panel styling |
| `main.js` | Folder/file pickers, scan, job polling, Photoshop document opening |
