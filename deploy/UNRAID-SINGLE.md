# Unraid：单容器，自带 HTTPS

单容器直接提供 HTTPS，停用对 Caddy 的依赖。旧版双容器部署仍见 [UNRAID.md](UNRAID.md)，同一个 SQLite 数据目录只能由一个运行中的应用管理。

## 准备

在 Unraid 终端，将仓库的 `deploy/init-tls.sh` 保存到当前目录，再运行以下命令。示例 IP 是 `10.0.0.66`，替换为自己的 Unraid 内网 IP。示例路径使用阵列实体盘下的持久化目录，不使用 Mover 挪动数据库。

```sh
BASE=/mnt/disk1/notes/HealthFieldNote/.fieldnote-runtime
umask 077
install -d -m 0700 "$BASE"
install -d -m 0700 -o 1000 -g 1000 "$BASE/data"
if [ ! -e "$BASE/fieldnote-password" ]; then
  (set -o noclobber; openssl rand -hex 32 > "$BASE/fieldnote-password") &&
    chown 1000:1000 "$BASE/fieldnote-password"
fi
sh ./init-tls.sh "$BASE" 10.0.0.66
```

脚本不替换现有 CA。只有证书临近到期（30 天内）、失效或 IP 变化才重新签发。续期前先停容器，更新后再启动。把 CA 私钥留在 `$BASE/ca/`，不要映射到容器或分发。本版使用 `tls-direct`，旧版 Caddy 的 `tls` 目录无需改动，可保留用于回滚。

如 GHCR 镜像未公开，在 Unraid 用 `docker login ghcr.io -u luyangkk` 登录，密码为仅有 `read:packages` 的 classic PAT。不要把 token 写进容器配置或仓库。

## Unraid Docker → Add Container

| 项目 | 值 |
| --- | --- |
| Name | `fieldnote` |
| Repository | `ghcr.io/luyangkk/health-fieldnote:latest` |
| Network Type | Bridge |
| Privileged | Off |
| Variable | `FIELDNOTE_ORIGIN=https://10.0.0.66:8443` |
| Variable | `FIELDNOTE_TLS_DIR=/run/fieldnote-tls` |
| Variable | `PORT=8443` |
| Path Read/Write | `$BASE/data` → `/data` |
| Path Read Only | `$BASE/fieldnote-password` → `/run/secrets/fieldnote_password` |
| Path Read Only | `$BASE/tls-direct` → `/run/fieldnote-tls` |
| Advanced View → Extra Parameters | `-p 10.0.0.66:8443:8443/tcp --read-only --cap-drop=ALL --security-opt=no-new-privileges:true` |

Host Path 必须填完整路径，不能直接写变量 `$BASE`。不要另建 Port 映射或映射 8080；用户环境里的 Caddy 如果已使用 8443，先停它，暂不删除。若旧版应用已经有数据，先做 SQLite 一致性备份，再停旧应用，用同一个 `data` 目录与密码文件。容器名字冲突时新实例可叫 `fieldnote-single`，不要求固定名称。

只把 `$BASE/tls-direct/ca.crt` 复制到自己的设备，核对 SHA-256 指纹后设为可信；不要分发私钥，也不要忽略证书报错。打开 `https://10.0.0.66:8443`，用户名 `fieldnote`，密码来自文件。应用登录与 Chrome、ChatGPT、GitHub 登录都独立。首次在「数据管理」开启存储，空库再导入 JSON；旧库已挂载则无需重新导入。

先验证局域网，两台设备看同一条记录。外出连 WireGuard，不在路由器转发 8443。备份可用 `docker exec fieldnote node selfhost/backup.js`；如果容器名不同，替换命令里的名字。
