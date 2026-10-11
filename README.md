# HTML → Photoshop 自动分组导入

面向 **Photoshop 2025（26.x）** 的 UXP 插件。选择本地 HTML 项目文件夹，手动勾选首页或二级页面，自动识别尺寸，批量生成分层 PSD 并在 Photoshop 中打开。

![插件界面预览](docs/ui-preview.png)

界面预览（通用示例；浏览器中模拟 UXP 与渲染服务状态，用于展示面板交互，不代表原生安装验证，不含用户测试文件）。

每个 HTML 对应一个独立 PSD，使用普通图层组。普通文字保留为原生可编辑文字，图片、背景和装饰分别成层；SVG 外观转换为独立像素图层。

## 安装

从 GitHub Releases 下载完整安装包并解压到固定目录。安装包包含 UXP 面板、本地渲染服务及 npm 依赖，不含源 HTML、用户素材或示例 PSD。

1. 安装 Node.js 20 或更新版本，以及 Chrome 或 Edge。
2. 使用 Adobe 官方的 **UXP Developer Tool**，点击 Add Plugin，选择 `plugin/manifest.json`，再点击 Load。开发模式可能需要在 Photoshop 设置中开启。
3. 也可尝试双击 `HTML自动分层导入-v0.1.0.ccx`，由 Adobe 安装器安装；本地开发 CCX 是否受支持取决于安装器版本，尚未完成原生安装验证。
4. 双击 **启动渲染服务.cmd**，保持服务窗口运行。
5. 在 Photoshop 的“插件”菜单中打开 **HTML 自动分组导入**，确认显示“渲染服务已连接”。

本地服务默认监听 `127.0.0.1:38417`。没有 Chrome/Edge 时，可以在解压目录运行 `npx playwright install chromium`。如果 npm 依赖目录丢失，启动脚本会尝试执行 `npm ci --omit=dev`。

## 使用

1. 选择完整的 HTML 项目文件夹，包括 HTML、CSS、图片和字体。
2. 勾选需要导入的页面。仅导入二级页面时，点“全不选”，再手动勾选子文件夹中的 HTML。
3. 选择 PSD 保存文件夹。
4. 点击“导入选中的页面”。默认完成后在 Photoshop 打开 PSD，也可关闭自动打开。

页面尺寸自动推断；响应式页面默认使用 1440 × 900 视口排版，然后测量完整内容高度。固定宽度长页保留实际高度，明确的海报设计区域按其设计尺寸导出。高级设置可调整默认视口，或为可信页面开启脚本执行，例如使用 Tailwind CDN 的页面。

每批输出到新的 `HTML导入-时间-标识` 子文件夹，避免覆盖已有 PSD。文件名包含相对页面路径及短标识，重名 HTML 不会相互覆盖。输出文件夹附有 `导入报告.json`。

页面失败会记录原因，其余页面继续生成。取消后保留已完成的 PSD，停止当前及剩余任务。需要继续时重新勾选页面导入。

转换在本机进行。源 HTML 引用的远程资源，以及主动开启的页面脚本，会按源文件访问网络。

## 可编辑性与限制

- 普通文字使用 Photoshop 文字图层，包含字体、字号、颜色、字距和换行等信息。
- 浏览器能加载 WOFF/WOFF2 不代表 Photoshop 已安装该字体。插件读取 Photoshop 字体清单，缺少字体时使用替代字体并报告。
- 图片、背景、边框和 SVG 外观使用独立透明像素图层，可分别移动或替换。
- 结构容器使用图层组，普通圆角裁切使用矢量蒙版，支持的阴影保留为原生图层效果。
- 渐变文字保留像素预览，编辑原生文字后使用基础颜色，并在报告中提示。复杂滤镜、3D 和特殊混合等效果可能简化。
- Photoshop 重新排版文字后，行距、换行及抗锯齿可能与浏览器不同。
- PSD 单边上限为 30000 px，总计上限为 8000 万像素；超过时会报错，需要拆分页面。
- 支持可在浏览器中直接渲染的 HTML。不执行 React/Vue 项目构建，不持续监控目录，不自动沿链接抓取页面。

## 验证状态

开发阶段在 Photoshop 2025 中实际打开了 4 份生成的 PSD，并逐个修改了 40 个文字图层，均通过可编辑性检查。相关用户素材、PSD、截图和本机验证报告均未公开。

这项验证覆盖转换出的 PSD 文件。UXP 面板安装、加载和完整原生交互流程仍待验证；面板接口已通过模拟 UXP/Photoshop 和浏览器检查。

## 源码开发

```sh
npm ci
npm run build
npm start
```

构建在 `dist/` 生成 CCX，不自动安装或发布。源码安装依赖后可直接以 `plugin/manifest.json` 加载面板。依赖固定在 `package-lock.json`。

| 目录或文件 | 作用 |
| --- | --- |
| `plugin/` | UXP 面板、manifest 与交互逻辑 |
| `src/server.mjs` | 本地服务、文件发现、任务队列和输出管理 |
| `src/renderer.mjs` | Chromium 渲染、自动尺寸与图层捕获 |
| `src/psd-writer.mjs` | PSD 分组、文字、像素、蒙版和效果 |
| `shared/` | 资源路径解析、自动尺寸和 DOM 捕获 |
| `scripts/build.mjs` | CCX 打包 |

## 许可

MIT。DOM 捕获部分来源于 Kevin Bryan 的 [Open HTML to Figma](https://github.com/kevicebryan/open-htmltofigma)，保留原许可与版权声明。依赖许可详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
