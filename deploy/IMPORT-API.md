# Nothing X 导入接口

供 dot 等客户端向 **Unraid 自托管版**写入 Nothing X 导出的运动和每日活动。接口不适用于 Sites 版。部署包含本接口的新镜像后即可使用，无需迁移数据库或增加环境变量。

## 请求

`POST /api/import/nothing`

使用站点现有的 HTTP Basic 登录：用户名 `fieldnote`，密码为部署时的 `fieldnote-password` 文件内容。每次请求必须携带 `X-Fieldnote: 1`。客户端无需发送 `Origin`；若发送，必须与 `FIELDNOTE_ORIGIN` 完全一致。所有时间沿用 Nothing X 导出表中的北京时间，不进行时区转换。

支持两种请求正文：

| Content-Type | 正文 |
| --- | --- |
| `multipart/form-data` | `file`：一个原始 `.zip` 或 `.xlsx`；`password`：可选的 ZIP 解压密码。由 HTTP 客户端自动生成 multipart boundary。 |
| `application/json` | `workouts` 和／或 `activity`：从 XLSX 工作表读出的原始行数组，保留中文表头，示例见下文。 |

在 URL 添加 `?dryRun=true`，可以查看合并统计，数据库不会写入。确认后向不带该参数的 URL 发送相同正文。预览后的正式请求会基于当时最新的日志重新合并，统计可能变化。

### 直接上传 Nothing X 导出文件

客户端需信任部署时生成的 CA。以下示例使用 `--cacert` 指定 CA，不跳过证书校验。替换地址和文件路径。

先在客户端私有目录准备权限为 `0600` 的 netrc 文件，内容如下。密码由用户在客户端本地填写，不放入仓库或聊天记录。

```text
machine 10.0.0.66
login fieldnote
password <站点登录密码>
```

将 Nothing X 的 ZIP 解压密码另存为私有文本文件，内容不带末尾换行。预览请求：

```sh
curl --fail-with-body --silent --show-error \
  --cacert /private/path/ca.crt \
  --netrc-file /private/path/fieldnote.netrc \
  -H 'X-Fieldnote: 1' \
  -F 'file=@/private/path/nothing-export.zip' \
  -F 'password=</private/path/nothing-zip-password' \
  'https://10.0.0.66:8443/api/import/nothing?dryRun=true'
```

正式导入时删除 `?dryRun=true`。上传 XLSX 时修改 `file` 路径并省略 `password`。

### 提交工作表原始行

dot 若已经解压并读取 XLSX，可直接提交以下 JSON。`workouts` 对应「运动数据」工作表，`activity` 对应「今日活动」工作表。两者均可省略，但正文至少应包含一条有效记录。不要提交站内 JSON 备份格式，也不要重命名中文表头。

```json
{
  "workouts": [
    {
      "发起时间": "2026-11-25 08:14:00",
      "运动类型": "力量训练",
      "运动时长(分钟)": 42.5,
      "活动卡路里(千卡)": 142
    }
  ],
  "activity": [
    {
      "时间": "2026-11-25 23:59:55",
      "步数(步)": 8000,
      "总卡路里(千卡)": 2100,
      "活动卡路里(千卡)": 450,
      "运动时长(分钟)": 42.5
    }
  ]
}
```

```sh
curl --fail-with-body --silent --show-error \
  --cacert /private/path/ca.crt \
  --netrc-file /private/path/fieldnote.netrc \
  -H 'X-Fieldnote: 1' -H 'Content-Type: application/json' \
  --data-binary @/private/path/nothing-rows.json \
  'https://10.0.0.66:8443/api/import/nothing'
```

## 返回结果

成功返回 HTTP `200`：

```json
{
  "dryRun": false,
  "added": 2,
  "updated": 0,
  "skipped": 0,
  "rejected": 0,
  "files": 2,
  "revision": 3,
  "updatedAt": "2026-11-25T15:59:59.000Z"
}
```

`added` 为新增记录数，`updated` 为更新的每日活动数，`skipped` 为合并时跳过的重复或旧记录数，`rejected` 为解析时忽略的无效行数。`files` 为读取的 XLSX 数，JSON 请求为 `0`。XLSX／ZIP 解析时会先合并文件内重复记录、取同一天最新的活动，因此 `skipped` 不包含解析阶段已合并的行。`rejected > 0` 表示部分行未导入，客户端应展示此结果供核对。

`revision` 是请求完成时的日志版本。纯重复导入不改变版本。`updatedAt` 为日志最近一次写入的 UTC 时间；空库预览时为 `null`。导入后在网页「数据管理」点击「刷新云端」，或重新打开页面，即可读取记录。日志尚未启用云端保存时，按页面提示选择云端或合并本机日志。

| HTTP 状态 | 含义与处理 |
| --- | --- |
| `400` | 文件、密码、正文或记录无效；修正后重试。全部行无效时不会写入。 |
| `401` | 站点登录失败；检查 Basic 凭据。 |
| `403` | 缺少 `X-Fieldnote: 1`，或 Origin 不匹配。 |
| `405` | 请求方法错误，使用 POST。 |
| `409` | 并发更新连续冲突；稍后重试相同请求。 |
| `413` | 超过文件或日志容量；拆分文件。 |
| `415` | Content-Type 不支持。 |
| `503` | 存储暂不可用或未能确认结果；稍后重试相同请求。 |

导入错误通常返回 `{"error":"说明"}`。登录、主机名及底层运行时错误可能返回纯文本，客户端应兼容。

## 合并规则和限制

运动以「日期、发起时间、运动类型」生成稳定 ID，与网页导入共用规则；重复记录保留已存版本。每日活动以日期生成 ID，仅接受时间更晚的快照。接口只导入运动和每日活动，额外的 GPS、心率、账号字段会被忽略，其他日志保持原有内容。大于 100 分钟的力量训练沿用网页的待核对标记。

单文件最多 35 MB；ZIP 中最多 80 个匹配的 XLSX，匹配文件声明的解压体积合计最多 35 MB。ZIP 仅读取名称为 `健康数据运动_YYMMDD.xlsx` 或 `健康数据今日活动_YYMMDD.xlsx` 的文件，也支持子目录。单个工作表须少于 30000 行，JSON 正文最多 1500000 字节、30000 行。

原始文件和解压密码只在服务端内存中处理，不写入数据库或请求日志；网页手动导入仍在浏览器内解析。客户端可以安全重试相同数据，导入使用日志版本条件更新，避免覆盖其他设备刚保存的内容。dot 使用的 Basic 凭据与站点登录相同，具有完整站点访问权限，请保存在客户端的私有凭据存储中。
