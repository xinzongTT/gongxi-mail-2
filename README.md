# GongXi Mail (廾匸邮箱)

使用 Microsoft OAuth2 进行邮箱收取的 API 服务。

## 技术栈

- **后端**: Fastify 5 + TypeScript + Prisma 6
- **数据库**: PostgreSQL
- **缓存**: Redis
- **前端**: React + Ant Design + Vite

## 项目结构

```
├── server/                 # 后端服务
│   ├── src/
│   │   ├── config/        # 环境配置
│   │   ├── lib/           # 核心库
│   │   ├── plugins/       # Fastify 插件
│   │   ├── modules/       # 业务模块
│   ├── prisma/            # 数据库 Schema
│   └── package.json
├── web/                    # 前端管理面板
├── docker-compose.yml
└── Dockerfile
```

## 快速开始

### Docker 部署

生产环境请先注入密钥（不要写死在仓库）：

```bash
export JWT_SECRET="replace-with-at-least-32-char-random-secret"
export ENCRYPTION_KEY="replace-with-32-character-secret-key"
export ADMIN_PASSWORD="replace-with-strong-password"
```

然后启动：

```bash
docker-compose up -d --build
```

访问 http://localhost:3000

### 健康检查

```bash
curl http://localhost:3000/health
# {"success":true,"data":{"status":"ok"}}
```

## 开发质量检查

```bash
# 前端
cd web
npm run lint
npm run build

# 后端
cd ../server
npm run lint
npm run lint:fix
npm run build
npm run test
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| NODE_ENV | 环境 | development |
| PORT | 端口 | 3000 |
| DATABASE_URL | PostgreSQL 连接 | - |
| REDIS_URL | Redis 连接 | - |
| CORS_ORIGIN | 允许跨域来源（逗号分隔） | 开发环境默认放开 |
| JWT_SECRET | JWT 密钥 (≥32字符) | - |
| JWT_EXPIRES_IN | Token 过期时间 | 2h |
| ENCRYPTION_KEY | 加密密钥 (32字符) | - |
| ADMIN_USERNAME | 默认管理员用户名 | admin |
| ADMIN_PASSWORD | 默认管理员密码（生产禁止使用默认值） | - |
| ADMIN_LOGIN_MAX_ATTEMPTS | 管理员连续失败最大次数 | 5 |
| ADMIN_LOGIN_LOCK_MINUTES | 登录失败锁定分钟数 | 15 |
| ADMIN_2FA_SECRET | 可选管理员 TOTP Base32 密钥 | - |
| ADMIN_2FA_WINDOW | TOTP 时间窗口（步长） | 1 |
| API_LOG_RETENTION_DAYS | API 日志保留天数 | 30 |
| API_LOG_CLEANUP_INTERVAL_MINUTES | API 日志清理间隔（分钟） | 60 |

## 枚举约定

为避免前后端不一致，所有枚举统一使用大写：

| 类型 | 枚举值 |
|------|--------|
| 管理员角色 | `SUPER_ADMIN` / `ADMIN` |
| 管理员/API Key 状态 | `ACTIVE` / `DISABLED` |

## 邮件拉取策略（分组级）

邮箱分组支持配置 `fetchStrategy`，同组邮箱统一使用该策略：

| 策略 | 行为 |
|------|------|
| `GRAPH_FIRST` | 先 Graph，失败后回退 IMAP |
| `IMAP_FIRST` | 先 IMAP，失败后回退 Graph |
| `GRAPH_ONLY` | 仅 Graph，不回退 |
| `IMAP_ONLY` | 仅 IMAP，不回退 |

说明：`IMAP_ONLY` 不支持“清空邮箱（process-mailbox）”，该操作依赖 Graph API。

### Token 类型兼容（Graph / IMAP 双通道）

系统同时兼容两类 refresh token，混合导入同一邮箱池也没问题，双通道策略会自动选能用的那条：

| Token 来源 | 已授权权限 | 实际收信通道 |
|------|------|------|
| 自建应用授权（含 `Mail.Read`） | Graph `Mail.Read` / `Mail.ReadWrite` | Graph API |
| Thunderbird 等客户端 token（client_id `9e5f94bc-…`） | `IMAP.AccessAsUser.All`，无 Graph 权限 | IMAP（XOAUTH2） |

实现要点（`server/src/modules/mail/mail.service.ts`）：

- Graph 与 IMAP 是两个不同资源，access token 不能混用，分别换取：Graph 按 `.default` → 显式 `Mail.Read` 顺序尝试，scope 判断兼容长/短写法且 `Mail.ReadWrite` 视为可读；IMAP 显式带 `https://outlook.office.com/IMAP.AccessAsUser.All offline_access` 换 token，失败再退回不带 scope 的老写法。
- 确认某枚 token 无 Graph 权限后会按 token 指纹做 30 分钟负缓存，后续收信直接走 IMAP，不再每次白跑一趟 Graph；换新 token 重新导入不受旧缓存影响。
- 双通道都失败时，错误信息会同时带上两个通道的原因（`MAIL_FETCH_FAILED`），不会再用回退通道的错误掩盖首选通道的真实故障。
- IMAP 文件夹名会自动映射：`junk` → `Junk Email`、`sent` → `Sent Items` 等。
- 清空邮箱仍需 Graph 且删除要求 `Mail.ReadWrite`；只有 `Mail.Read` 时删除会被拒绝并如实返回失败，不再虚报删除数。

## API 文档

### 外部 API (`/api/*`)

需要在 HTTP Header 中携带 API Key：`X-API-Key: sk_xxx`

#### 接口列表

| 接口 | 说明 | 注意事项 |
|------|------|----------|
| `/api/get-email` | 获取一个未使用的邮箱地址 | 会标记为当前 Key 已使用 |
| `/api/mail_new` | 获取最新邮件 | - |
| `/api/mail_text` | 获取最新邮件文本 (脚本友好) | 可用正则提取内容 |
| `/api/mail_all` | 获取所有邮件 | - |
| `/api/process-mailbox` | 清空邮箱 | `data.deletedCount` 为删除数量 |
| `/api/list-emails` | 获取系统所有可用邮箱 | - |
| `/api/pool-stats` | 邮箱池统计 | - |
| `/api/reset-pool` | 重置分配记录 | 释放当前 Key 占用的所有邮箱标记 |

#### 使用流程

1. **获取邮箱**：
   ```bash
   curl -X POST "/api/get-email" -H "X-API-Key: sk_xxx"
   # {"success": true, "data": {"email": "xxx@outlook.com"}}
   ```

2. **获取邮件内容 (推荐)**：
   自动提取验证码（6位数字）：
   ```bash
   curl "/api/mail_text?email=xxx@outlook.com&match=\\d{6}" -H "X-API-Key: sk_xxx"
   # 返回: 123456
   ```

3. **获取完整邮件 (JSON)**：
   ```bash
   curl -X POST "/api/mail_new" -H "X-API-Key: sk_xxx" \
     -d '{"email": "xxx@outlook.com"}'
   ```

#### 参数说明

**通用参数**：
| 参数 | 说明 |
|------|------|
| email | 邮箱地址（必填） |
| mailbox | 文件夹：inbox/junk |
| socks5 | SOCKS5 代理 |
| http | HTTP 代理 |

**`/api/mail_text` 专用参数**：
| 参数 | 说明 |
|------|------|
| match | 正则表达式，用于提取特定内容 (例如 `\d{6}`) |

## 操作日志 Action 命名

`/admin/dashboard/logs` 中 `action` 字段使用以下固定值：

| Action | 含义 |
|--------|------|
| `get_email` | 分配邮箱 |
| `mail_new` | 获取最新邮件 |
| `mail_text` | 获取邮件文本 |
| `mail_all` | 获取所有邮件 |
| `process_mailbox` | 清空邮箱 |
| `list_emails` | 获取邮箱列表 |
| `pool_stats` | 邮箱池统计 |
| `pool_reset` | 重置邮箱池 |

## API Key 权限键

API Key 的 `permissions` 使用与上表一致的 action 值（如 `mail_new`、`process_mailbox`）。  
未配置 `permissions` 时默认允许全部接口。

## 生产配置要求

- `JWT_SECRET`、`ENCRYPTION_KEY`、`ADMIN_PASSWORD` 必须通过外部环境变量注入。
- 如启用 2FA，`ADMIN_2FA_SECRET` 也必须通过外部环境变量注入。
- 不要在 `docker-compose.yml`、`.env`、代码仓库中写死生产密钥。
- `server/.env.example` 仅作为模板，不能直接用于生产。
- 如需跨域访问，配置 `CORS_ORIGIN`（如 `https://admin.example.com,https://ops.example.com`）。
- 生产模式会在启动时对前端静态资源生成 `.gz/.br` 预压缩文件，并优先下发压缩版本。
- 服务会按 `API_LOG_RETENTION_DAYS` 与 `API_LOG_CLEANUP_INTERVAL_MINUTES` 自动清理历史 API 日志。

## License

MIT
