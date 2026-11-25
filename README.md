# 体能手记 · Health Fieldnote

记录饮食、训练、体重和腰围，查看 7 天或 30 天趋势。支持 Nothing X 的加密 ZIP、XLSX 和站内 JSON 备份。手表导入只取训练明细和每日活动快照，不读取 GPS 路线、心率、压力或账号信息。示例数据与个人日志分开。

## 本地开发

使用 Node.js 22.13+（测试使用 Node 内置 SQLite）。

```sh
npm ci
npm run dev
npm test
npm run build
```

开发服务器可使用浏览器本地日志。完整云端模式依赖 OpenAI Sites 的私有站点身份和 D1 的 `DB` 绑定：`drizzle/` 包含结构迁移，`worker/api.js` 处理校验、账号隔离和并发更新；构建产物入口是 `dist/server/index.js`。仓库不绑定生产站点；部署到自己的私有站点时，在托管清单中配置其项目 ID。不要把 Worker 原样部署到允许客户端伪造身份请求头的环境。

站内可选择开启跨设备云端日志。网页手动导入的原始文件和解压密码只在浏览器内处理；自托管导入接口在服务端内存中解析，不保存原始文件或密码。真实健康记录、导出附件、数据库内容和生产密钥不属于这个仓库，备份请另存。

## Unraid 自托管

默认使用 [单容器部署及迁移](deploy/UNRAID-SINGLE.md)；如需保留 Caddy，可参考[旧版双容器指引](deploy/UNRAID.md)。GitHub Actions 发布 amd64 镜像到 GHCR。自托管版使用本地 SQLite 和独立账号，不依赖 ChatGPT 工作区。Sites 构建方式仍可用。

dot 等客户端可通过 [Nothing X 导入接口](deploy/IMPORT-API.md)上传 ZIP／XLSX 或提交工作表原始行，支持预览和重复导入。
