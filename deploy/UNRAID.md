# 在 Unraid 上部署

本版本面向自己的局域网和 WireGuard。Docker 中的 Node 服务使用 Unraid 本地 SQLite，Caddy 提供 HTTPS；没有公网端口转发、ChatGPT 工作区依赖或 MySQL。GitHub Actions 构建并发布 Linux amd64 镜像。源码、镜像和工作流程都不包含日志、原始导出、密码或证书私钥。

## 准备

1. 使用有访问权的 GitHub 账号，在 Unraid 终端登录私有 GitHub Container Registry。需要一个 classic PAT（仅 `read:packages`）。在终端交互输入，不要写进脚本或 GitHub。
   ```sh
   docker login ghcr.io -u luyangkk
   ```
2. 将本目录下 `compose.yaml`、`Caddyfile` 和 `unraid.env.example` 复制到 Unraid 本地的私有部署目录。将示例复制为 `unraid.env`，确认实际的 SSD 池名、内网 IP 和端口。只把 8443 绑定到 Unraid 内网 IP；不要从公网转发，外出先连现有 WireGuard。环境文件不需要包含密码。
3. 在 Unraid 以 root 准备目录和密码文件。以下使用示例的 `cache` 池；先确认该池已挂载。若已有密码文件，不要重建。
   ```sh
   BASE=/mnt/cache/appdata/health-fieldnote
   umask 077
   install -d -m 0700 -o 1000 -g 1000 "$BASE/data"
   install -d -m 0700 "$BASE/tls"
   if [ ! -e "$BASE/fieldnote-password" ]; then
     (set -o noclobber; openssl rand -hex 32 > "$BASE/fieldnote-password")
     chown 1000:1000 "$BASE/fieldnote-password"
     chmod 0600 "$BASE/fieldnote-password"
   fi
   ```
4. 在部署目录中执行（需要 Docker Compose v2）。生产建议将 `FIELDNOTE_IMAGE` 设为已经验证的 `sha-<Git commit>` 标签，升级时再改。
   ```sh
   docker compose --env-file unraid.env pull
   docker compose --env-file unraid.env up -d
   docker compose --env-file unraid.env ps
   ```
   如果 Unraid 没有 `docker compose`，先通过 Unraid 的 Apps 安装 Docker Compose Manager，或使用已配置的 Compose 管理方式。

## 首次访问与迁移

- 在 Unraid 本机取得 Caddy 根证书（`$BASE/tls/caddy/pki/authorities/local/root.crt`）。通过可靠的私有方式将 **root.crt** 送到自己的设备，核对指纹后再信任；不要复制或分享任何私钥。iPhone 安装证书后还要在「设置 → 通用 → 关于本机 → 证书信任设置」开启信任。不要绕过浏览器证书错误输入密码。
- 打开配置的 HTTPS 地址（示例 `https://192.168.1.10:8443`）。用户名是 `fieldnote`，密码是刚生成的文件内容，用密码管理器保存。手机出门时仅走现有的私有 VPN。先在 Wi‑Fi 验证，再在蜂窝网络上连接 WireGuard 验证。
- 网站首次可在「数据管理」开启服务器存储。使用空库导入从原站导出的 JSON，核对各类记录数量和日期范围；导入是合并，不是还原。确认跨设备读取后再切换使用，原站不做自动修改或删除。

## 一致性备份与还原

在线备份命令（返回容器内备份路径，默认写到挂载目录的 `backups/`）：

```sh
docker compose --env-file unraid.env exec -T fieldnote node selfhost/backup.js
```

将校验过的快照另存到独立磁盘或设备并加密。不要直接复制仍在使用的 SQLite 主库来做备份。

还原前保留一份当前快照。停止服务，**保留整个原数据目录**，让 `FIELDNOTE_DATA_DIR` 指向另一个本地空目录；把选定快照复制为新目录中的 `health.sqlite`，设置目录归属 1000:1000、权限 0700，文件归属相同、权限 0600。重新启动并核对数据。不要把旧库的 WAL/SHM 文件拷进新目录。更改目录可回滚，原目录不会被覆盖。
