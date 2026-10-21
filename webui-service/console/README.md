# fnMusic console

React + Ant Design 是唯一管理页，使用已确认的 A 布局。所有列表与操作调用真实 API，无运行时 CDN 或示例数据。引擎、公共歌单、储存、搜索、大模型、运行状态和诊断已全部迁入侧栏；旧 `/advanced` 书签跳转到新设置页，旧前端代码已移除。

验证和构建：`pnpm install --frozen-lockfile && pnpm test && pnpm build`。产物写入 `../static/console/` 并随仓库分发，NAS 安装与镜像构建无需 Node 包管理器。

- `/api/console/platforms`：平台注册表、脱敏账号状态、启用状态。
- `/api/console/platforms/:id/search`：按平台搜索。
- `/api/console/platforms/qq/recommend`：现有 QQ 个人推荐。
- `/api/qq/auth/*`：沿用原有 QR 登录和凭据存储。
- `POST /api/library`：仅桌面宿主网关提供，容器直连明确返回 501。
- `/api/library/audio?id=...`：管理员范围内的固定文件版本试听，支持 Range。

宿主索引位于 `sources-data/console-library/catalog.sqlite3`，不触碰官方音乐数据库。回收站位于同目录的 `trash/`，在用户音乐目录之外；不提供永久清空入口。任务记录可跨重启查看，中断任务由用户点击重试。

当前酷狗、酷我的搜索/保存复用 musicdl；账号登录和个人推荐尚未接入，页面不会伪造登录成功。默认版本仅用于扩展管理页，不会给飞牛官方播放器增加音质选择按钮。平台搜索结果与账号权限仍受各平台服务状态影响。
