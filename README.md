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
- **验证方式**：仓库提供完整源码、产品截图、演示视频和可复现的本地启动步骤；所有配置与生成历史默认保存在本机。

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

双击仓库根目录的 `start.bat`。电脑需要先安装 Node.js LTS（Node.js 20.19+ 或 22.12+）。启动器会刷新系统 PATH，并识别官方安装、NVM、Volta、Scoop、fnm、注册表和常见安装目录：

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

1. 打开右上角配置，添加 API 地址和 API Key。
2. 为渠道拉取或手动添加模型，并设置图片、视频、文本或音频能力。
3. 新建画布，将提示词、参考图和生成节点组织到同一工作区。
4. 主页提示词库的内置封面位于 `web/public/prompt-covers`，卡片右上角可以随时替换。

所有配置、画布、资产和生成记录默认保存在当前浏览器本地。浏览器数据按网址来源隔离，因此不同磁盘目录只要都使用 `http://localhost:3000`，就会读取同一份本地配置。API Key 不会提交到仓库；分享导出的配置或截图前仍应检查敏感信息。

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

任务完成或取消后会清理临时图片文件。Codex OAuth 状态由服务器端 Codex CLI 的 `CODEX_HOME` 持久化，浏览器端不需要配置 API Key。

远程服务器部署需要 Node.js、Codex CLI 和持久化的 `CODEX_HOME`：

```bash
cd web
npm install --legacy-peer-deps --include=optional
npm run build
CODEX_HOME=/var/lib/infinite-atelier/codex npm start
```

`npm start` 会通过 `vite preview` 同时提供构建后的页面和 `/api/codex-subscription` 接口，并监听 `0.0.0.0:3000`。用户在远程页面点击“连接 ChatGPT”后，在自己的浏览器完成 OAuth；登录状态保存在远程服务器的 `CODEX_HOME`。远程主机必须能直接执行 `codex`，且应使用 HTTPS 和持久化磁盘。

当前远程模式按单用户实例设计，接口本身不提供多用户权限隔离；请将站点放在 VPN、访问控制或反向代理认证之后，不要直接暴露到公网。

## Docker 部署（Codex 订阅）

Docker 镜像会同时包含构建后的 Infinite Atelier、Codex CLI 和订阅生图接口。Compose 服务名为 `atelier`，默认只绑定到本机的 `127.0.0.1:3000`，Codex 登录状态保存在命名卷 `codex-data` 中。

### 本地构建与启动

在仓库根目录执行：

```bash
docker compose build
docker compose up -d
docker compose logs -f atelier
```

打开 `http://127.0.0.1:3000` 后，在应用配置 → 渠道 → Codex 订阅中点击“连接 ChatGPT”，通过页面完成首次登录。浏览器不需要填写 ChatGPT OAuth token 或 API key；登录凭据由容器内的 Codex CLI 使用 `CODEX_HOME=/data/codex` 管理。

常用生命周期操作：

```bash
docker compose down       # 停止并移除容器，保留 codex-data
docker compose up -d      # 使用现有卷重新启动
docker compose down -v    # 同时删除 codex-data，故意重置登录状态
```

升级镜像或重新构建时，先执行 `docker compose pull`（使用远程镜像）或 `docker compose build`（从源码构建），再执行 `docker compose up -d`。只要不使用 `down -v`，`codex-data` 会保留 OAuth 状态；升级前也应按需备份该卷。`docker compose down -v` 是不可逆的登录状态重置操作，之后需要再次通过页面连接 ChatGPT。

Compose 支持以下环境变量：

```bash
IMAGE_TAG=latest \
ATELIER_IMAGE=ghcr.io/kirito718/infinite-atelier \
ATELIER_BIND_ADDRESS=127.0.0.1 \
docker compose up -d
```

`IMAGE_TAG` 默认是 `latest`，`ATELIER_IMAGE` 默认是 `ghcr.io/kirito718/infinite-atelier`，`ATELIER_BIND_ADDRESS` 默认是 `127.0.0.1`；端口默认是 `3000`。除非已经配置受保护的 HTTPS 反向代理或 VPN，否则请保持 `ATELIER_BIND_ADDRESS=127.0.0.1`，不要将容器端口直接暴露到公网。该部署按单用户实例设计，不提供多用户账号、权限隔离或租户边界。

### 从 GHCR 使用预构建镜像

不需要本地构建时，可以指定 GitHub Container Registry 镜像并启动：

```bash
IMAGE_TAG=latest \
ATELIER_IMAGE=ghcr.io/kirito718/infinite-atelier \
docker compose pull atelier
IMAGE_TAG=latest \
ATELIER_IMAGE=ghcr.io/kirito718/infinite-atelier \
docker compose up -d atelier
```

GHCR 发布的镜像提供 `linux/amd64` 和 `linux/arm64` 多架构变体，Docker 会按主机架构选择对应镜像。版本标签也可以通过 `IMAGE_TAG` 指定；升级时保留 `codex-data`，以继续使用已有登录状态。

GitHub Actions 只负责测试、构建和发布镜像：CI 不执行真实的 ChatGPT OAuth 登录，也不执行真实图片生成。首次登录和生图验证必须在部署后的应用页面中由用户完成。

Docker 运行方式仍受同样的安全边界约束：若需要从其他设备访问，请让 Docker 继续监听回环地址，并在 VPN 或带认证的 HTTPS 反向代理后提供访问；不要把未保护的 HTTP 端口直接发布到公网。

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
