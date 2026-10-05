#Requires -Version 5.1
<#
 ============================================================
  API Hub 一键安装脚本（Windows 版）
  适用：Windows 10 / 11 / Server 2016+（PowerShell 5.1+）
  用法（管理员 PowerShell）：
    .\install-api-hub.ps1 -Token ghp_xxx
    .\install-api-hub.ps1 -Token ghp_xxx -Port 3000 -Dir C:\api-hub
    .\install-api-hub.ps1 -Token ghp_xxx -UseNssm      # 注册为真正的 Windows 服务（开机无需登录）
    .\install-api-hub.ps1 -Update -Token ghp_xxx       # 更新代码，保留数据库
    .\install-api-hub.ps1 -Uninstall                   # 卸载，保留数据库
    .\install-api-hub.ps1 -Precheck                    # 只做环境自检
    .\install-api-hub.ps1 -Status                      # 查看状态与首次设置令牌
  参数：
    -Token    GitHub PAT（需 repo 读权限，私有仓库必填；或设环境变量 GITHUB_TOKEN）
    -Dir      安装目录（默认 C:\api-hub）
    -Port     监听端口（默认 3000）
    -Branch   分支（默认 main）
    -CN       走国内镜像 npmmirror
    -Docker   用 Docker 部署（不装本机 Node/bun，适合无管理员环境）
    -NoFirewall  不自动放行防火墙端口
    -Purge    卸载时连数据库一起删
 ============================================================
#>
[CmdletBinding()]
param(
    [string]$Token      = $env:GITHUB_TOKEN,
    [string]$Dir        = 'C:\api-hub',
    [int]   $Port       = 3000,
    [string]$Branch     = 'main',
    [switch]$CN,
    [switch]$UseNssm,
    [switch]$Docker,
    [switch]$NoFirewall,
    [switch]$Update,
    [switch]$Uninstall,
    [switch]$Purge,
    [switch]$Precheck,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$Owner  = 'plxlaaa'
$Repo   = 'api-hub'
$TaskName = 'APIHub'

function Info($m){ Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Warn($m){ Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "[FAIL] $m" -ForegroundColor Red; exit 1 }
function Step($m){ Write-Host ""; Write-Host "===== $m =====" -ForegroundColor Cyan }

# ---------- 管理员权限 ----------
function Assert-Admin {
    # Docker 模式不需要管理员（只需 Docker Desktop 已启动）
    if ($Docker -and -not ($Update -or $Uninstall -or $Precheck -or $Status)) {
        Info "Docker 模式：跳过管理员检查"
        return
    }
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Die "请右键「以管理员身份运行」PowerShell 再执行本脚本（Docker 模式可加 -Docker 免管理员）"
    }
}

# ---------- Docker 部署 ----------
function Invoke-DockerDeploy {
    Step "Docker 部署"
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Die "未安装 Docker Desktop。请从 https://www.docker.com/products/docker-desktop/ 安装后重试，
或去掉 -Docker 走本机安装（需管理员 + Node 20+）"
    }
    try { docker info | Out-Null } catch {
        Die "Docker 未运行。请先启动 Docker Desktop（托盘图标）后重试"
    }
    docker compose version | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Die "未找到 docker compose 插件。Docker Desktop 自带 compose，请升级到最新版"
    }

    Fetch-Source
    Push-Location $Dir
    if (-not (Test-Path 'docker-compose.yml')) { Pop-Location; Die "仓库中缺少 docker-compose.yml" }
    # 写 .env 供 compose 插值
    $cn = if ($CN) { '1' } else { '0' }
    "PORT=$Port`nCN_MIRROR=$cn" | Set-Content -Path (Join-Path $Dir '.env') -Encoding UTF8

    # 更新前备份数据库
    $dbLocal = Join-Path $Dir 'db'
    if (Test-Path $dbLocal) {
        $bak = "C:\api-hub-backups\db-$(Get-Date -Format yyyyMMdd-HHmmss)"
        New-Item -ItemType Directory -Path $bak -Force | Out-Null
        Copy-Item -Path (Join-Path $dbLocal '*') -Destination $bak -Recurse -Force -ErrorAction SilentlyContinue
        Ok "数据库已备份到 $bak"
    }

    docker compose up -d --build
    if ($LASTEXITCODE -ne 0) { Pop-Location; Die "docker compose up 失败（见上方输出）" }
    Pop-Location
    Ok "容器已启动"
    Wait-Healthy
    Show-Summary
    exit 0
}

function Wait-Healthy {
    Step "启动并健康检查"
    $i = 0
    while ($i -lt 90) {
        Start-Sleep -Seconds 1; $i++
        try {
            # 用 /api/health 而非 /：后者是前端页面，DB 挂了照样 200，
            # 会让安装脚本在数据库不可用时误报「已就绪」。
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 3
            Ok "服务已就绪（${i}s，数据库就绪）：http://127.0.0.1:$Port"
            return
        } catch { }
    }
    Die "90s 内未通过健康检查。Docker 看日志：docker compose logs -f"
}

# ---------- 状态查看 ----------
function Show-Status {
    Step "运行状态"
    # Docker 容器状态
    if ((Test-Path (Join-Path $Dir 'docker-compose.yml')) -and (Get-Command docker -ErrorAction SilentlyContinue)) {
        try {
            Push-Location $Dir
            docker compose ps
            Pop-Location
        } catch { }
    }
    $p = Get-Process -Name node,bun -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Dir*" }
    if ($p) { Ok "发现运行中的进程：PID $($p.Id -join ', ')" } else { Info "未发现本项目的 node/bun 进程" }

    if (Get-Command nssm -ErrorAction SilentlyContinue) {
        $ns = nssm status APIHub 2>$null
        if ($ns) { Ok "nssm 服务状态：$ns" }
    }
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) { Ok "开机自启任务已注册，状态：$($t.State)" } else { Info "未注册开机自启任务（若已用 nssm 注册为服务则属正常）" }

    $tok = Join-Path $Dir 'db\setup-token.txt'
    $cred = Join-Path $Dir 'db\credentials.env'
    if (Test-Path $tok) {
        Write-Host ""
        Ok "首次设置令牌（创建管理员时用，建号后即焚）："
        Write-Host "    $((Get-Content $tok -Raw).Trim())"
    } elseif (Test-Path $cred) {
        Write-Host ""; Ok "管理员已初始化，直接用用户名+密码登录"
    }
    try {
        # 用 /api/health 而非 /api/auth/status：前者会真正探测数据库可读写，
        # 后者只反映「是否已初始化」，DB 挂了照样 200。
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 5
        Ok "健康检查通过：HTTP $($r.StatusCode) → http://127.0.0.1:$Port"
    } catch { Warn "健康检查未通过：$($_.Exception.Message)" }
    exit 0
}

# ---------- 卸载 ----------
function Do-Uninstall {
    Step "卸载 $TaskName"
    # Docker 容器
    if ((Test-Path (Join-Path $Dir 'docker-compose.yml')) -and (Get-Command docker -ErrorAction SilentlyContinue)) {
        Push-Location $Dir
        docker compose down 2>$null | Out-Null
        Pop-Location
        Ok "Docker 容器已停止并移除"
    }
    # nssm 服务
    if (Get-Command nssm -ErrorAction SilentlyContinue) {
        nssm stop APIHub 2>$null | Out-Null
        nssm remove APIHub confirm 2>$null | Out-Null
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Stop-AppProcess
    if ($Purge) {
        Remove-Item -Recurse -Force $Dir -ErrorAction SilentlyContinue
        Warn "已删除 $Dir（含数据库，不可恢复）"
    } else {
        Ok "数据库保留在 $Dir\db —— 手动清理：Remove-Item -Recurse -Force $Dir"
    }
    exit 0
}

# ---------- 环境自检 ----------
function Preflight {
    Step "环境自检"
    $os = Get-CimInstance Win32_OperatingSystem
    $memGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    $freeGb = [math]::Round((Get-PSDrive C).Free / 1GB, 1)
    if ($memGb -lt 4) { Warn "内存 ${memGb}GB 偏小，next build 建议 4GB+" }
    if ($freeGb -lt 5) { Warn "C 盘剩余 ${freeGb}GB，依赖+构建产物约需 3GB" }
    Ok "Windows $($os.Caption) / 内存 ${memGb}GB / C 盘余量 ${freeGb}GB"
    if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
        Die "未找到 tar.exe：请升级到 Windows 10 17063+ 或安装 Git for Windows"
    }
}

# ---------- Node.js ----------
function Install-Node {
    Step "检查 Node.js"
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $v = (node -v) -replace '^v','' -split '\.' | Select-Object -First 1
        if ([int]$v -ge 20) { Ok "Node.js $(node -v) 已满足要求"; return }
        Warn "Node.js $(node -v) 版本过低，需要 20+"
    }
    Info "尝试用 winget 安装 Node.js 22 LTS"
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    } else {
        Die "未找到 winget 且无 Node 20+。手动下载安装：https://nodejs.org/dist/v22.11.0/node-v22.11.0-x64.msi"
    }
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js 安装后仍未生效，请开新的 PowerShell 重跑" }
    Ok "Node.js $(node -v)"
}

# ---------- bun ----------
function Install-Bun {
    Step "检查 bun"
    $bun = Get-Command bun -ErrorAction SilentlyContinue
    if (-not $bun) {
        Info "安装 bun"
        powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex" | Out-Host
        $env:Path = "$env:USERPROFILE\.bun\bin;" + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
        $bun = Get-Command bun -ErrorAction SilentlyContinue
    }
    if (-not $bun) { Die "bun 安装失败，手动装：powershell -c `"irm bun.sh/install.ps1 | iex`"" }
    Ok "bun $(bun -v) → $($bun.Source)"
}

# ---------- 拉取源码 ----------
function Fetch-Source {
    Step "拉取源码 $Owner/$Repo@$Branch"
    if (-not $Token) {
        $Token = Read-Host "请输入 GitHub PAT（需 repo 读权限）" -AsSecureString
        $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
                   [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token))
    }
    if (-not $Token) { Die "token 为空" }

    $tmp = Join-Path $env:TEMP ("apihub-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $gz = Join-Path $tmp 'src.tar.gz'
    $headers = @{ Authorization = "Bearer $Token"; Accept = 'application/vnd.github+json' }
    try {
        Invoke-WebRequest -Uri "https://api.github.com/repos/$Owner/$Repo/tarball/$Branch" `
            -Headers $headers -OutFile $gz -UseBasicParsing -TimeoutSec 300
    } catch {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
        Die "下载失败：token 权限不足（需 repo scope）或网络不通 —— $($_.Exception.Message)"
    }

    # 更新前备份数据库
    if (Test-Path (Join-Path $Dir 'db')) {
        $bak = "C:\api-hub-backups\db-$(Get-Date -Format yyyyMMdd-HHmmss)"
        New-Item -ItemType Directory -Path $bak -Force | Out-Null
        Copy-Item -Path (Join-Path $Dir 'db\*') -Destination $bak -Recurse -Force -ErrorAction SilentlyContinue
        Ok "数据库已备份到 $bak"
    }

    New-Item -ItemType Directory -Path (Join-Path $Dir 'db') -Force | Out-Null
    Push-Location $tmp
    & tar -xzf $gz
    Pop-Location
    $root = Get-ChildItem -Path $tmp -Directory | Where-Object { $_.Name -like "$Owner-*" } | Select-Object -First 1
    if (-not $root) { Remove-Item -Recurse -Force $tmp; Die "解包后找不到源码目录，检查 token / 仓库名 / 分支" }
    Copy-Item -Path (Join-Path $root.FullName '*') -Destination $Dir -Recurse -Force
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Ok "源码已就位：$Dir"
}

# ---------- 依赖 ----------
function Install-Deps {
    Step "安装依赖"
    Push-Location $Dir
    if ($CN) { & bun install --registry https://registry.npmmirror.com } else { & bun install }
    if ($LASTEXITCODE -ne 0) { Pop-Location; Die "bun install 失败（见上方输出）" }
    Ok "依赖安装完成"

    Step "生成 Prisma Client"
    if ($CN) { $env:PRISMA_ENGINES_MIRROR = 'https://registry.npmmirror.com/-/binary/prisma' }
    & bun run db:generate
    if ($LASTEXITCODE -ne 0) { Pop-Location; Die "prisma generate 失败" }
    Pop-Location
    Ok "Prisma Client 已生成"
}

# ---------- 数据库 ----------
function Init-Db {
    Step "初始化数据库"
    Push-Location $Dir
    $dbFile = Join-Path $Dir 'db\custom.db'
    if (Test-Path $dbFile) {
        Ok "已存在 db\custom.db，跳过初始化（绝不覆盖现有数据）"
    } else {
        & bun run db:push
        if ($LASTEXITCODE -ne 0) { Pop-Location; Die "数据库建表失败" }
        Ok "数据库已建表：$dbFile"
    }
    Pop-Location
}

# ---------- 构建 ----------
function Build-App {
    Step "构建 Next.js（最慢，约 3-8 分钟）"
    Push-Location $Dir
    $env:NODE_ENV = 'production'
    $env:NEXT_TELEMETRY_DISABLED = '1'
    & bun run build
    if ($LASTEXITCODE -ne 0) { Pop-Location; Die "构建失败，看上方日志（常见：内存不足 / 依赖不全）" }
    Pop-Location
    Ok "构建完成"
}

# ---------- 启动脚本 ----------
function Write-StartScript {
    $start = Join-Path $Dir 'start.ps1'
    # 找 next CLI 的真实路径（不同包管理器布局不一致）
    $nextBin = Join-Path $Dir 'node_modules\next\dist\bin\next'
    if (-not (Test-Path $nextBin)) { $nextBin = Join-Path $Dir 'node_modules\.bin\next.cmd' }
    $content = @"
`$ErrorActionPreference = 'SilentlyContinue'
Set-Location '$Dir'
`$env:NODE_ENV = 'production'
`$env:PORT = '$Port'
`$env:HOSTNAME = '0.0.0.0'
`$env:NEXT_TELEMETRY_DISABLED = '1'
# 工作目录必须是项目根：Prisma 与凭据文件都按 cwd 定位 db\
# 日志重定向到 server.log，便于 tail 排查
& bun '$nextBin' start -p $Port *>> '$Dir\server.log'
"@
    Set-Content -Path $start -Value $content -Encoding UTF8
    Ok "启动脚本已生成：$start"
}

function Start-App {
    Step "启动服务"
    Stop-AppProcess
    Start-Sleep -Seconds 2
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dir\start.ps1`"" `
        -WindowStyle Hidden
    $i = 0
    while ($i -lt 60) {
        Start-Sleep -Seconds 1; $i++
        try {
            # 用 /api/health 而非 /：后者是前端页面，DB 挂了照样 200，
            # 会让安装脚本在数据库不可用时误报「已就绪」。
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 3
            Ok "服务已就绪（${i}s，数据库就绪）：http://127.0.0.1:$Port"
            return
        } catch { }
    }
    Die "60s 内未通过健康检查。看日志：Get-Content '$Dir\server.log' -Tail 100
或前台跑看报错：cd $Dir; bun run start"
}

# 停掉本项目进程（按 Path 前缀精确匹配，不误杀其他 node 进程）
function Stop-AppProcess {
    Get-Process -Name node,bun -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -like "$Dir*"
    } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
}

# ---------- 开机自启 ----------
function Enable-Autostart {
    Step "配置开机自启"
    # nssm 可用时默认就注册为真正的 Windows 服务（开机即启，不依赖用户登录）
    $nssm = Get-Command nssm -ErrorAction SilentlyContinue
    $useNssm = $UseNssm -or [bool]$nssm

    if ($useNssm) {
        if (-not $nssm) {
            Warn "指定了 -UseNssm 但未找到 nssm。下载 https://nssm.cc/release/nssm-2.24.zip 把 nssm.exe 放进 PATH，或去掉 -UseNssm 用计划任务"
        } else {
            & nssm stop APIHub 2>$null | Out-Null
            & nssm remove APIHub confirm 2>$null | Out-Null
            & nssm install APIHub powershell.exe "-NoProfile -ExecutionPolicy Bypass -File `"$Dir\start.ps1`""
            & nssm set APIHub AppDirectory $Dir
            & nssm set APIHub DisplayName "API Hub"
            & nssm set APIHub Start SERVICE_AUTO_START
            # 崩溃自动重启，比计划任务恢复更及时
            & nssm set APIHub AppExit Default Restart
            & nssm set APIHub AppRestartDelay 5000
            & nssm start APIHub
            Ok "已注册为 Windows 服务（nssm）：开机自动启动，无需登录"
            Info "管理：nssm status APIHub / nssm restart APIHub / nssm stop APIHub"
            return
        }
    }

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dir\start.ps1`""
    $trg = New-ScheduledTaskTrigger -AtLogOn
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Settings $set `
        -RunLevel Highest -Force | Out-Null
    Ok "已注册计划任务「$TaskName」（登录时自动启动）"
    Warn "计划任务需用户登录才触发；要开机即启请装 nssm（nssm.cc）后重跑，会自动改用服务方式"
}

# ---------- 防火墙 ----------
function Open-Firewall {
    Step "放行端口 $Port"
    if ($NoFirewall) { Info "已指定 -NoFirewall，跳过"; return }
    $ruleName = "API Hub $Port"
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
        # 只放行专用网与域配置，避免直接暴露到公网（管理台含明文 API Key）
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
            -LocalPort $Port -Action Allow -Profile Domain,Private -ErrorAction SilentlyContinue | Out-Null
        if ($?) {
            Ok "已放行 TCP $Port 入站（仅域/专用网）"
        } else {
            # 老系统或权限不足时退回全配置
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
                -LocalPort $Port -Action Allow -Profile Any | Out-Null
            Warn "已放行 TCP $Port（所有配置）"
        }
    } else { Ok "防火墙规则已存在" }
    Warn "管理台含明文 API Key：仅在本机/内网使用时建议在防火墙里删除此规则，不要暴露公网"
    Warn "确需公网访问请用域名 + HTTPS 反代（Caddy/Nginx），裸 IP:端口 登录密码会明文过网"
}

# ---------- 收尾 ----------
function Show-Summary {
    Step "安装完成"
    Write-Host ""
    Write-Host "  管理台：  http://127.0.0.1:$Port" -ForegroundColor Green
    Write-Host "  安装目录：$Dir"
    Write-Host "  数据库：  $Dir\db\custom.db（含明文 Key，勿外传）"
    Write-Host ""
    $tok = Join-Path $Dir 'db\setup-token.txt'
    $i = 0
    while ($i -lt 30 -and -not (Test-Path $tok)) { Start-Sleep -Seconds 1; $i++ }
    if (Test-Path $tok) {
        Write-Host "  首次设置令牌：$((Get-Content $tok -Raw).Trim())" -ForegroundColor Yellow
        Write-Host "  → 打开管理台，用它 + 自设用户名密码创建管理员（建号后令牌即焚毁）"
    } else {
        Write-Host "  管理员已初始化，直接登录即可"
    }
    Write-Host ""
    Write-Host "  常用操作："
    Write-Host "    看状态   .\install-api-hub.ps1 -Status"
    Write-Host "    重启     Get-Process node,bun | ? Path -like '$Dir*' | Stop-Process -Force; & '$Dir\start.ps1'"
    Write-Host "    看日志   cd $Dir; Get-Content dev.log -Tail 50"
    Write-Host "    更新     .\install-api-hub.ps1 -Update -Token <PAT>"
    Write-Host ""
    Write-Host "  接入客户端（AstrBot / OpenAI SDK）："
    Write-Host "    Base URL  http://127.0.0.1:$Port/v1"
    Write-Host "    API Key   sk-gw- 开头那把（管理台「API 密钥」Tab 新建）"
    Write-Host ""
    Warn "面板若暴露公网务必配 HTTPS（Caddy / Nginx 反代）；裸 IP:端口 登录密码会明文过网"
}

# ============================================================
Assert-Admin
if ($Status)   { Show-Status }
if ($Uninstall){ Do-Uninstall }

# Docker 模式：不需要本机 Node/bun，流程完全不同
if ($Docker -and (-not ($Precheck))) {
    Invoke-DockerDeploy
    exit 0
}

Preflight
if ($Precheck) {
    if ($Docker) { Info "Docker 模式自检"; try { docker info | Out-Null; Ok "Docker 运行中" } catch { Die "Docker 未运行" } }
    Install-Node; Install-Bun
    Ok "环境自检通过，可以安装"
    exit 0
}

Install-Node
Install-Bun
Fetch-Source
Install-Deps
Init-Db
Build-App
Write-StartScript
Start-App
if (-not $Update) { Enable-Autostart; Open-Firewall } else { Ok "更新模式：沿用已有自启配置" }
Show-Summary
