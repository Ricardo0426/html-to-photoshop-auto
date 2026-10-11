# 更新记录

## 未发布

修复面板在真实 Photoshop 中无法连接本地渲染服务的问题（此前该链路未做过原生验证）。

- 修复面板请求发不出 UXP：`requiredPermissions.network.domains` 改为 `"all"`。写成 `["http://127.0.0.1:38417"]` 会报 `Permission denied to the url ... Manifest entry not found.`，面板表现为“无法连接渲染服务”。
- 修复本地服务拒绝面板请求：Origin 白名单原来只放行 `uxp://`，而 UXP 面板页面的真实来源是 `plugin://`，会被 403 拒绝；同时 403 在设置 `Access-Control-Allow-Origin` 之前返回，响应不带 CORS 头，浏览器直接拦截，导致报错完全无法定位。现改为只拒绝 http/https 网页来源，并把 CORS 头移到校验之前。
- 修复 `启动渲染服务.cmd` 在中文 Windows 下满屏“不是内部或外部命令”：批处理改为 GBK 编码 + CRLF 行尾（cmd.exe 按 OEM 码页解析文件，`chcp` 改不了），并增加 Node.js 路径兜底探测。
- 面板安装改为普通插件方式：新增 `安装插件.cmd` / `卸载插件.cmd`，复制到用户级 UXP 插件目录，不需要管理员权限，也不需要 UXP Developer Tool 和开发者模式。
- `plugin/main.js` 增加连接诊断日志，失败时输出请求地址和具体原因。

## 0.1.0

- Photoshop 2025 UXP 面板及本地 Chromium 渲染服务。
- 自动识别页面尺寸，按完整内容高度生成 PSD。
- 文件夹扫描和批量导入，支持手动选择二级页面。
- 普通图层组、可编辑文字、独立图片与装饰图层。
- 资源路径解析、字体替代提示、任务进度、取消及导入报告。
- 提供 CCX 构建及本地启动脚本。
