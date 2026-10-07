<#
.SYNOPSIS
    API Hub · Windows 服务注册脚本（用 NSSM 把网关注册为开机自启服务）。

.DESCRIPTION
    install-api-hub.ps1 已经会自动完成服务注册，本脚本用于**手动/二次部署**场景：
    把已有的安装目录注册为 Windows 服务，或在换机器、重装系统后快速恢复服务。

    相比直接跑安装脚本，本脚本不碰源码与依赖，只做「服务注册」这一件事，
    因此可以在不动数据目录的前提下重建服务。

.PARAMETER Dir
    API Hub 安装目录（含 .next\standalone）。默认 C:\api-hub

.PARAMETER Port
    监听端口，默认 3000

.PARAMETER ServiceUser
    服务运行账户。默认 LocalSystem。
    改用域账号时该账号需对 -Dir 有读权限、对 <Dir>\db 有读写权限。

.PARAMETER NodePath
    node.exe 绝对路径。默认自动探测，找不到时回退到常见安装路径。

.EXAMPLE
    .\register-service.ps1
    使用默认目录 C:\api-hub 与端口 3000。

.EXAMPLE
    .\register-service.ps1 -Dir 'D:\api-hub' -Port 8080 -ServiceUser 'MYPC\apiuser'

.NOTES
    卸载服务：.\unregister-service.ps1
    或手动：nssm stop api-hub; nssm remove api-hub confirm
#>
[CmdletBinding()]
param(
    [string]$Dir = 'C:\api-hub',
    [int]$Port = 3000,
    [string]$ServiceUser = 'LocalSystem',
    [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'api-hub'
# NSSM 捕获 stdout/stderr 写入这两个文件；轮转请配合 deploy/logrotate 思路自行实现
$LogDir = "$env:ProgramData\api-hub\logs"

function Info($m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Die($m)  { Write-Host "[FAIL] $m" -ForegroundColor Red; exit 1 }

# ---------- 管理员权限 ----------
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Die '需要管理员权限。请以管理员身份运行 PowerShell 后重试。'
}

# ---------- 前置检查 ----------
if (-not (Test-Path $Dir)) { Die "安装目录不存在：$Dir" }
$entry = Join-Path $Dir '.next\standalone\server.js'
if (-not (Test-Path $entry)) { Die "未找到服务入口：$entry`n请先完成构建（npm run build），或改用 install-api-hub.ps1 一键安装。" }

# 探测 node.exe：优先用 PATH，其次常见安装路径
if (-not $NodePath) {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        $NodePath = $cmd.Source
    } else {
        $candidates = @(
            "$env:ProgramFiles\nodejs\node.exe",
            "${env:ProgramFiles(x86)}\nodejs\node.exe",
            "$env:APPDATA\nvm\current\node.exe"
        )
        $NodePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    }
}
if (-not $NodePath -or -not (Test-Path $NodePath)) {
    Die '未找到 node.exe。请用 -NodePath 显式指定绝对路径（注意服务环境不继承用户 PATH）。'
}
Info "Node：$NodePath"

# ---------- NSSM ----------
$nssm = Get-Command nssm.exe -ErrorAction SilentlyContinue
if (-not $nssm) {
    $guess = "$env:ProgramFiles\nssm.exe"
    if (Test-Path $guess) {
        $nssm = $guess
    } else {
        Die '未找到 NSSM。请先安装：winget install nssm.nssm（或 choco install nssm / scoop install nssm）'
    }
}
Info "NSSM：$nssm"

# ---------- 已存在则先卸载，避免残留旧配置 ----------
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Info "服务 $ServiceName 已存在，先卸载再重建"
    & $nssm stop $ServiceName confirm 2>$null | Out-Null
    & $nssm remove $ServiceName confirm 2>$null | Out-Null
    Start-Sleep -Seconds 1
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Info "日志目录：$LogDir"

# ---------- 注册 ----------
Info '注册服务...'
& $nssm install $ServiceName $NodePath "`"$entry`"" | Out-Null
& $nssm set $ServiceName AppDirectory $Dir | Out-Null
& $nssm set $ServiceName DisplayName 'API Hub · API 聚合网关' | Out-Null
& $nssm set $ServiceName Description '个人公益站 API 聚合网关（管理面板 + OpenAI 兼容入口）' | Out-Null

# 环境变量：注意 HOSTNAME 只监听本机，由反代对外；直接对外时才改0.0.0.0
& $nssm set $ServiceName AppEnvironmentExtra `
    "NODE_ENV=production" "PORT=$Port" "HOSTNAME=127.0.0.1" "LOG_LEVEL=info" "LOG_FORMAT=json" | Out-Null

# 依赖顺序：网络就绪后再启动（拉取上游需要出网）
& $nssm set $ServiceName DependOnService Tcpip | Out-Null

# 崩溃自动重启：延迟 5s，最多重试 3 次
& $nssm set $ServiceName AppExit Default Restart | Out-Null
& $nssm set $ServiceName AppRestartDelay 5000 | Out-Null
& $nssm set $ServiceName AppThrottle 3000 | Out-Null
& $nssm set $ServiceName AppMaxTries 3 | Out-Null

# stdout/stderr 落文件
& $nssm set $ServiceName AppStdout "$LogDir\api-hub.out.log" | Out-Null
& $nssm set $ServiceName AppStderr "$LogDir\api-hub.err.log" | Out-Null
& $nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $nssm set $ServiceName AppRotateOnline 1 | Out-Null
& $nssm set $ServiceName AppRotateBytes 10485760 | Out-Null  # 10MB 轮转

# 开机自启 + 优先级
& $nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $nssm set $ServiceName AppPriority HIGH_PRIORITY_CLASS | Out-Null

if ($ServiceUser -ne 'LocalSystem') {
    & $nssm set $ServiceName ObjectName $ServiceUser | Out-Null
    Info "服务账户：$ServiceUser（请确认该账号对 $Dir\db 有读写权限）"
}

# ---------- 启动与健康验证 ----------
Info '启动服务...'
& $nssm start $ServiceName | Out-Null

# 等待端口就绪（最长 30 秒）
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
}

Write-Host ''
if ($ok) {
    Ok "服务已启动并通过健康检查：http://127.0.0.1:$Port"
} else {
    Write-Warning "服务已注册但健康检查未通过，请查看日志：$LogDir\api-hub.err.log"
}

Write-Host ''
Info '常用运维命令：'
Write-Host "  查看状态Get-Service $ServiceName"
Write-Host "  启动/停止   Start-Service $ServiceName / Stop-Service $ServiceName"
Write-Host "  重启        Restart-Service $ServiceName"
Write-Host "  开机自启验证 (Get-Service $ServiceName).StartType   期望 Automatic"
Write-Host "  实时日志    Get-Content '$LogDir\api-hub.err.log' -Wait -Tail 50"
Write-Host "  卸载服务    .\unregister-service.ps1"