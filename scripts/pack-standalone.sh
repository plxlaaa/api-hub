#!/usr/bin/env bash
# 打包 standalone 产物，生成免依赖部署用的 tarball。
#
# 用法：
#   bash scripts/pack-standalone.sh [输出路径]
# 默认输出：./api-hub-standalone.tar.gz
#
# 为什么需要这个脚本：
#   1. `tar` 的多个 `-C` 参数是「相对上一次 -C 之后的目录」解析的，
#      写成 `-C .next/standalone . -C .next/static .next/static` 会去找
#      `.next/standalone/.next/static`，直接 Cannot stat。改用 staging 目录规避。
#   2. `.next/standalone/db/` 里可能有 credentials.env / custom.db / custom.db-wal，
#      直接打包会连管理员凭据和上游 API Key 一起发出去，必须显式剔除。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/api-hub-standalone.tar.gz}"

cd "$ROOT"

if [ ! -d .next/standalone ]; then
  echo "错误：未找到 .next/standalone，请先执行 npm run build" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '$STAGE'" EXIT

echo "==> 收集 standalone 产物"
cp -a .next/standalone/. "$STAGE/"

# 安全：剔除随构建复制进去的运行时数据与凭据
rm -rf "$STAGE/db"

echo "==> 补齐静态资源与部署物料"
mkdir -p "$STAGE/.next"
[ -d .next/static ] && cp -a .next/static "$STAGE/.next/static"
[ -d public ] && cp -a public "$STAGE/public"
[ -d prisma ] && cp -a prisma "$STAGE/prisma"
[ -d deploy ] && cp -a deploy "$STAGE/deploy"
[ -f .env.example ] && cp -a .env.example "$STAGE/.env.example"
[ -f INSTALL.md ] && cp -a INSTALL.md "$STAGE/INSTALL.md"
[ -f README.md ] && cp -a README.md "$STAGE/README.md"

echo "==> 校验关键文件"
missing=0
for f in server.js package.json public/logo.svg prisma/schema.prisma; do
  if [ -e "$STAGE/$f" ]; then
    echo "    ✓ $f"
  else
    echo "    ✗ $f 缺失" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || { echo "打包中止：关键文件缺失" >&2; exit 1; }

# 注意：这里必须按「文件名」匹配，不能用 grep -r 扫内容——
# 打包进来的 JS chunk 里含有 .db 字面量（sqlite 相关代码），扫内容必然误报。
leaked="$(find "$STAGE" \
  \( -name 'credentials.env' -o -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' \) \
  -print -quit)"
if [ -n "$leaked" ]; then
  echo "打包中止：暂存目录仍存在凭据或数据库文件 -> ${leaked#$STAGE/}" >&2
  exit 1
fi

echo "==> 生成 $OUT"
tar czf "$OUT" -C "$STAGE" .

echo "完成：$(du -h "$OUT" | cut -f1)  $OUT"
echo "部署：sudo mkdir -p /opt/api-hub && sudo tar xzf $(basename "$OUT") -C /opt/api-hub"
