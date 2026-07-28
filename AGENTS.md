# AGENTS.md

## 项目背景

这是一个 AI 旅行规划网站，包含前端页面、旅行数据保存、地图展示和 AI 行程生成功能。

- 启动目录：本文件夹 `第九节课练习/旅行规划小系统`
- 默认地址：http://localhost:3002/
- 前端：`index.html`、`style.css`、`script.js`、`ai.js`、`storage.js` 等
- 后端：`server.js`（Express），AI 经后端调用，不直连 DeepSeek
- 地图：Google Maps（`maps-loader.js` / `map-route.js`），密钥经 `/api/maps-config` 下发；需在 `.env` 配置 `GOOGLE_MAPS_API_KEY`，并启用 Maps JavaScript API + Directions API + Places API；当天多点用 Directions 画线，失败回退直线顺序连线
- 本地数据：统一 LocalStorage 键 `travelAppData`（见 `storage.js`）；收藏键 `travelFavorites`
- MySQL：`docker compose` 起库（默认端口 **3309**），表 `plan_records`；`POST /api/plan` 成功后写入，`GET /api/history` 读取。旅行主数据仍在 LocalStorage，不迁库

## 开发规则

- 修改前先阅读项目并说明计划，不要猜项目结构。
- 优先完成小步、安全、可验证的改动。
- 不要重构整个项目。
- 不要删除或破坏现有功能。
- 尽量复用现有页面结构、样式和函数。
- 不要添加没有必要的第三方框架或依赖。
- 不要把 `.env` 或真实 API Key 写入代码、前端、LocalStorage 或提交记录。
- 前端不能直接请求 DeepSeek，只能请求自己的后端接口。
- DeepSeek 调用应集中在后端服务层。
- 保持现有 API 请求结构稳定。
- MySQL / 数据库表结构若存在，以现有 SQL 文件为准；变更前先说明是否需要迁移。本项目收藏功能默认不改数据库与 API。
- LocalStorage 的键名应保持统一，读取时必须处理无效或损坏的 JSON。
- 修改完成后必须运行可用的检查命令，并说明检查结果。
- 提交前必须查看 `git status` 和 `git diff`。
- 不要自行执行 `git add`、`git commit` 或推送，除非用户明确要求。

## 课堂优先级

优先做小步、安全、可以手动验证的改动。

每次只解决一个明确的小目标。

不要重构整个项目，不要同时修改多个无关功能。

## 收藏功能专项约束

做「收藏」类需求时，计划与实现必须同时满足下面 6 点：

1. **先读项目**：先查看本 `AGENTS.md`、`index.html`、`script.js`、`style.css`、`storage.js`、`ai.js`、`server.js`，再写计划；不要猜测结构。
2. **只改 1–3 个相关文件**：优先在前端完成（例如 `index.html`、`script.js`、`style.css`；如需接入现有存储可读 `storage.js`）。不要顺手改无关模块。
3. **避开数据库与 API 结构**：不改表结构、不改 `/api/*` 契约、不改 `.env`；收藏数据放浏览器本地即可。
4. **写明 LocalStorage key**：
   - 若做独立收藏列表，使用固定键名，例如 `travel-planner-favorites`，并在计划里写清楚。
   - 若并入现有 `travelAppData`，必须写清新增字段名，并走 `storage.js` 的读写与坏数据兜底。
5. **给出页面验证步骤**：至少包括：打开 http://localhost:3002/ → 操作收藏/取消 → 刷新后仍在 → 去重或边界情况 → 损坏 JSON 时不白屏。
6. **Git 与 API Key 安全**：提交前看 `git status` / `git diff`；不把 Key 写入前端或 LocalStorage；不提交 `.env`；前端只请求本站接口。

## 输出要求

修改文件之前，先输出：

1. 对当前项目结构的理解
2. 实现计划
3. 预计修改的文件（收藏需求控制在 1–3 个）
4. 可能存在的风险
5. 若涉及收藏：LocalStorage key、验证步骤、Git / API Key 安全说明

完成修改后，输出：

1. 实际修改的文件
2. 每个文件的改动内容
3. 验证方式和验证结果
4. 未解决问题
5. 安全检查结果（确认无 API Key、未改 API/数据库结构）
