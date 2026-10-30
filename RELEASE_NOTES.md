# dsh-plugin-live-shot 0.8.0

**大改：把标注器整个搬进浏览器，砍掉 Electron 桌面运行时，并新增「标注输入框里已有的图」。**

上游 0.7.0-beta.6 是 Windows 桌面版插件：宿主侧起一个 Electron 助手进程，助手截取实时桌面，
在助手自己的窗口里画标注，标完把 PNG 塞回输入框。

0.8.0 面向 **DSH web profile**（纯 Node 宿主）重写：

## Changes

- **纯浏览器端**：截屏走 `getDisplayMedia`，标注走页面里的 canvas。
  不再需要 Electron、`native_picker.cs`、`capture_worker.ps1` 等 40 余个文件，也不再需要本机装 Electron。
  宿主半侧 `index.js` 变成空实现（只为在插件清单里占一行）。
- **新增：标注输入框里已有的图**。插件列出当前草稿里的图片，点一张即可标注，
  保存时「替换原图」——原图摘掉，标注结果顶回原位。
  这是本次大改最核心的能力，上游没有。
- **新增来源**：除屏幕捕获外，还可从剪贴板粘贴或从文件选择。
- **保留**上游的六种绘制语义：矩形、椭圆、箭头、画笔、马赛克、文字；可调颜色与粗细，
  可撤销、清空、复制到剪贴板。
- 标注以图像像素坐标存储，缩放画布不会让记号跑位。
- 界面中英双语，跟随 DSH 的 locale 服务。

## Breaking changes

- 移除了 Windows 全局热键、实时桌面选框、窗口吸附、隐藏 DSH 偏好、PNG 另存为。
  这些依赖 Electron 助手窗口，在纯浏览器里没有等价物。
- 移除了 `dsh-shot install` / `uninstall` 命令与 ZIP/TGZ 发行流程。
  改为把包 `link:` 进 profile 的 `package.json` 并 `pnpm install`。
- `package.json` 的 `os`/`cpu` 限制已移除，现在跨平台可用。

## Install

在 profile 目录（`~/.dsh/profiles/web/`）的 `package.json` 里加两处：

```json
{
  "dependencies": { "dsh-plugin-live-shot": "link:<绝对路径>/plugins/dsh-plugin-live-shot" },
  "dsh": { "profile": { "bundles": ["dsh-plugin-live-shot"] } }
}
```

`pnpm install` 后**重启宿主**（宿主只在启动时加载 bundle）。

## Known limitations

- 只标注图片草稿；非图片附件（PDF、txt）不进列表。
- 「替换原图」是「先加后摘」：新草稿排到最后，摘掉原图后视觉上回到原位，但按 id 严格排序时顺序会变。
- SVG 会被当成图片草稿，标注器把它栅格化后输出 PNG。
- 屏幕捕获要浏览器授权；部分内嵌 webview 没有 `getDisplayMedia`。

## Attribution

本 fork 自 [TangerineSplendor/dsh-plugin-live-shot](https://github.com/TangerineSplendor/dsh-plugin-live-shot)（MIT）。
绘制语义与「标注 → 插回输入框」的交互主线沿用上游设计；实现为本 fork 重写。
