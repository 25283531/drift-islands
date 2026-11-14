# drift-islands（漂流岛屿）

末世海上漂流**纯文字聊天室**游戏：玩家开船在坐标海上游荡，遭遇玩家创建的岛屿，收集资源升级船只，可驻扎建基地；怪物随时间变强并主动攻击人类；世界演变由 AI 推进。

- 设计说明（定稿 v1.4）：[docs/设计说明.md](docs/设计说明.md)
- M0 数据模型与接口定义：[docs/M0-数据模型与接口定义.md](docs/M0-数据模型与接口定义.md)
- 开发任务书（M0 → 上线）：[docs/开发任务书.md](docs/开发任务书.md)
- M1 实现说明与验收记录：[docs/实现说明-M1.md](docs/实现说明-M1.md)

## 当前状态

**M1 原型已交付**：网页聊天室 + 连续坐标海 + 任意方向移动 / 漂流 + 世界时钟（昼夜、洋流）+ 单岛遭遇与岛屿子频道 + 限时回合战斗基础版 + AI 叙述（模板优先，可接 LLM）+ 内容红线与 AI 行为边界 + 每日 AI 配额降级。

- 22 张表与索引：`migrations/001-init.sql`
- 单元测试 + 端到端测试：`npm test`（25 项）
- CI：GitHub Actions（`.github/workflows/ci.yml`）
- 测试环境：`http://43.163.99.248:3000`（Docker：app / PostgreSQL / Redis）

## 本地运行

```bash
npm ci
cp .env.example .env
npm run build
npm run start
# http://localhost:3000
```

默认使用 SQLite（`data/drift-islands.sqlite`），无需安装数据库；不配置 Redis 时使用进程内存储。

## 服务器部署

```bash
cd /opt/drift-islands
cp .env.example .env    # 填写 DB_PASSWORD、JWT_SECRET
docker compose up -d --build
```

## 玩法（M1 可玩范围）

1. 用显示名登录 → 创建角色，出生在 (0,0) 附近。
2. 选方向角与航程启航，或随机漂流；顺洋流不耗燃料。
3. 两个世界小时内必定遇到「锈锚岛」；进岛进入岛屿子频道并触发战斗。
4. 每回合 15 秒，可攻击 / 防守 / 逃跑，超时按防守结算，一回合一条叙述。
5. 海频道可聊天；AI 只回应游戏相关问题，闲聊不响应。

## 一句话

广告里的末世海上重建游戏并不存在——需求被验证过，供给是空的。把广告里那个游戏真做出来。
