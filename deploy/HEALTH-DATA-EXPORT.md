# Health Data Export 自动导入

自托管版提供 `POST /api/import/health-data-export`，接收 Health Data Export 的 JSON、Raw、Single File 导出。接口使用个人访问令牌，App 只需填写 HTTPS 地址和 Bearer token，不需要配置额外请求头。Sites 版不提供此接口。

请求和响应契约见 [Webhook OpenAPI](../docs/api/health-data-export.openapi.json)。本接口独立于 `/api/v1`，不会改变现有 dot 写入接口的请求头要求。

支持导入体重、体脂率、训练和每日活动。心率、睡眠、GPS 路线、距离、账号及设备资料不写入数据库。接收时仍会读入整个 JSON，因此建议在 App 中只选择需要的指标。

## 在 App 中配置

先部署包含本接口的镜像。启动时会自动将数据库升级到版本 3，并保留原有记录；升级前使用项目的备份工具留一份一致性备份。更换容器时沿用原来的 `/data` 挂载。

在 Unraid 终端创建令牌。以下使用容器名 `health-fieldnote`，如果实际名称不同，请替换。

```sh
docker exec health-fieldnote node selfhost/token.js create health-data-export records:write
```

把输出中的 `token` 保存在自己的设备上，不要把令牌放进仓库或聊天记录。令牌具有写入记录的权限；网页登录密码和这个令牌是两套凭据。需要用其他客户端查询导入结果时，可以另建带 `records:read` 的令牌。

在 Health Data Export 的自动化页面填写：

| 配置项 | 值 |
| --- | --- |
| Date Range | Last 7 Days |
| Format | JSON |
| Aggregation | Raw |
| Destination | Webhook |
| File Organization | Single File |
| Webhook URL | `https://10.0.0.66:8443/api/import/health-data-export` |
| Bearer token | 完整的 `fn_…` 令牌，不加 `Bearer` 前缀 |
| Notify on Failure | 建议开启，便于发现认证或数据格式问题 |

URL 中的 IP 和端口应与自己的站点一致。iPhone 需能访问该地址，并信任部署的 CA。局域网地址只在相应网络中可达，外出使用已有的私有 VPN。App 的自动化执行时间由 iOS 决定，可能延迟。

选择体重、体脂率和训练。需要每日活动时，同时选择 Steps、Active Energy、Basal Energy；可再选择 Exercise Minutes。缺少锻炼时间时，接口将其保存为 `null`，不会填写零，也不会用训练总时长代替。

## 数据格式和换算

本接口按 Health Data Export 1.4 原始导出的结构适配。根对象包含 `export_date`、可选的 `date_range`、`metrics` 和 `workouts` 等数组。`export_date` 必须是带时区的 ISO 8601 时间；只改变这个字段不会导致重复新增记录。

以下为合成的体重样本，数值与编号不来自用户文件。

```json
{
  "export_date": "2026-11-26T06:00:00Z",
  "metadata": {
    "app_version": "1.4",
    "aggregation_level": "raw",
    "export_format": "json"
  },
  "date_range": {
    "days": 7,
    "start": "2026-11-19T16:00:00Z",
    "end": "2026-11-26T06:00:00Z"
  },
  "metrics": [
    {
      "id": "HKQuantityTypeIdentifierBodyMass",
      "unit": "kg",
      "aggregation_level": "raw",
      "data_points": [
        {
          "id": "synthetic-weight-001",
          "start_date": "2026-11-26T00:00:00Z",
          "end_date": "2026-11-26T00:00:00Z",
          "timestamp": "2026-11-26T00:00:00Z",
          "value": 70.25,
          "unit": "kg",
          "provenance": "reported",
          "source": { "name": "Synthetic Scale" }
        }
      ]
    }
  ],
  "workouts": []
}
```

| 导出数据 | 保存方式 |
| --- | --- |
| `HKQuantityTypeIdentifierBodyMass` | 转为 kg，最多保留两位小数 |
| `HKQuantityTypeIdentifierBodyFatPercentage` | 保存百分数。1.4 原始导出中，小于 1 的正数按 HealthKit 小数换算，例如 `0.215` 转为 `21.5`；已经是 `21.5` 的值直接使用 |
| `workouts` | `duration` 按秒换算为分钟，能量转为 kcal，保留训练的稳定 ID。报告时长与起止时间跨度明显不一致时标为待核对 |
| Steps、Active Energy、Basal Energy | 按北京时间汇总成每日快照。总消耗为活动消耗加静息消耗，不再加训练热量或 `derived.totalEnergyBurned` |
| Exercise Minutes | 转为分钟；未提供时保留为空 |

所有业务日期按 `Asia/Shanghai` 计算。跨午夜的活动样本按时段比例分配到两天，属于估算分配。只有导出范围覆盖当天零点的日期才生成活动快照，滚动区间第一天若只包含部分时段则跳过。当天快照标为未完成；完整历史日期使用日终时间。

每日活动按来源分别汇总，只选择覆盖时段最多的一个来源，覆盖相同则使用稳定标识排序。不会把 iPhone 和手表的步数相加；出现多个来源时返回警告。这种选择不等同于健康 App 的来源优先级算法。某一来源存在互相重叠的活动时段时，跳过该日快照并返回警告，避免重复累计。

## 更新和去重

体重、体脂率、训练优先使用样本 ID。没有 ID 的身体测量使用指标、来源和起止时间生成稳定标识。去重范围是同一站点所有导入令牌，因此更换令牌或客户端名称不会再次新增相同样本。一个导出内同 ID 内容不一致时，整批拒绝。

每日活动每个日期只有一个快照。每次从当前导出的原始样本重新计算全天累计值，再与已保存值比较；不会将最近 7 天的累计值继续加到旧快照上。数值下降也可以是一次有效修正，但必须来自更新的导出。

| 情况 | 处理 |
| --- | --- |
| 相同标识、相同内容 | 跳过，不增加日志版本 |
| 相同内容、更新的导出时间 | 只推进内部时间标记，不增加日志版本 |
| 相同标识、内容变化、导出更新 | 原位更新，记录 ID 保持不变 |
| 比已处理版本更旧的导出 | 跳过旧数据；此前未见过的样本仍可补入 |
| 相同导出时间却出现不同内容 | 返回 `409 EXPORT_VERSION_CONFLICT`，整批回滚 |
| 网页或其他 API 已手工修改记录 | 保留手工版本，计入 `conflicts` |
| 已删除的导入记录再次出现 | 保留删除状态，不自动恢复 |
| 当天活动已由 Nothing X 或手工记录占用 | 保留原记录，计入 `conflicts` |
| 同一时刻已有同值测量或同类训练 | 跳过并提示已有记录，避免重复记账 |

导出缺少某个旧样本，不表示该样本已删除。可能是选择范围、指标或读取权限变化，因此接口不会根据缺失项删除历史测量或训练。每日快照的更正仅作用于本次可完整计算的日期。

整批记录和去重标记在同一个 SQLite 事务内保存；解析失败或事务失败不会留下半批记录。单个样本的更新时间按 `export_date` 比较，不采用请求到达顺序。备份包含这些标记，恢复后仍可去重。

## 返回结果

成功返回 HTTP `200`。例如：

```json
{
  "data": {
    "added": 4,
    "updated": 0,
    "skipped": 0,
    "stale": 0,
    "conflicts": 0,
    "changed": true,
    "details": {
      "measurements": { "added": 2, "updated": 0 },
      "workouts": { "added": 1, "updated": 0 },
      "activity": { "added": 1, "updated": 0 }
    },
    "ignored": 0,
    "warnings": [],
    "revision": 1,
    "updatedAt": "2026-11-26T06:01:00.000Z",
    "test": false,
    "dryRun": false,
    "wouldChange": false
  }
}
```

`stale` 和 `conflicts` 都包含在 `skipped` 中。`changed` 表示本次实际写入了新增或更新的业务记录；纯重复请求保持原来的 `revision`、`updatedAt` 和记录版本。`ignored` 为跳过的非支持指标样本数，加上分类指标组和睡眠汇总数，不包含训练内部未读取的心率或路线点。

`warnings` 可能包含：

| 值 | 含义 |
| --- | --- |
| `MISSING_EXERCISE_TIME` | 每日活动缺少锻炼时间，已保留为空 |
| `MISSING_ACTIVITY_METRICS` | 无法凑齐同一天的步数、活动消耗和静息消耗，跳过该日活动 |
| `INCOMPLETE_ACTIVITY_RANGE` | 导出范围没有覆盖该日零点，或样本超出范围，跳过对应活动样本 |
| `MULTIPLE_ACTIVITY_SOURCES` | 同一指标有多个来源，仅选一个来源汇总 |
| `OVERLAPPING_ACTIVITY_SAMPLES` | 存在重叠时段，跳过该日活动 |
| `WORKOUT_DURATION_REVIEW` | 训练时长需要核对 |
| `LOCAL_CHANGE_PRESERVED` | 保留本地或其他客户端的修改 |
| `DELETED_RECORD_PRESERVED` | 保留删除状态 |
| `EXISTING_RECORD_PRESERVED` | 同一时刻已有测量或同类训练，未再新增 |

App 通常只按 HTTP 状态显示投递成功。HTTP `200` 不代表所有项目均新增：部分项目可能跳过或被保留。需要核对明细时查看响应中的统计和警告。

## 预览和连通性测试

将 URL 临时设为 `https://10.0.0.66:8443/api/import/health-data-export?dryRun=true` 可预览。响应提供预计的新增、更新和跳过数量，但不保存记录或内部时间标记；`changed` 为 `false`，`wouldChange` 表示正式导入是否会产生变化，`revision` 仍为当前日志版本。正式自动化应去掉查询参数。

接口接受完整导出结构中的空数组，返回无变化。也支持不含健康数据的 `{"test":true}`、`{"is_test":true}` 或 `{"type":"test"}` 测试对象。测试请求仍需有效令牌。App 的实际 Send Test Payload 字段尚未取得，若其测试对象不符合这些形状，接口会返回格式错误；可先用一次 Raw 导出验证正式传输。

## 限制与错误

请求正文最多 35 MB；数值指标合计最多 150000 个数据点，最多 250 个指标组和 10000 条训练。超限时缩短时间范围，或取消心率、GPS 等不需要的导出项目。单个导入令牌每分钟最多 30 次请求。

| 状态 | 含义 |
| --- | --- |
| `400` | JSON、UTF-8 或查询参数无效 |
| `401` | 令牌无效或已撤销 |
| `403` | 缺少 `records:write` 权限，或请求携带跨站 Origin |
| `405` | 方法错误，使用 POST |
| `409` | 相同导出时间对应不同版本的内容 |
| `413` | 请求体或样本数量超限 |
| `415` | 使用 `Content-Type: application/json` |
| `422` | 非 Raw 模式、支持指标中的无效数据、单位或时间错误 |
| `429` | 请求频率过高，按 Retry-After 稍后重试 |
| `503` | 事务或存储暂不可用，可重试同一个导出 |

导出时间允许最多领先服务器 5 分钟。客户端时间明显不准时应先校时，以免较远的未来时间阻止后续正常数据更新。

浏览器、JSON 备份与 v1 API 现在允许每日活动的锻炼时长为 `null`，以区分未知与零。其他活动数值仍需完整；旧客户端如果假定该字段总是数字，应先处理空值。

适配测试使用合成的 1.4 Raw 样本。对话中原始 JSON 的临时文件路径已失效，未将真实文件加入仓库，也未进行这份原文件或 App Webhook 的实机回放。
