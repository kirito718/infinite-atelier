# 导演台真人图生成与 ComfyUI 部署

## 链路与边界

```text
浏览器：Director → MONOFORM 当前镜头/当前帧 → 1024×1024 Pose + Depth
      → 同源 /api/comfyui/jobs → Atelier 服务端 → 私网 ComfyUI
      ← 任务进度 / 任务专属 PNG ← 工作流输出
      → 所属账号的服务端媒体保存 → 导演节点旁的 Image 节点
```

- MONOFORM 负责摆人物、OpenPose 身体骨架图和线性灰度 Depth；两张图使用相同相机和尺寸。
- 导演台中的提示词随节点保存；生成按钮会锁定重复提交，支持取消、错误说明和重新生成。关闭导演台不丢失正在执行的任务；删除相关节点或离开画布会请求取消。
- 浏览器只访问 Atelier 的同源路由，不能设置上游地址，也不接收上游凭据。
- 所有 `/api/comfyui/*` 经过应用登录认证，创建/取消请求还校验同源和原账号。任务、幂等键、图片输出与取消操作按账号隔离；账号切换会中止原账号的浏览器操作。
- 任务队列仍为**每账号内存队列**：服务重启会丢失未完成任务，已保存的图片与画布则保存在所属账号的服务器存储，可在其他设备登录访问。当前实例最多驻留 16 个 ComfyUI 用户运行时。共享 GPU 和进程不是对抗性的多租户沙箱，仅向可信账号开放；互不信任的用户需独立实例。
- Codex 订阅生图仍走已有独立渠道；ComfyUI 仅接入导演台图片生成，不替代视频渠道。

## 工作流与模型

工作流：`web/server/workflows/portrait-pose-depth-api.json`；逻辑节点映射：`web/server/comfyui-workflows.mjs`。
它是 **ComfyUI API-format 节点图**，不是 UI 编辑器的布局 JSON。修改时请在 ComfyUI 开发者模式下导出 API 格式，并同步校对清单中的节点 ID、输入名和输出节点 `21`。

示例使用 SD 1.5 系列，默认文件名如下；请自行取得有使用权限的模型并遵守各模型许可证：

| 目录                  | 文件                                          |
| --------------------- | --------------------------------------------- |
| `models/checkpoints/` | `realisticVisionV60B1_v51VAE.safetensors`     |
| `models/controlnet/`  | `control_v11p_sd15_openpose_fp16.safetensors` |
| `models/controlnet/`  | `control_v11f1p_sd15_depth_fp16.safetensors`  |

请以实际下载文件名修改工作流以及 `requiredModels`，不要把 SDXL ControlNet 与 SD 1.5 checkpoint 混用。默认图使用 `CheckpointLoaderSimple`、`CLIPTextEncode`、`LoadImage`、`EmptyLatentImage`、`ControlNetLoader`、`ControlNetApplyAdvanced`、`KSampler`、`VAEDecode`、`SaveImage`，**不要求第三方 custom nodes**。不要在 Pose/Depth 后重复添加图片预处理器；它们已是控制图。

本仓库示例固定 ComfyUI 源码 SHA `a99d1f9c14f4594fe1e9d7e17c1997bf104d89fb`。该版本的 [server.py](https://github.com/Comfy-Org/ComfyUI/blob/a99d1f9c14f4594fe1e9d7e17c1997bf104d89fb/server.py) 实现 `POST /api/jobs/{job_id}/cancel`，只取消指定任务。请保持 `COMFYUI_API_PREFIX=/api`。旧版只提供全局 `/interrupt` 时，本应用**不会**退回全局中断，以免影响其他任务；应升级 ComfyUI。

## 本机开发（含 Mac）

先独立启动已装好模型的 ComfyUI，再运行：

```sh
cd web
npm ci --legacy-peer-deps --include=optional
npm ci --prefix monoform-studio --include=optional
npm run build:monoform
COMFYUI_BASE_URL=http://127.0.0.1:8188 COMFYUI_API_PREFIX=/api npm run dev
```

打开 `http://localhost:3000/canvas`，新建或打开画布 → 添加导演台 → 摆人物/选择动作 → 移动到目标帧 → 输入提示词 → **生成真人图**。结果使用当前活动镜头/帧，而不是固定第 0 帧。多次生成会向下排列结果，避免互相遮挡。错误图片的“重试”会回到原导演台重新确认并捕获控制图，不会误切换到其他图片服务商。

直接 `npm run dev` / `npm start` 时，把变量导出到 Node 进程环境；**不要**把它们改成 `VITE_COMFYUI_*`。项目根目录 `.env` 是下面 Docker Compose 的输入，原生启动不会自动读取它。

## 同机 Linux / NVIDIA Docker Compose

前置条件：Docker Engine、Compose v2.30+（支持 `gpus`）、与 CUDA 12.8 兼容的 NVIDIA 驱动和 NVIDIA Container Toolkit。默认 GPU 镜像为 linux/amd64，使用固定 PyTorch 2.9.1 / torchvision 0.24.1 / torchaudio 2.9.1；首次构建和模型需要较多磁盘空间。显存需求取决于模型、分辨率和运行设置；1024×1024 双 ControlNet 可能需要降低 ComfyUI 内存设置或使用更大显存。

```sh
cp .env.example .env
# 首先检查配置，不会启动服务或下载模型。
docker compose --profile gpu config
# 构建两份镜像；模型不会被自动下载或写进镜像。
docker compose --profile gpu build
# 首次可先启动 ComfyUI，再将模型复制到相应持久卷目录。
docker compose --profile gpu up -d comfyui
# 示例：将你已取得授权的 checkpoint 复制进去。
# docker cp ./your-checkpoint.safetensors "$(docker compose ps -q comfyui)":/opt/comfyui/models/checkpoints/realisticVisionV60B1_v51VAE.safetensors
# 同样复制两个 ControlNet 模型后再启动 Atelier。
docker compose --profile gpu up -d atelier
```

Atelier → `http://comfyui:8188` 只走 Compose 网络。ComfyUI 没有映射宿主机端口，Atelier 默认仅绑定 `127.0.0.1:3000`。需要远程访问时，请在反向代理上设置 HTTPS 和访问控制后再开放 Atelier；不要直接公开 ComfyUI。

`models`、`custom_nodes`、`input`、`output`、`user` 各有 GPU 服务持久卷；Atelier 的账号、媒体、加密密钥和按用户划分的 Codex 凭据统一保存在 `atelier-data` 卷（`/data`）。未来增加 custom nodes 时，应在受控镜像里固定源码提交并安装对应依赖，不要在运行中的服务上安装来源不明的代码。

Codex OAuth 仍由容器内 CLI 管理；不要把本机授权文件写进 Dockerfile、镜像层或仓库。若要保留原有远程 Codex 链路，先登录应用账号，再按配置页的登录流程完成该账号的容器端登录。

## 已有 GPU 服务 / 远端 GPU

只运行 Atelier，不启用 `gpu` profile：

```sh
# 编辑 .env：
# COMFYUI_BASE_URL=http://gpu-private-host:8188
# 或 Mac Docker 访问本机原生 ComfyUI：
# COMFYUI_BASE_URL=http://host.docker.internal:8188
docker compose up -d --build atelier
```

确保 Atelier 服务器能通过 VPN、私网或 SSH 隧道到达 GPU 主机。这个地址属于**运行 Atelier 的服务器**，不是终端用户浏览器。Mac Docker 不能使用 NVIDIA GPU 直通；在 Mac 上使用原生 ComfyUI/MPS 或远端 Linux GPU。

网络代理不支持 WebSocket 时设置 `COMFYUI_WS_ENABLED=false`，使用 HTTP history 轮询。WebSocket 意外断线也会自动转入轮询。

## 配置项

| 变量                         | 默认值 / 行为                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `COMFYUI_BASE_URL`           | 原生未设置时禁用网关并返回 503；Compose 示例为 `http://comfyui:8188`                              |
| `COMFYUI_API_PREFIX`         | `/api`；须为普通路径，不允许查询、片段或路径穿越                                                  |
| `COMFYUI_WS_ENABLED`         | `true`；仅接受 `true` / `false`                                                                   |
| `COMFYUI_TASK_TTL_MS`        | `3600000`；终态元数据和内存结果保留时间                                                           |
| `COMFYUI_REQUEST_TIMEOUT_MS` | `120000`；上游请求连同响应体读取的超时                                                            |
| `COMFYUI_MAX_BYTES`          | `26214400`；单次 multipart 上传总字节上限                                                         |
| `COMFYUI_WORKFLOW_DIR`       | 服务器内置 `server/workflows`；覆盖目录仍须使用已声明的工作流 ID/节点映射；容器中须另行挂载该目录 |

任务内存数据会在 TTL 到期或服务重启后消失；已保存到浏览器的图片不受影响。**这个 TTL 不会删除 ComfyUI 磁盘上的 input/output 文件**。请针对 `atelier/` 输入目录与 `InfiniteAtelier` 输出前缀设置独立的磁盘保留策略，避免清理模型或其他应用的产物。运行中的任务不要清理。

## 健康检查与排障

```sh
# 检查 Atelier 容器能否访问 GPU，不向浏览器暴露上游地址。
docker compose exec atelier node -e 'fetch(process.env.COMFYUI_BASE_URL + "/system_stats").then(r=>{if(!r.ok)throw Error(r.status);return r.json()}).then(()=>console.log("ComfyUI reachable"))'
# 检查节点定义及可选模型（在可信服务端执行）。
docker compose exec atelier node -e 'fetch(process.env.COMFYUI_BASE_URL + "/object_info").then(r=>r.json()).then(x=>console.log(Object.keys(x).filter(k=>/ControlNet|Checkpoint|SaveImage/.test(k))))'
docker compose logs --tail=100 atelier comfyui
```

| 现象                                | 检查/处理                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `COMFYUI_UNAVAILABLE` / 503         | 检查环境变量、私网 DNS/端口；未配置不应影响普通画布功能                      |
| `WORKFLOW_INVALID` / `QUEUE_FAILED` | 使用 API-format 导出；核对 checkpoint、ControlNet 文件名、模型体系和节点版本 |
| WebSocket 断开                      | 核对反向代理 Upgrade 支持，或关闭 WebSocket；系统会使用 history 轮询         |
| `OUTPUT_FAILED` / 找不到输出        | 核对清单输出节点 `21` 是 `SaveImage`，任务未过期，输出文件仍存在             |
| `CANCEL_FAILED` / 无法确认取消      | 检查指定任务的队列状态和 ComfyUI 版本；应用不会全局中断其他任务              |
| 生成超时 / 显存不足                 | 查看 ComfyUI 日志，减少后台 GPU 负载，检查模型/显存后重试                    |
| 控制图超时                          | 重新打开导演台，确认模型已加载和浏览器 WebGL 可用                            |
| 刷新后只有占位图                    | 检查该浏览器 IndexedDB 空间/权限；不要在保存完成前清理站点数据               |

## 验证命令与已知限制

```sh
cd web
npm run test:codex
npm run test:unit
node --test monoform-studio/src/control-passes.test.js
npm run typecheck
npm run build:monoform
npm run build
```

自动化 HTTP fixture 和浏览器 smoke 只证明协议、控制图渲染、取消和持久化，不证明模型推理质量。真实真人图验收仍需要运行装有上述模型的 GPU ComfyUI。仓库不会把模拟返回的控制图描述成真实生成结果。
