# dot 健康记录 API

适用于 Health Fieldnote 自托管版，支持单用户和多个客户端。dot 负责理解文字和照片、调用接口并向用户回报结果；服务端负责保存记录、计算汇总和处理并发。

设计采用 `/api/v1` 下的资源接口，提供结构化输入和输出。客户端查询时直接读取汇总，写入时操作单条记录。照片保存为独立资源，通过 ID 关联餐食，热量估算与原始图片分别保留。

首版覆盖日常查询、饮食、图片、运动和身体测量。新版导入、整库导出和增量同步延后。接口契约见 [openapi.json](openapi.json)。现有 Nothing X 导入继续使用 `POST /api/import/nothing`，调用方式见 [IMPORT-API.md](../../deploy/IMPORT-API.md)。

Health Data Export 自动上传使用独立的 `POST /api/import/health-data-export`，仅要求带 `records:write` 权限的 Bearer 令牌，由服务端处理去重和更新。它不要求 `X-Fieldnote` 或 `Idempotency-Key`，也不接受普通 v1 单条记录正文。配置和合并规则见[自动导入说明](../../deploy/HEALTH-DATA-EXPORT.md)，契约见 [health-data-export.openapi.json](health-data-export.openapi.json)。原有 v1 写入规则保持不变。每日活动的 `durationMinutes` 现允许为空，表示导出中未提供锻炼时间。

## 日常对话如何调用

| 用户表达 | dot 调用流程 | 用户看到的结果 |
| --- | --- | --- |
| 今天吃了多少，还能吃多少 | 解析为明确日期 → `GET /days/{date}` | 已记摄入、目标差额、是否记完、有无待处理照片 |
| 午餐鸡腿饭，估计 650 千卡 | `POST /meals`，状态为 `recorded`，标记估算 | 已保存的记录 ID、日期、餐次、热量、当日合计 |
| 发一张午餐照片并说记一下 | 上传图片 → dot 估算 → 新增带图片的餐食 | 估算值及范围、记录 ID；图片本身不会额外增加热量 |
| 只发照片，暂时不知道热量 | 上传图片 → 新增 `draft` 餐食 | 已保存照片、待补充；当日汇总显示尚有草稿 |
| 刚才那份米饭只吃了一半 | 找到原记录 → 获取版本 → `PATCH /meals/{id}` | 原记录已修正、修正后的热量和当日合计 |
| 今天总共 1800 千卡 | 明确使用全天总量 → 更新日期状态为 `total` | 全天按 1800 计；逐餐记录保留并注明未参与本次合计 |
| 今天记完了 | 核对草稿 → 更新日期状态为 `complete` | 当日已记完；存在草稿时要求先处理 |
| 看过去一个月的摄入和体重 | `GET /summaries`、`GET /trends` | 有记录天数、完整天数、各自口径的均值和缺失日期 |
| 今早体重 70.25 公斤，体脂率 21.5% | `POST /measurements` | 保存同一次测量的两项数值，返回日期和记录 ID |
| 看最近 30 天的体脂 | `GET /trends?metric=bodyFatPct&groupBy=day` | 每天最近一次有效体脂读数，缺测日期留空 |
| 记录一张体态照片 | 上传图片，`purpose=progress` | 图片日期、备注和 ID，不创建饮食记录 |

## 通用协议

| 项目 | 约定 |
| --- | --- |
| 根路径 | `https://<fieldnote-host>/api/v1`，使用部署证书和可信 CA |
| 日期与时区 | 业务日期为 `YYYY-MM-DD`，固定 `Asia/Shanghai`。请求中必须传具体日期，不能传「今天」「昨天」。日期查询区间两端均包含。 |
| 时间 | 餐食、测量的 `time` 可空；已知时使用 `HH:mm:ss`。不为「午餐」编造一个准确时间。审计时间使用 UTC RFC 3339 字符串。 |
| 单位 | 热量 kcal、体重 kg、体脂率 %、腰围 cm、营养素 g、运动时长 min；字段名或 schema 明示单位。 |
| 数值 | `0` 表示已知为零，`null` 表示未知；禁止 NaN、负热量和用零填补缺失。v1 创建和修改时，热量和营养素最多 1 位小数，体重和体脂率最多 2 位。读取历史记录时保留旧库精度。 |
| 成功响应 | 普通对象 `{data}`；列表为 `{data:[], page:{nextCursor,hasMore}}`。诊断信息放在 `X-Request-Id`、`Date`、`X-Data-Revision` 响应头，避免随请求变化的字段破坏资源 ETag。 |
| 错误响应 | `application/problem+json`，包含 HTTP 状态和稳定的 `code`，不通过中文提示文本判断重试。 |
| 写入 | JSON 写入使用 `application/json`。图片上传使用 multipart，由客户端生成 boundary。所有写入携带 `X-Fieldnote: 1`。 |
| 分页 | `limit` 默认 50、最大 200；`cursor` 为不透明游标。默认 `date DESC, createdAt DESC, id DESC`，不支持 offset。所有列表明确支持的筛选项，不接受任意 SQL。 |
| 区间 | 普通列表及汇总一次最多 366 天；趋势最多 5 年。省略区间时列表取最近 30 天，媒体列表按业务日期筛选。 |
| 缓存 | 记录和图片返回 `Cache-Control: private, no-store`。 |
| 扩展 | 写入对象拒绝未知字段，读取端忽略不认识的新增字段。破坏兼容的修改升级到 `/api/v2`。 |

列表游标绑定全部筛选条件和排序，修改条件需从第一页开始。列表是实时视图，跨页期间发生修改可能改变结果。非法游标返回 `400 INVALID_CURSOR`，不要静默重置。

餐食、运动、测量、图片列表还支持配对的 `sourceClient` 与 `externalId` 精确筛选，供 dot 在响应丢失后核对已有写入；两者必须一起提供。该精确查询未显式指定日期时，不套用最近 30 天的默认区间。查餐食写入结果时使用 `status=all`，兼顾草稿。

### 认证和权限

v1 使用个人访问令牌 `Authorization: Bearer <token>`。令牌由本机管理工具创建、撤销和轮换，原文仅创建时显示一次，数据库只存摘要。令牌绑定一个 owner 和稳定的 clientId，轮换令牌不改变 clientId；直接创建记录时 source.client 必须等于该 clientId。API 不接受客户端指定 `ownerId`。`GET /me` 返回当前身份和实际权限；`GET /capabilities` 返回服务版本、已实现能力、限制、时区及支持的图片格式。

| scope | 能力 |
| --- | --- |
| `records:read` | 查询餐食、日期汇总、运动、测量、活动和目标 |
| `records:write` | 新增和修改上述记录、日期状态与目标 |
| `records:delete` | 删除餐食、运动、测量和目标变更 |
| `media:read` | 查询图片元数据和读取图片内容 |
| `media:write` | 上传图片、修改图片日期和备注 |
| `media:delete` | 删除图片 |

日常 dot 令牌配置记录和图片的读写权限。需要删除操作时再赋予相应 delete 权限。创建关联图片的餐食还需要 `media:read`。管理令牌的能力不开放给普通 dot 令牌。

v1 的 Bearer 校验必须在现有服务器的 Basic 校验之前按路径分流。网页与旧接口继续沿用独立的 Basic 登录；不要让当前 Basic 网关拦住 Bearer，也不要让 Bearer 自动获得旧版整库写入权限。跨站 Origin 一律拒绝；不启用通配 CORS。服务端只记录请求 ID、路由模板、状态、耗时和记录 ID，不记录令牌、原始聊天、图片或解压密码。

### 重试和并发

所有 POST 和 PUT/PATCH/DELETE 请求要求 `Idempotency-Key`，长度 16–128，可使用 UUID。dot 在发送请求前为一次逻辑操作保存该键，网络超时后复用。作用域为 owner、客户端、HTTP 方法、规范化路径和幂等键。服务端原子地保存请求指纹和最终结果，72 小时内同键同内容重放原状态与正文，并返回 `Idempotency-Replayed: true`；同键不同内容返回 `409 IDEMPOTENCY_CONFLICT`。并行处理中返回 `409 REQUEST_IN_PROGRESS` 和 `Retry-After`。指纹包含正文、语义查询参数和条件头，不包含随机 multipart boundary；文件按上传字节摘要及其他字段计算。

餐食、运动、测量和图片创建另带 `source.externalId`，用于超过 72 小时后的去重。唯一约束为 `(owner, resourceType, source.client, source.externalId)`。每次独立记账使用独立 externalId，同一条消息有两顿餐时增加条目序号；重新拍照确认同一顿餐时修改已有 ID。重复 externalId 且创建内容相同，返回已有记录 `200`；内容不同返回 `409 EXTERNAL_ID_CONFLICT`，客户端改为读取并修正，服务端不推测是否同一顿饭。删除后保留去重标识，旧请求返回 `410 SOURCE_RECORD_DELETED`，不得复活记录。

单资源读取返回强 ETag，例如 `"meal:meal_01:v3"`。PATCH、DELETE 和替换已有资源的 PUT 必须带匹配的 `If-Match`；缺少条件返回 `428 PRECONDITION_REQUIRED`，版本落后返回 `412 VERSION_CONFLICT`。创建日期活动、目标时使用 `If-None-Match: *`；这与 If-Match 二选一。日期状态 GET 可返回虚拟的版本 0，初次 PUT 用该状态的版本 0 ETag 做原子创建。

服务端先检查身份与作用域，再重放幂等结果，再执行版本条件检查，避免成功后的重试被自己的旧 ETag 拒绝。成功写入返回资源 `version` 和 `X-Data-Revision`。单资源响应返回 ETag；包含餐食与汇总的复合回执将餐食的 ETag 放在 `data.mealEtag`，日期状态复合回执放在 `data.stateEtag`，不把一个子资源的版本冒充整个响应的强 ETag。PATCH 使用 `application/merge-patch+json`：省略字段保持原值，显式 `null` 仅可清除可空字段；数组整体替换，删除必填字段返回 `422`。GET 为只读操作。

## 接口目录

下表列出 v1 接口，路径省略 `/api/v1`。每个方法的请求与响应 schema 以配套 OpenAPI 为准。

| 能力 | 方法和路径 | 用途 |
| --- | --- | --- |
| 接入 | `GET /capabilities`、`GET /me`、`GET /openapi.json` | 能力发现、身份检查、契约下载 |
| 每日概览 | `GET /days/{date}` | 一次返回有效摄入、餐次摘要、目标、活动、测量和待处理数量 |
| 日期状态 | `GET /days/{date}/state`、`PUT /days/{date}/state` | 记录是否记完、采用逐餐还是全天总量、当日备注 |
| 餐食 | `GET/POST /meals`、`GET/PATCH/DELETE /meals/{id}` | 查询、录入、修正和删除餐食 |
| 图片 | `GET/POST /media`、`GET/PATCH/DELETE /media/{id}`、`GET /media/{id}/content` | 图片归档、备注、授权读取与删除 |
| 运动 | `GET/POST /workouts`、`GET/PATCH/DELETE /workouts/{id}` | 手动运动记录和导入记录查询修正 |
| 身体测量 | `GET/POST /measurements`、`GET/PATCH/DELETE /measurements/{id}` | 体重、体脂率、腰围，可同日多次测量 |
| 每日活动 | `GET /activity`、`GET/PUT/DELETE /activity/{date}` | 步数、活动消耗、总消耗和快照时间 |
| 摄入目标 | `GET /targets`、`GET/PUT/DELETE /targets/{effectiveFrom}` | 按生效日期管理目标，历史日期使用当时生效值 |
| 统计 | `GET /summaries`、`GET /trends` | 区间统计、按日／周／月聚合、趋势序列 |

## 餐食和卡路里

餐食记录包含 `id`、`version`、`date`、可空的 `time`、`mealType`、`description`、`status`、`nutrition`、`nutritionBasis`、`items`、`mediaIds`、`note` 和 `source`。ID 由服务端生成，客户端不可通过 POST 指定。

`mealType` 固定为 `breakfast/lunch/dinner/snack`，展示时再映射为中文。`status` 为 `draft` 或 `recorded`，创建时必须明确传入。`nutritionBasis` 为 `user_provided/label/photo_estimate/mixed`。`nutrition.kcal` 是整顿餐的摄入量；`items` 只描述食物名称和份量，不再维护第二套可相加的热量字段。

```json
{
  "date": "2026-11-25",
  "time": null,
  "mealType": "lunch",
  "description": "鸡腿饭，米饭约一碗",
  "status": "recorded",
  "nutrition": {
    "kcal": 650,
    "proteinGrams": 32,
    "carbsGrams": null,
    "fatGrams": null,
    "isEstimate": true,
    "kcalRange": { "min": 550, "max": 750 }
  },
  "nutritionBasis": "photo_estimate",
  "items": [{ "name": "鸡腿饭", "quantityText": "一份，含约一碗米饭" }],
  "mediaIds": ["media_01"],
  "note": "按照片中的份量估算",
  "source": { "client": "dot", "externalId": "msg_example:meal:0" }
}
```

`recorded` 必须有 `kcal`，允许 0，单餐上限 10000；未知营养素为 null。`draft` 可以没有热量，全部不计入摄入统计。照片估算必须 `isEstimate=true`；范围可缺省，但若存在须满足 `min ≤ kcal ≤ max`。`kcalRange` 仅表达这次估算范围，不解释为统计置信区间。范围内没有足够信息时，dot 保存草稿并询问份量，不生成虚假的精确值。

成功响应同时返回 `data.meal`、`data.mealEtag` 和事务内计算的 `data.daySummary`，让 dot 直接回复「已记午餐约 650 千卡，今天已记 1250 千卡，尚未记完」。返回 ID 和版本后才称为已保存。整张图片无热量字段；同一张图片关联两份记录不会自动产生任何热量。

修改通过 ID 操作，例如将午餐改为 520 千卡：

```http
PATCH /api/v1/meals/meal_01
Authorization: Bearer <token>
Content-Type: application/merge-patch+json
X-Fieldnote: 1
Idempotency-Key: 48c6d882-6f90-4a81-bcde-f21aa80f5811
If-Match: "meal:meal_01:v1"

{"nutrition":{"kcal":520,"kcalRange":null},"note":"米饭只吃了一半"}
```

服务端先应用补丁，再对完整记录校验，保留未修改的营养素。若估算方法也变化，dot 同时更新 `nutritionBasis` 和 `isEstimate`。若移动餐食日期，旧日期和新日期的汇总在同一事务内更新。source 的 client 和 externalId 不可修改。

`GET /meals` 支持 `from/to`、`mealType`、`status`、`hasMedia` 和 `q`；q 最长 160 字，只搜索描述、食物名称和备注。默认仅返回 recorded，查看草稿需显式 `status=draft`，查看全部用 `status=all`。

### 全天总量和记完状态

日期状态包含 `intakeMode=meals|total`、`dailyTotalKcal`、`totalIsEstimate`、`recordingStatus=open|complete`、`isRestDay` 和 `note`。未创建状态时默认 meals、open、非休息日、版本 0。`PUT /days/{date}/state` 替换整个日期状态。isRestDay 只表示训练安排，不改变摄入或活动数据。

| 情况 | 有效摄入 `intakeKcal` |
| --- | --- |
| meals，存在 recorded 餐食 | 全部 recorded 餐食热量之和 |
| meals，只有草稿或完全没有记录 | null；不当作零摄入 |
| total | 明确填写的 `dailyTotalKcal`；逐餐合计另以 `mealSubtotalKcal` 展示，不参与有效摄入 |

total 模式要求 `dailyTotalKcal` 在 0–30000 之间，`totalIsEstimate` 为布尔值；meals 模式要求两者均为 null。切换模式不删除逐餐记录。切回 meals 后重新使用逐餐合计。dot 先说明模式切换的影响，依照用户选择操作。

complete 只表示用户确认记录完整。存在草稿时返回 `422 UNRESOLVED_DRAFTS`；meals 模式无 recorded 餐食时也不能标记 complete，如确实全天零摄入，显式使用 total=0。任何已计入餐食的新增、修改、删除或日期移动，均将相关日期重新置为 open，并递增日期状态版本；dot 需要在修正完成后再次标记 complete。活动、身体测量和图片备注变更不改变饮食完整状态。

### 查询的口径

`GET /days/2026-11-25` 的响应包含日期状态、有效摄入、逐餐合计、草稿数、餐次汇总、目标、活动快照，以及体重、体脂率、腰围各自的最新读数。图片按 ID 返回，可由 dot 再读取内容，不在汇总里嵌入图片字节。

```json
{
  "date": "2026-11-25",
  "intakeMode": "meals",
  "intakeKcal": 1250,
  "mealSubtotalKcal": 1250,
  "recordedMealCount": 2,
  "draftMealCount": 1,
  "recordingStatus": "open",
  "containsEstimates": true,
  "targetKcal": 1900,
  "remainingToTargetKcal": 650,
  "overTargetKcal": 0,
  "activity": { "steps": 8000, "activeKcal": 450, "totalKcal": 2100, "isPartial": true }
}
```

这只是 daySummary 片段。`remainingToTargetKcal=max(target-intake,0)`，`overTargetKcal=max(intake-target,0)`；摄入或目标未知时两者为 null。目标差额用于记录展示，不自动加上运动消耗。Nothing 的活动消耗和总消耗是不同指标，不能相加；运动明细也不再叠加到每日活动消耗，避免重复计算。

`GET /summaries?from=2026-11-01&to=2026-11-25&groupBy=day` 返回完整日期网格及区间汇总。支持 day/week/month，周从周一开始；首尾桶按请求区间裁剪。返回 `calendarDays/recordedDays/completeDays/missingDays/draftMealCount`，明确区分 `averageRecordedIntakeKcal` 和 `averageCompleteIntakeKcal`，分母为对应的有值天数，为零则结果 null。完整天数只统计 complete 且 intakeKcal 非空的日期，不把缺失补零。

`GET /trends` 支持 `intakeKcal/weightKg/bodyFatPct/waistCm/steps/activeKcal/totalKcal/workoutMinutes`。按日先取有效摄入、最新测量、最新活动或运动时长之和，再按 groupBy 聚合：摄入、步数、消耗和运动时长提供 sum 与 average，体重、体脂率和腰围提供 average 和 last，未使用的聚合字段为 null；每个桶包含 count、missingDays、partialDays。无测量日期不前向填充，活动和饮食未完整日期保留标记。汇总均值显示 1 位小数，趋势均值最多 2 位，小数舍入只影响输出，不回写原记录。

## 图片归档

图片首先通过 `POST /media` 上传，multipart 字段为 `file`、`date`、`purpose`、可选 `capturedAt`、`caption` 和必填的 `source` JSON 字符串。purpose 为 `meal/progress/label/other`，每张图片都能独立按日期查询，适用于食物照片、体态对比和营养标签。业务日期由 dot 根据用户表达明确传入，不直接把 EXIF 日期当记账日期。

首版接受 JPEG、PNG、WebP，单图最多 10 MB，解码后不超过 2500 万像素，每餐最多 8 张图。HEIC 由客户端转为支持格式后再上传；其他格式返回 415。服务端验证实际格式、限制解码资源、移除 EXIF 和位置元数据，保存不可执行的标准图片。`sha256` 指保存后文件的摘要；请求幂等指纹使用上传字节摘要，两者可能不同。

响应返回 `id/contentType/byteSize/width/height/sha256/date/purpose/caption/contentUrl/version`，contentUrl 为受相同身份校验的相对地址 `/api/v1/media/{id}/content`。不创建永久公开链接、不把令牌放 URL、不接受由服务端抓取的远程 URL。dot 读取照片时携带认证头；客户端若无法给图片请求加头，应通过自身已授权的文件读取能力获得字节，不能改成公开图片托管。

后续 `POST /meals` 引用 `mediaIds`，服务端校验附件属于同一 owner、可读取且未删除。重复字节可共用底层文件，但不同上传记录保留独立日期和备注；同一 source.externalId 重试才返回同一媒体记录。修改图片元数据不能替换文件内容，换图需要上传新图并修改餐食关联。

餐食删除或解除关联不会删除图片。`DELETE /media/{id}` 在仍被餐食引用时返回 `409 MEDIA_IN_USE` 并列出关联记录 ID，客户端先解除关联，再删除。删除后立即拒绝内容读取，并保留 7 天内部恢复窗口后清理未被其他媒体记录使用的文件。独立的体态照片通过 purpose=progress 检索，不进入摄入和运动统计。

## 运动和身体数据

workout 的业务字段为 `date/time/type/durationMinutes/activeKcal/reviewRequired/note/source`。durationMinutes 为 0.01–1440，activeKcal 为 null 或 0–10000。用户手动创建的 origin 为 manual，Nothing 导入的 origin 为 nothing。导入记录允许按版本修正，保留原始外部标识，重新导入同一上游记录不会覆盖用户修正。

### 体重、体脂率和腰围

通过 `POST /api/v1/measurements` 保存一次测量。`weightKg` 为 10–600 kg，`bodyFatPct` 为大于 0、小于 100 的百分数，`waistCm` 为 15–350 cm。三项至少填一项。同一次称量可一起保存体重和体脂，单独测得体脂时也能单独写入。`21.5` 表示 `21.5%`。未知值可省略或传 `null`，响应中的未知值为 `null`。

```json
{
  "date": "2026-11-25",
  "time": "07:30:00",
  "weightKg": 70.25,
  "bodyFatPct": 21.5,
  "source": { "client": "dot", "externalId": "msg_example:measurement:0" }
}
```

`GET /api/v1/measurements?from=2026-11-01&to=2026-11-25&metric=bodyFatPct` 返回区间内有体脂读数的测量明细。`metric` 也可选 `weightKg` 或 `waistCm`，省略时返回所有身体测量。按 ID 获取或用 `PATCH` 修正读数时沿用版本校验。补录同一次测量的体脂用 PATCH，另一次称量用 POST。PATCH 清除数值后仍须至少保留一项测量。

`GET /api/v1/days/{date}` 的 `data.summary.measurement` 分别返回当天最近的体重、体脂率和腰围，以及各自的记录 ID。三个数值可以来自不同测量。每项选取该指标非空的记录，按测量时间取最近值，同一时间以 `createdAt`、`id` 决定顺序。只有无测量时间的记录时按 `createdAt`、`id` 选取，并通过 `weightSelectionBasis`、`bodyFatSelectionBasis` 或 `waistSelectionBasis` 返回 `created_at`。没有读数的指标返回 `null`。

`GET /api/v1/trends?metric=bodyFatPct` 支持按日、周或月查询体脂趋势，响应的 `unit` 为 `%`。每个有读数的日期仅贡献一次测量，多日汇总返回日值均值与最后一个有记录日的读数。dot 比较两次体脂率时用百分点表示差值，例如从 22% 到 21.5% 是下降 0.5 个百分点。

### 每日活动和摄入目标

activity 每日最多一条，字段为 `date/asOf/steps/activeKcal/totalKcal/durationMinutes/source`。asOf 为当天已知快照时间；`isPartial` 由服务端沿用当前的 23:59 判定并返回 `completenessBasis=timestamp_heuristic`，不宣称设备保证全天完整。手动 PUT 替换必须符合版本条件；Nothing 导入仅接受时间更晚的快照。步数为 0–250000，热量为 0–15000，时长为 0–1440。

目标按 `effectiveFrom` 保存 `intakeKcal`，范围 500–10000。历史日期取该日期之前最近一项，不因修改今天的目标改变以前的口径。`DELETE /targets/{effectiveFrom}` 删除一项变更后，该区间回退到之前生效项，响应以 `affectedRange` 列出受影响起止日期，尚无下一生效项时 to 为 null；不能删除迁移的基线项。旧日志仅有单个全局目标，迁移保留为 legacy 基线，并返回 `targetHistoryKnown=false`，不得声称恢复了过去实际生效日期。

## 错误与容量

```json
{
  "type": "about:blank",
  "title": "记录版本冲突",
  "status": 412,
  "detail": "记录已被其他客户端修改，请重新读取后修正。",
  "instance": "/api/v1/meals/meal_01",
  "code": "VERSION_CONFLICT",
  "requestId": "req_example",
  "errors": [{ "pointer": "/version", "code": "STALE_VERSION" }]
}
```

| 状态 | 典型 code | dot 处理 |
| --- | --- | --- |
| 400 | INVALID_JSON、INVALID_CURSOR、INVALID_DATE_RANGE | 修正请求参数，不自动重试原请求 |
| 401 | UNAUTHENTICATED、TOKEN_REVOKED | 停止调用，请用户检查客户端凭据 |
| 403 | INSUFFICIENT_SCOPE、ORIGIN_FORBIDDEN | 说明缺少的权限，不尝试绕过 |
| 404 | NOT_FOUND | 核对 ID；其他 owner 的资源也返回此状态 |
| 409 | IDEMPOTENCY_CONFLICT、EXTERNAL_ID_CONFLICT、MEDIA_IN_USE、REQUEST_IN_PROGRESS | 按 code 读取资源、处理关联或等待 |
| 410 | SOURCE_RECORD_DELETED | 告知用户原记录已删除 |
| 412／428 | VERSION_CONFLICT／PRECONDITION_REQUIRED | 读取最新 ETag，不直接拿新版本重放旧的整对象 |
| 413／415 | PAYLOAD_TOO_LARGE／UNSUPPORTED_MEDIA_TYPE | 缩小文件或转换格式 |
| 422 | VALIDATION_FAILED、UNRESOLVED_DRAFTS | 根据 JSON Pointer 指向的字段补充或修改 |
| 429 | RATE_LIMITED | 遵循 Retry-After，保留幂等键 |
| 503 | TEMPORARILY_UNAVAILABLE、STORAGE_FULL | 同键有限退避重试；仍未确认时不能声称成功 |

个人部署默认每令牌每分钟读取 120 次、普通写入 30 次、媒体上传 10 次。超限返回 429。JSON 正文默认上限 1 MB，附件总容量默认 5 GB。配额可配置，`GET /capabilities` 返回实际值和剩余配额。上传超过配额时先失败，避免出现已登记但无法读取的附件。

## 存储和现有网页的衔接

自托管服务按资源在 SQLite 中保存记录和版本。网页、dot 和 Nothing 导入共用这套存储。

| 表或目录 | 作用 |
| --- | --- |
| `fieldnote_records`、`fieldnote_state` | 健康记录、日期状态、目标历史、图片元数据和日志版本 |
| `fieldnote_image_bytes` | 根据 SHA-256 去重的图片字节，按用户隔离 |
| `fieldnote_tokens`、`fieldnote_idempotency` | 令牌摘要、权限、撤销状态和 72 小时内的写入回执 |
| `fieldnote_sources` | 外部 ID 去重、原始创建内容的摘要和删除标记 |

写入在一个 SQLite 事务内保存记录、版本和幂等回执。图片字节与元数据同库保存，现有 `selfhost/backup.js` 可一次备份两者。删除图片后接口立即停止提供内容。在 7 天保留期届满后，服务会清理没有其他记录引用的图片字节。

启动时事务内迁移旧日志，保留原记录 ID、日志版本、目标、每日完整状态及休息日。缺少的餐食时间和体脂率保留为空。旧版只有一个全局目标，迁移后将它作为基线并保留 `targetHistoryKnown=false`。如果旧库存在不合法的记录，迁移回滚。升级前可用 SQLite 快照保留回退版本。

自托管版的 `/api/health-log` 给网页提供兼容的数据视图，网页写入和 Nothing 导入均使用同一套资源。网页写入沿用日志版本检查，保留图片关联和草稿。遇到旧网页可能一次删掉同一天多条身体测量时，接口返回 409，请刷新网页再操作。Nothing X 仍用旧版 Basic 认证接口。网页全量写入沿用旧接口的 1.5 MB 请求上限。dot 使用 v1 单条记录接口。

## dot 对接约定

dot 的初始化配置只需要 baseUrl、令牌和可信 CA。先查 capabilities 与 me，核对服务能力和令牌权限。自然语言解析与照片估算由 dot 或其既有识图能力完成，本服务首版不另行假定已有 AI 模型，也不把用户照片发送给额外的识别服务。

dot 保存最近操作的资源 ID、版本和幂等键。记录「刚才那餐」时优先使用对话中已确认的 ID；查询得到多个候选时先让用户选择，不随机改一条。同一照片的重试使用同一 externalId；同一消息中独立的食物记录使用不同条目 ID。用户只查询数据时调用 GET，不顺带改目标、补齐缺失天数或把估算升级为确定值。

明确的「记下来」可以保存标记为估算的 recorded 餐食，不要求每次重复确认；没有份量或用户只要识别时保留 draft。上传成功但餐食写入失败时，复用 mediaId 重试；不要重新上传同一张图片。超时先用原幂等键重试或按 externalId 查询，确认服务端结果后再回复。

查询回复至少说明日期区间、摄入口径、是否完整以及估算情况。写入回复至少说明保存状态、记录 ID、业务日期、主要数值和当日有效合计。照片记录回复是否保存原图及关联餐食，不能把「已分析」说成「已上传」。删除、模式切换和覆盖式修改必须对应用户的明确意图；API 保持可诊断错误，不通过文本猜测用户是否同意。

## 验证接口

运行 `npm run build` 和 `npm test`。端到端测试以真实 HTTP 调用覆盖全部 37 个操作，用 OpenAPI 核对成功响应，并验证令牌权限、重试去重、并发版本、体脂和饮食口径、图片访问控制、Nothing 导入、旧库迁移和备份恢复。HTTPS 测试使用本地 CA 验证服务证书。

## 协议依据

机器契约固定使用 [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)。HTTP 条件请求和状态遵循 [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)，错误对象采用 [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)，局部修改使用 [RFC 7396 JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396.html)。Merge Patch 的 null 表示移除属性，本项目在保存前将被清除的可空业务字段规范化为 null；必填且不可空的字段不允许移除。幂等键的 72 小时保留、source 去重、资源字段和卡路里汇总规则是本项目的应用约定。
