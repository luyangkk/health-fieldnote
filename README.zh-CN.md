# 体能手记

[English](README.md)

体能手记用来记录饮食、训练、体重、体脂和每日活动。可以在 Unraid 上自托管，也可以在浏览器里本地使用。接入 dot 后，可以用对话记一餐、上传饮食照片、补记身体测量或查询趋势。

## 功能

- 按餐记热量，保留估算标记。信息不全时先存草稿。当天可以按逐餐累计，也可以填写一个全天总量。
- 同一次称量可以一起记录体重、体脂率和腰围，也可以只记其中一项。每日概览和趋势均支持查询。
- 自托管版把饮食和体态照片存入私有 SQLite 数据库。
- 支持导入 Nothing X 的 ZIP 和 XLSX，读取运动明细和每日活动快照。GPS 路线、心率、压力和账号信息不参与导入。
- 自托管版支持 Health Data Export 通过 Webhook 自动上传 Raw JSON，导入体重、体脂、训练和每日活动，检查更新并跳过重复记录。配置方法和合并规则见[自动导入说明](deploy/HEALTH-DATA-EXPORT.md)。
- 网页支持本地记录，也可与 dot 共用自托管数据库。OpenAI Sites 版本支持网页和 D1 存储。

## 快速开始

安装 Node.js 24 和 npm，在项目根目录运行以下命令。

```sh
npm ci
npm run dev
```

打开 Vite 输出的地址，即可使用浏览器本地记录和示例数据。要试用 dot API，请启动自托管服务。

### 在本机启动自托管服务

```sh
npm ci
npm run build
mkdir -p -m 700 .fieldnote.local
if [ ! -e .fieldnote.local/password ]; then
  (umask 077; openssl rand -hex 32 > .fieldnote.local/password)
fi
FIELDNOTE_ORIGIN=http://127.0.0.1:8080 \
FIELDNOTE_BIND=127.0.0.1 \
FIELDNOTE_DB="$PWD/.fieldnote.local/health.sqlite" \
FIELDNOTE_PASSWORD_FILE="$PWD/.fieldnote.local/password" \
node selfhost/server.js
```

打开 `http://127.0.0.1:8080`，使用用户名 `fieldnote` 和 `.fieldnote.local/password` 中的密码登录。HTTP 只允许本机访问。部署到 Unraid 或通过网络访问时使用 HTTPS。

### 部署到 Unraid

参照[单容器 HTTPS 部署指南](deploy/UNRAID-SINGLE.md)。如果已经在用 Caddy，可以沿用[双容器部署指南](deploy/UNRAID.md)。更换容器时保留 `/data` 挂载。旧版 SQLite 会在启动时迁移，升级前请先备份，以便必要时用旧镜像和原库回退。

如果仓库发布的镜像还没有本版 API，可以从当前代码构建。

```sh
docker build --platform linux/amd64 -t health-fieldnote:local .
```

| 配置 | 用途 |
| --- | --- |
| `FIELDNOTE_ORIGIN` | 实际访问的 HTTPS 源地址。非默认端口须写明。本机 HTTP 必须绑定 `127.0.0.1`。 |
| `FIELDNOTE_PASSWORD_FILE` | 网页和旧接口的密码文件，默认 `/run/secrets/fieldnote_password`。 |
| `FIELDNOTE_DB` | SQLite 路径，默认 `/data/health.sqlite`。 |
| `FIELDNOTE_TLS_DIR` | 容器直接提供 HTTPS 时使用的证书目录，内含 `server.crt` 和 `server.key`。 |
| `FIELDNOTE_BIND`、`PORT` | 监听地址和端口。默认监听 `0.0.0.0`，直接启用 TLS 时用 `8443`，否则用 `8080`。 |
| `FIELDNOTE_MEDIA_QUOTA_BYTES` | 单用户图片容量上限，默认 5 GB。 |

## 接入 dot

在运行 API 的同一个实例中创建个人访问令牌。如果 Unraid 容器名为 `fieldnote`，运行以下命令。

```sh
docker exec fieldnote node selfhost/token.js create dot
```

如果是本机服务，在另一个终端指定相同的数据库路径。

```sh
FIELDNOTE_DB="$PWD/.fieldnote.local/health.sqlite" node selfhost/token.js create dot
```

令牌原文只显示一次，请存入 dot 的凭据存储。默认允许读写记录和图片。若 dot 也要删除，可在命令末尾传入 `records:read,records:write,records:delete,media:read,media:write,media:delete`。用 `node selfhost/token.js list` 查看令牌 ID，用 `node selfhost/token.js revoke <token-id>` 撤销。轮换时先用同一个客户端 ID 创建新令牌，再撤销旧令牌。

将 `FIELDNOTE_API` 设为部署的 API 根地址，从凭据存储设置 `FIELDNOTE_TOKEN`。使用本地 CA 的 HTTPS 部署时，给 HTTP 客户端配置可信 CA。

```sh
export FIELDNOTE_API='http://127.0.0.1:8080/api/v1'
curl --fail-with-body -H "Authorization: Bearer $FIELDNOTE_TOKEN" "$FIELDNOTE_API/capabilities"
```

下面示范一次体重和体脂写入。每次新测量使用新的幂等键和外部 ID，重试同一次测量时沿用原值。

```sh
curl --fail-with-body "$FIELDNOTE_API/measurements" \
  -H "Authorization: Bearer $FIELDNOTE_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Fieldnote: 1' \
  -H 'Idempotency-Key: example-startup-20261125-measurement' \
  --data '{"date":"2026-11-25","weightKg":70.25,"bodyFatPct":21.5,"source":{"client":"dot","externalId":"example:measurement:20261125"}}'

curl --fail-with-body -H "Authorization: Bearer $FIELDNOTE_TOKEN" \
  "$FIELDNOTE_API/trends?metric=bodyFatPct&from=2026-11-19&to=2026-11-25"
```

[OpenAPI 契约](docs/api/openapi.json)包含全部 37 个操作。[接口说明](docs/api/DOT-API-DESIGN.md)列出了热量计算、图片上传、错误响应和 ETag 修正规则。`/api/v1` 由自托管服务提供。Nothing X 文件继续用[原有的 Basic 认证导入接口](deploy/IMPORT-API.md)。

## 备份数据

```sh
docker exec fieldnote node selfhost/backup.js
```

命令会在 `/data/backups` 生成包含图片的 SQLite 一致性快照。请另存一份，并按线上数据库的权限保护。恢复时先停止容器，将快照放回配置的 SQLite 路径，确保 UID 1000 可访问，移走旧库残留的 WAL 和 SHM 文件后再启动。网页导出的 JSON 只包含网页可见的日志字段。

## 开发与贡献

```sh
npm ci
npm run build
npm test
```

测试用到 Node.js 内置的 SQLite、OpenSSL 和本机端口。HTTP 集成测试按 OpenAPI 验证每个 dot 操作，同时检查旧库迁移、Nothing X 导入和备份恢复。Docker 构建会先在 Linux 上运行测试，再打包运行镜像。

欢迎通过 Issue 报告问题或讨论改动。请提供复现步骤和合成数据。如果修改接口，请同步更新 OpenAPI 契约，并为改变的行为或兼容性补上测试。请把私人健康记录、照片、凭据和 SQLite 文件留在本地。

## 许可证

仓库目前未提供 `LICENSE` 文件。使用和分发条款请与维护者确认。
