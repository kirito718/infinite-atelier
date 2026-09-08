# 用户系统与持久化存储设计

用户已确认采用自托管 SQLite 方案，实施范围包含账号、用户隔离、媒体文件、旧数据迁移、导演台和重启恢复。

## 架构与边界

- 保持 React 19 / Zustand / Vite 和 Node.js 同源部署，开发和 preview 均挂载同一账号 API。SQLite 使用 better-sqlite3，WAL、外键、事务和版本号保障单机持久化。
- `ATELIER_DATA_DIR` 默认 `web/data`，存放数据库、加密密钥、按用户分目录的上传文件与 Codex home。必须持久挂载和备份整个目录；数据库不是浏览器缓存。
- 服务端是业务数据的事实来源。主题、语言、布局等设备偏好可保留在浏览器；账号会话和 API Key 不写入浏览器存储。
- 兼容现有用户自带渠道：配置在服务端 AES-256-GCM 加密，只有当前用户可读取解密后的配置到内存。密码用带随机盐的 scrypt 哈希，不可逆存储。Cookie 为随机会话令牌，数据库仅保存令牌摘要。
- 不实现多人同时编辑、共享项目、邮件找回或多副本数据库。遇到版本冲突明确停止覆盖；显示错误并允许用户先导出草稿。

## 账号与请求安全

用户名、显示名、密码注册；登录、退出、修改密码与会话恢复。首个账号始终可注册，后续默认关闭公开注册，通过 `ATELIER_ALLOW_REGISTRATION=true` 开放。密码至少 10 字符、最多 128 字符。HttpOnly / SameSite=Lax Cookie，HTTPS 部署配置 Secure Cookie。会话有效期 7 天，修改密码撤销其他会话。

所有状态、文件、生成及代理 API 必须鉴权；查询必须包含服务端会话的 user_id。写请求要求同源校验和 `X-Atelier-Request: 1`，已登录客户端附带 `X-Atelier-User`，防止另一个标签页切换 Cookie 后将旧草稿写入新账号。登录限流、请求大小限制、上传配额、受控文件名及媒体 Range 下载必须覆盖。

Codex API 按用户创建 client / task map / `CODEX_HOME` / 临时目录，绝不复用主机全局登录状态。代理不得转发会话 Cookie、应用标头和上游 Set-Cookie；默认阻止私网和非 HTTP(S) 目标，私网模型服务需部署者显式启用。DNS 解析结果固定到实际连接，重定向重新验证目标。

## API 合约

- `GET /api/account/session` → `{ user: {id, username, displayName, avatarUrl} | null, registrationAllowed: boolean }`。
- `POST /api/account/register` / `login` → `{user}` 并设置会话 Cookie。`POST logout` → 204。`POST password` 使用 `{currentPassword,newPassword}`，轮换会话。
- `GET /api/account/state` → `{entries:[{key,value,revision}]}`。`GET /state/:key` → `{value:string|null,revision:number}`。不存在为 null / 0。
- `PUT /api/account/state/:key` 使用 `{value:string|null,expectedRevision:number}` → `{revision}`。冲突返回 409，禁止无条件覆盖。主应用 value 是 Zustand 序列化 envelope；导演台 value 是原有 JSON 字符串。
- `GET /api/account/files` → `{files:[{storageKey,mimeType,bytes}]}`。`PUT /files/:key` 上传原始字节，GET/HEAD 下载，DELETE 删除。文件 URL 带 `?account=<userId>` 防止旧标签页的同名文件解析成另一个账号的文件。
- `POST /api/account/import` 使用 `{migrationId,entries:[{key,value}]}`：一次事务导入空账号，验证文件引用，重复 migrationId 幂等成功；已有业务数据返回 409，不覆盖。
- 错误统一为 `{error:string,code:string}`，不回传服务器路径、数据库详情或凭据。

## 前端生命周期

持久化 stores 禁止自动 hydration；账号确认后清理前一账号内存，读取服务端快照，依次 rehydrate 后才显示应用并开启保存。序列化保存队列做防抖、顺序提交、网络重试和 revision 冲突检测；退出前 flush；有未保存数据时离页提示。session epoch 防止迟到响应污染下一账号；标签页间传播账号变化。

图片/音视频改用服务端文件 API，storageKey 保持兼容。素材、画布、生成历史、提示词封面、AI 配置和 MONOFORM 工程/自定义姿势都需接入。备份导入导出必须包含服务端媒体，而非继续枚举本机 IndexedDB。

## 迁移与运行

首次登录检测旧 localStorage / IndexedDB，明确显示目标账号并由用户选择导入。先上传文件，再事务提交文档；成功之前不标记完成，不删除旧数据。只允许导入空账号，失败可重试；如果账号已有内容则不覆盖。保留旧配置、图片、音视频、导演台工程和自定义姿势。

提供 `.env.example`、Dockerfile、Compose 持久卷和部署/备份说明。默认仅发布回环端口，远程通过 HTTPS 反向代理；不自动连接、部署或修改现有远程服务。

## 验收

真实临时 SQLite / 文件目录的 HTTP 集成测试覆盖注册登录、密码哈希、密钥与配置加密、Cookie/CSRF/越权、重启恢复、媒体 Range、配额、文件名攻击、版本冲突、迁移幂等和 Codex 隔离。前端测试覆盖保存重试、迟到请求、用户切换与遗留数据导入。运行现有 10 个前端测试、35 个 Codex/API 测试、类型检查、主应用/导演台构建和浏览器关键流程。真实 Codex OAuth 不在自动测试中执行。
