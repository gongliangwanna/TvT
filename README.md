# xinOVO

这是 OVO 的静态网页项目。仓库根目录中的 `index.html` 是小型装配入口，下载仓库后可以直接双击打开，不需要启动开发服务器。

## 修改页面

页面源码位于 `src/html/`，入口模板是 `src/index.template.html`。请修改对应功能片段，不要直接修改生成后的根目录 `index.html`。

```powershell
npm install
npm run build
npm run check
```

`npm run build` 会把 HTML 片段转换为 `js/generated/html/` 下的本地经典脚本，并生成紧凑的根目录入口；还会重新生成需要保持私有作用域的兼容脚本。页面片段会在业务初始化前同步装配，因此不依赖 HTTP 服务或运行时 `fetch()`。`npm run check` 会检查装配后的完整 HTML 结构、重复 ID、本地资源、已移除的登录验证标记和全部 JavaScript 语法。

## JavaScript 结构

- `js/settings/`：聊天设置、API、外观、预设和 TTS。
- `js/modules/chat-ai/`：上下文、请求、回复处理、提示词、Token 统计和通话回复。
- `js/modules/chat-render/`：消息列表、消息气泡、消息操作和图片生成。
- `js/modules/forum/`：账号、帖子、设置、私信和 AI 互动。
- `js/modules/theater/`：剧场数据、编辑、生成、分享和角色剧场。
- `js/modules/tutorial/`：引导、数据工具、备份恢复和 GitHub 备份。
- `js/modules/peek/`：偷看手机的设置、应用渲染、提示词与生成。
- `js/core/`、`js/data/`：公共工具、默认数据和 IndexedDB 持久化。
- `js/group-chat/`、`js/modules/journal/`、`js/modules/worldbook/`：群聊、日记和世界书。
- `src/js/modules/memory-table/`：结构化记忆的可维护源码片段。由于该模块依赖单个 IIFE 的私有状态，构建时会原样拼装为 `js/modules/memory_table.js`。
- `src/js/modules/avatar-recognition/`、`src/js/modules/video-call/`：依赖单个闭包或模块对象的兼容源码片段，构建时原样拼装为对应运行文件。
- `src/js/settings/chat-settings/`：聊天设置大函数的可维护源码片段，构建时原样拼装，避免拆开函数作用域造成回归。

所有运行时脚本仍按原来的经典脚本顺序同步加载，以保持原有全局函数、内联事件和初始化行为。
