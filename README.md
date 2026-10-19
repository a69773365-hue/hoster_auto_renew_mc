# Hoster24 保活（v2）

Hoster24 免费服"无玩家 12 小时自动停服"。本项目定时让一个 bot 真登录进服待一会儿再退出，
让"无人"计时到不了 12 小时。目标端口 **24990**（全部由 `MC_PORT` 控制，默认值也是 24990）。

## 和旧版的区别
- 单一入口 `src/keepalive.js`，`--once`（Actions）和守护模式（Docker/NAS）共用一份代码
- 守护模式失败后 10 分钟重试，不再傻等整个间隔
- 离线登录，没有 msa-cache、没有任何密钥
- 不依赖服务器侧 wrapper，只要服务器真的在 `MC_PORT` 上监听即可

## 配置（环境变量）
| 变量 | 默认 | 说明 |
|---|---|---|
| MC_HOST | server.hoster24.org | 服务器地址 |
| MC_PORT | 24990 | 服务器端口 |
| MC_USER | qx47_kp9z2 | bot 名，必须在 whitelist.json 里 |
| MC_VERSION | 1.21.11 | 客户端协议版本，靠服务端 ViaBackwards 翻译，别改成自动 |
| STAY_MIN | 20 | 每次待多久（分钟） |
| INTERVAL_H | 4 | 守护模式两轮间隔（小时），须 < 12 |
| RETRY_MIN | 10 | 守护模式失败重试（分钟） |

## 方式 A：GitHub Actions（零成本）
1. 新建仓库，把本目录全部推上去（包括 `.github/` 和 `.keepalive`）
2. Actions 页手动跑一次 `keepalive` 验证
3. 公开仓库分钟数免费；私有仓库把 cron 改每 8 小时、`STAY_MIN` 改 15

## 方式 B：NAS / VPS（Docker）
```bash
cp .env.example .env     # 按需改
docker compose up -d --build
docker compose logs -f
```
没装 Docker 也行：`npm install && node src/keepalive.js`

## 验证
- 日志出现 `logged in as ...` 和 `spawned; staying 20 min`
- 面板控制台出现 `qx47_kp9z2 joined the game`
- 日志出现 `players online: 0` 之后紧跟登录；若有真人则显示 `skip this round`

## 排错
- `status ping ... failed`：端口不对或服务器已停服；先确认面板里的真实端口
- `kicked: ... whitelist`：bot 名不在 whitelist.json
- `Invalid move player packet`：说明有人改了代码发了移动包，别发
- 协议/版本报错：服务器升级后可能要换 `MC_VERSION`，或等 minecraft-protocol 更新
