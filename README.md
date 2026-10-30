# dsh-plugin-live-shot

DeepSeek Harness 的**图片标注**插件：给输入框里已有的截图加记号，或者新建一张标注后再放回输入框。

> 本仓库 fork 自 [TangerineSplendor/dsh-plugin-live-shot](https://github.com/TangerineSplendor/dsh-plugin-live-shot)（MIT）。
> 原版是 Windows 桌面版插件，靠 Electron 助手进程截取实时桌面并在助手窗口里画标注。
> **本 fork 把它整个搬进浏览器**：DSH 的 web profile 是纯 Node 宿主，没有 Electron，
> 所以截屏与标注都改由页面里的 canvas 完成，插件不再需要任何桌面运行时。

## 它做什么

- **标注输入框里已有的图**：点开插件 → 列出输入框草稿里的图片 → 点一张 → 在标注器里画 → 「替换原图」。
- **新建一张**：截屏（浏览器屏幕捕获 API）、从剪贴板粘贴、或者从文件里选一张，标注后「加入输入框」。
- **工具**：矩形、椭圆、箭头、画笔、马赛克、文字；可调颜色与粗细，可撤销、可清空、可复制到剪贴板。

标注以**图像像素坐标**保存，所以缩放画布不会让记号跑位。

## 与原版的差异

| | 原版（0.7.0-beta.x） | 本 fork（0.8.0） |
|---|---|---|
| 运行时 | 需要 Windows 桌面版 Electron + 本地辅助进程 | 纯浏览器，DSH web / 桌面版都能用 |
| 截图来源 | 实时桌面（自绘选框、窗口吸附） | 浏览器屏幕捕获、剪贴板、文件 |
| 标注对象 | 只有刚截下来的那一张 | **输入框里已有的任意一张**，或新图 |
| 宿主侧 | `index.js` 起一个 `OverlayHelper` 守护进程 | `index.js` 是空的 |
| 文件数 | ~50 个（大量 `.cs` / `.ps1` / Electron 胶水） | 6 个 |

保留下来的：矩形/椭圆/箭头/画笔/马赛克/文字这六种绘制语义（与原版逐一对齐）、标注→插回输入框的交互主线、以及 MIT 许可与上游署名。

## 安装

在 profile 目录（`~/.dsh/profiles/web/`）的 `package.json` 里加两处：

```json
{
  "dependencies": {
    "dsh-plugin-live-shot": "link:<绝对路径>/plugins/dsh-plugin-live-shot"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-plugin-live-shot"]
    }
  }
}
```

然后 `pnpm install`，**重启宿主**。宿主侧只在启动时加载 bundle，刷新页面不够。

## 实现要点

### 接线到运行时

插件是**纯前端 bundle**：宿主半侧 `index.js` 什么都没有，只为在插件清单里占一行（带自己的标题、描述、图标）。

浏览器半侧 `client.js` 用 `window.__ModuleLoader__.load({ id, factory })` 注册一个工厂，
工厂返回 `{ inject, apply }`。它挂在输入框左边的座位上：

```js
ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
  name: 'conversation.input.left',
  id: 'dsh-shot',
  order: 20,
  locale: NS,
  inject: () => ({ getConversation: () => ctx.get('conversation') })
}, ShotButton))
```

`conversation.input.left` 是 session-scope 座位，标准 props 里带 `useInput`、`inputActions`、`sessionId`。

### 读写输入框里的附件

草稿里的图片由 Conversation 服务持有，插件通过标准的 `ctx.get('conversation')` 拿到它：

- **读**：`conversation.resolveDraftAttachments(inputState.attachmentIds)` 拿到 `{ id, kind, file, previewUrl }` 列表。
- **写**：`conversation.createDrafts(sessionId, files, true)` 造出新草稿，
  再 `inputActions.addAttachments(drafts.map(d => d.id))` 挂到输入框上。
  挂不上去时用 `conversation.releaseDraftAttachments(drafts)` 回滚，避免留下野草稿。
- **替换**：先加新草稿，再 `inputActions.removeAttachment(oldId)` 把原图摘掉，标注结果就顶上了原位。

> `createDrafts` 的第三个参数 `uploadImages` 是必填的：普通会话传 `true`（图片走上传通道），
> 子代理续写传 `false`（图片随 prompt 内联）。原版 moodboard-wall 只传了两个参数，
> 那个位置等价于 `false`，普通会话下图片不会立刻上传——这里显式传 `true`。

### 绘制引擎

引擎在 `annotator.js` 里是一个普通 ES 模块（便于单测），但**同一份实现内联在 `client.js` 里**。
原因是插件的 `client.js` 是**原样服务的裸脚本**：拆成第二个文件需要包内的 chunk 路由
（`client.<name>.js`，见 `dsh-client-modules` 的 chunk 规则），而那只由打包器产出。
内联让这个插件保持「一个 `client.js` 就能跑」的形态。

绘制模型沿用原版：一个**基础位图** + 一串**图元操作**，每次重放。
操作存图像像素坐标，因此换分辨率时按比例缩放即可。

### 截屏

用浏览器的 `getDisplayMedia`，取一帧画进 canvas 再转 PNG。
这条路径不需要权限插件，也不需要本地进程；浏览器会自己弹「选择共享窗口」的提示。

## 已知边界

- **只标注图片草稿**：输入框里的非图片附件（PDF、txt）不进列表。
- **替换是「先加后摘」**：标注结果在草稿里排到最后，摘掉原图后视觉上回到原位，但严格按 id 排序时顺序会变。
- **SVG 会被当成图片草稿**，但标注器把它栅格化后输出 PNG。
- **屏幕捕获要浏览器授权**，且部分环境（如某些内嵌 webview）没有 `getDisplayMedia`。
- **中文界面**：界面文案走 `ctx.locale`，中英双语，跟随 DSH 当前语言。

## 相关

- 座位与 slots：`@deepseek-ai/dsh-client-ui-slots`
- 输入框与草稿附件：`@deepseek-ai/dsh-client-ui-conversation`
- 附件呈现：`@deepseek-ai/dsh-client-ui-attachment`
- 同类思路参考：`dsh-moodboard-wall`（本机的灵感墙插件，也是纯前端 + 往输入框送图）

## License

MIT。上游作者 TangerineSplendor，本 fork 作者 banyeshuiwujiao。
