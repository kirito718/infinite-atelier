<p align="center">
  <img src="web/public/brand-logo.png" width="112" alt="Infinite Atelier logo">
</p>

<h1 align="center">Infinite Atelier</h1>

<p align="center">为桌面创作而生的 AI 视觉工作台</p>

Infinite Atelier 将画布编排、图片生成、参考图、提示词、资产管理和导演预演放在一个连贯的桌面工作流中。项目由 `GuiYi-Xi` 独立维护，界面、品牌与内置提示词库围绕高效视觉创作重新设计。

## 产品概览

- **用户问题**：创作者需要在模型配置、提示词、参考图、生成结果和本地素材之间频繁切换，长任务状态与失败恢复也缺少统一入口。
- **产品方案**：以无限画布为主工作区，将 Provider 配置、生成节点、提示词库、本地资产和导演预演组织成连续流程。
- **我的工作**：负责场景梳理、功能规划、交互与视觉设计、前端实现、模型接口封装、Windows 启动流程、测试和使用文档。
- **验证方式**：仓库提供完整源码、产品截图、演示视频和可复现的本地启动步骤；账号数据与生成历史持久化保存在部署服务器。

这个项目展示的是模型能力从 API 到用户产品的封装实践，不涉及 GPU 集群或企业级模型托管部署。

## 功能

- 无限创作画布：组织图片、文字、音频、视频和生成结果。
- 多渠道模型：配置 OpenAI 兼容接口及自定义中转 API。
- 图片生成：支持 GPT Image 2 等模型的文生图、图生图与多图参考。
- 提示词库：内置 12 组带展示图的提示词，可复制、收藏、替换封面或新增条目。
- 视觉资产：保存生成结果与素材，支持导入、导出和本地备份。
- 导演台：内置 MONOFORM 预演工具，用于镜头、角色和动作设计。
- 品牌主页：五套整体配色、动态品牌背景与最近项目入口。

## 演示与导演台

- [观看 Infinite Atelier 项目演示视频（MP4，约 63 MB）](https://github.com/GuiYi-Xi/infinite-atelier/releases/download/v1.0.0/Infinite-Atelier-Demo.mp4)
- [MONOFORM 素形白模预演工作台源码](https://github.com/GuiYi-Xi/monoform-previs-studio)
- [导演台使用教程（哔哩哔哩）](https://www.bilibili.com/video/BV1HNud6SEgs/)

## Windows 启动

双击仓库根目录的 `start.bat`。电脑需要先安装 Node.js LTS（Node.js 22.12+，推荐当前 LTS）。启动器会刷新系统 PATH，并识别官方安装、NVM、Volta、Scoop、fnm、注册表和常见安装目录：

[下载 Node.js LTS](https://nodejs.org/en/download)

启动脚本会自动安装依赖，并从 `3000` 开始选择可用端口启动：

```text
http://localhost:3000
```

也可以手动运行：

```powershell
cd web
npm install --legacy-peer-deps --include=optional
npm run dev
```

`start.bat` 会校验 Vite 及其 Windows 原生模块；依赖不完整时会自动补装。

如果安装 Node.js 后仍提示找不到，请先重启 Windows（或注销后重新登录），然后再次运行 `start.bat`。启动器不会自动重复打开 Node.js 下载页面。

首次启动会在 `web/node_modules` 安装前端依赖，因此本地目录会增加数万个文件和约数百 MB 占用。该目录已被 Git 忽略，不会上传到仓库。

## 生产构建

```powershell
cd web
npm run typecheck
npm run build:monoform
npm run build
```

构建结果位于 `web/dist`。

## 使用说明

1. 注册或登录账号；打开右上角配置，添加 API 地址和 API Key。
2. 为渠道拉取或手动添加模型，并设置图片、视频、文本或音频能力。
3. 新建画布，将提示词、参考图和生成节点组织到同一工作区。
4. 主页提示词库的内置封面位于 `web/public/prompt-covers`，卡片右上角可以随时替换。

账号登录后，画布、素材、生成历史、提示词封面、渠道配置及导演台工程保存在服务器 SQLite / 文件目录中，并按账号隔离。浏览器仅保留主题、语言、布局等设备偏好；API Key 不再写入浏览器存储。分享导出的配置或备份前仍须检查敏感信息。

首次进入时需注册账号；第一个账号始终允许注册，后续默认关闭注册。管理员可按下节临时开放。旧版本用户登录后会看到浏览器数据迁移提示：只有确认后才导入空账号，不删除 IndexedDB / localStorage 原件。迁移只能访问当前域名、端口和浏览器的旧数据，其他地址的数据需先在那里导出备份。

### 用户与持久化配置

在 `web` 目录复制 `.env.example` 为 `.env` 后启动（生产和开发均生效）：

```bash
cp .env.example .env
npm install --legacy-peer-deps --include=optional
npm run build:all
npm start
```

- 默认数据目录：`web/data`。可用绝对路径 `ATELIER_DATA_DIR=/var/lib/infinite-atelier` 指定持久磁盘。
- 数据目录包含 `atelier.sqlite`（及 WAL/SHM）、`encryption.key`、`uploads/<user-id>/`、`codex/<user-id>/`。**必须备份和恢复整个目录**，不能只保存 SQLite 或只保存 Codex home。
- `ATELIER_ALLOW_REGISTRATION=true` 开放额外账号注册，注册完可改回 `false` 并重启。没有默认密码；用户名 3–40 位字母/数字/`_.-`，密码 10–128 字符。
- 密码使用随机盐 scrypt 哈希；服务端文档使用 AES-256-GCM 加密；会话使用 HttpOnly / SameSite Cookie，数据库仅存令牌摘要。修改密码会撤销旧会话。
- API Key 为兼容用户自带模型渠道，只会向已登录的所属用户解密到页面内存；不保存到浏览器磁盘。导出的配置/备份仍可能包含明文 Key。
- 远程反向代理必须使用 HTTPS，并设置 `ATELIER_PUBLIC_URL=https://实际域名`（无路径），自动启用 Secure Cookie。不要信任客户端提供的转发标头来决定认证来源。
- 单个媒体默认限 100 MiB，每账号媒体配额 2 GiB；可用示例环境变量调整。文档上限每份 20 MiB，总加密文档 128 MiB。HTML/SVG 等主动内容不能当作上传媒体。
- 外部模型请求在生产环境也走同源代理；代理不转发应用 Cookie。默认阻止内网/回环目标；确需访问自托管模型时才设置 `ATELIER_ALLOW_PRIVATE_UPSTREAMS=true`，并仅向可信用户开放账号。

顶栏显示保存状态，账号菜单可再次打开浏览器旧数据迁移；网络错误会保留本页待保存数据并重试。多页面编辑发生版本冲突时不会自动覆盖，请先导出主应用草稿，再刷新。离开页面、退出账号会等待主应用及内嵌导演台保存。会话过期时，待保存草稿按账号保留在本标签页内存，重新登录原账号可恢复；如果服务端已有更新则保留冲突，不自动覆盖。离线/恢复草稿仍依赖当前页面内存，服务器只有确认成功的版本；不要强制关闭有未保存提示的页面。

配置 → 备份可导出服务器媒体、当前主应用草稿和最后保存的导演台文档；恢复兼容旧版 ZIP，媒体使用新标识，文档通过事务与版本校验提交。导演台有未保存冲突时请另行使用其工程导出。为避免破坏其他画布、历史或标签页引用，删除项目/素材不会自动物理清理共享媒体。

### Docker 单机部署

```bash
# 在仓库根目录执行；可复制 web/.env.example 为根目录 .env 来配置 Compose
# 默认仅监听宿主机 127.0.0.1，使用反向代理提供 HTTPS
docker compose up -d --build
docker compose logs -f atelier
```

`atelier-data` 命名卷挂载到 `/data`，容器重建/升级会保留账号和内容。镜像以非 root 用户运行，包含当前固定版本的 Codex CLI。**不要运行 `docker compose down -v`，这会删除数据卷。** 服务启动前会拒绝位于 `web/public`、构建后的 `dist` 或指向它们的符号链接下的数据目录。

一致备份：停止应用（`docker compose stop atelier`），将完整 `/data` 复制或归档到受限备份目录，再启动应用。恢复时先停止服务并备份现有目录，然后恢复与数据库配对的密钥、媒体和 Codex 子目录，确保容器用户 UID 1000 可读写，再启动。不要在服务运行时只复制 SQLite 主文件；WAL 中可能仍有已提交数据。备份包含用户内容和凭据，应设置访问权限并加密保存。丢失加密密钥无法解密数据库，服务会拒绝使用错误的新密钥。

## Codex 订阅生图（本地与远程）

Codex 订阅渠道只负责图片生成与编辑，视频仍使用你配置的视频服务商。Infinite Atelier 后端在同一个 Vite 进程内管理 Codex App Server，浏览器只访问同源 `/api/codex-subscription`，不会连接额外的 loopback Bridge，也不会保存或读取 ChatGPT OAuth 凭据。

本地开发在 `web` 目录运行：

```bash
npm install --legacy-peer-deps --include=optional
npm run dev:atelier
```

然后打开配置 → 渠道 → Codex 订阅：

1. 点击“连接 ChatGPT”并完成官方登录。
2. 选择 `gpt-image-2`，创建一个图片节点，先测试纯提示词生图。
3. 再连接一张参考图测试图片编辑，并确认结果同时出现在画布和素材库。
4. 创建视频节点，确认它仍使用已配置的视频渠道；Codex 订阅不会出现在视频模型选择中。
5. 点击“断开连接”，确认普通 API 渠道仍可使用。
6. 如需检查凭据边界，可查看浏览器 `localStorage` 与 IndexedDB：其中不应出现 ChatGPT OAuth token。

任务完成或取消后会清理临时图片文件。Codex OAuth 状态由每个用户独立的服务器端 `CODEX_HOME` 持久化，浏览器端不需要配置 API Key。

远程服务器部署需要 Node.js 22.12+、Codex CLI 和持久化的数据目录：

```bash
cd web
npm install --legacy-peer-deps --include=optional
npm run build
ATELIER_DATA_DIR=/var/lib/infinite-atelier npm start
```

`npm start` 会通过 `vite preview` 同时提供构建后的页面和 `/api/codex-subscription` 接口，并监听 `0.0.0.0:3000`。用户在远程页面点击“连接 ChatGPT”后，在自己的浏览器完成 OAuth；登录状态保存在数据目录的 `codex/<user-id>`。应用不会复用主机上全局的 Codex 登录状态；升级后请在当前应用账号内重新连接 ChatGPT。远程主机必须能直接执行 `codex`，且应使用 HTTPS 和持久化磁盘。

当前模式支持单机内多账号隔离，但不支持多副本共享 SQLite 或多人同时编辑同一项目。请在 HTTPS 反向代理后部署，限制公开注册并定期备份。Codex client/任务和文件目录按用户独立；同时驻留连接上限为 16，达到上限需重启实例释放连接。

**Codex 信任边界：** Codex CLI 是可执行工具的服务端进程，按账号目录/API 分隔不等于操作系统级隔离。只向可信账号开放此实例；互不信任的用户应使用独立容器/实例和数据卷，不应把此单机部署当作对抗性多租户平台。自定义模型脚本也只应运行可信内容；它们不是隔离的不可信代码沙箱。

## 目录

```text
Infinite Atelier
├─ start.bat                 Windows 启动器
├─ web/src                   主应用源码
├─ web/public                品牌与提示词图片资源
├─ web/monoform-studio       内嵌导演预演工具
└─ LICENSE                   开源许可证
```

## 维护者

[GuiYi-Xi](https://github.com/GuiYi-Xi)

## License

代码许可见 [LICENSE](LICENSE)。

## 验证

```bash
cd web
npm test                  # 前端、账号/存储 HTTP、Codex 和导演台存储测试
npm run typecheck
npm run build:all
```

测试使用临时目录和模拟上游，不执行真实 ChatGPT OAuth 或生图。
