<#
.SYNOPSIS
    卸载 API Hub 的 Windows 服务（NSSM 注册）。

.DESCRIPTION
    只移除服务注册项，默认**保留安装目录与数据**（db/ 里的 SQLite、凭据、设置令牌）。
    这点很重要：直接删文件夹会留下服务注册项（进程还在跑、开机还会自启），
    而误删 db/ 会连渠道配置与密钥一起丢。

.PARAMETER Purge
    连同安装目录一起删除。**会永久丢失 db/ 中的全部数据**，会二次确认。

.EXAMPLE
    .\unregister-service.ps1
    停服务并注销，保留数据目录。

.EXAMPLE
    .\unregister-service.ps1 -Purge
    连同 C:\api-hub 整个删除（不可恢复）。
#>
[CmdletBinding()]
param(
    [switch]$Purge,
    [string]$Dir = 'C:\api-hub'
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'api-hub'

function Info($m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[FAIL] $m" -ForegroundColor Red; exit 1 }

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Die '需要管理员权限。请以管理员身份运行 PowerShell 后重试。'
}

# ---------- 1. 备份数据（除非明确要 purge）----------
if (-not $Purge -and (Test-Path "$Dir\db")) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$env:USERPROFILE\Desktop\api-hub-db-backup-$stamp.zip"
    Info "打包数据目录到 $backup"
    try {
        Compress-Archive -Path "$Dir\db" -DestinationPath $backup -Force
        Ok "数据已备份：$backup"
    } catch {
        Warn "备份失败（$($_.Exception.Message)）。继续卸载，但请自行确认 db/ 目录是否需要保留。"
    }
}

# ---------- 2. 停服务并注销 ----------
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Info "停止服务 $ServiceName ..."
    # NSSM 包装的服务需先 stop 再 remove，否则 nssm remove 可能残留
    $nssm = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if ($nssm) {
        & $nssm stop $ServiceName confirm 2>$null | Out-Null
    } else {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2

    Info '注销服务...'
    if ($nssm) {
        & $nssm remove $ServiceName confirm 2>$null | Out-Null
    } else {
        # 没有 nssm 时用 sc 删除（Win10/11 上服务名即 api-hub）
        sc.exe delete $ServiceName | Out-Null
    }
    Ok "服务 $ServiceName 已注销"
} else {
    Warn "未找到服务 $ServiceName，可能已卸载过"
}

# ---------- 3. 可选：删除安装目录 ----------
if ($Purge) {
    Write-Host ''
    Write-Host '⚠️  即将删除安装目录（含 db/ 全部数据）：' -ForegroundColor Red
    Write-Host "    $Dir" -ForegroundColor Red
    $ans = Read-Host '    确认删除请输入大写 YES'
    if ($ans -ceq 'YES') {
        if (Test-Path $Dir) {
            Remove-Item -Recurse -Force $Dir
            Ok "已删除 $Dir"
        }
    } else {
        Info '已取消删除目录'
    }
} else {
    Write-Host ''
    Ok "服务已卸载，数据目录保留在 $Dir"
    Write-Host ''
    Info '如需彻底删除安装目录：'
    Write-Host "  Remove-Item -Recurse -Force '$Dir'"
    Write-Host ''
    Warn '务必确认 db/ 已备份或不再需要 —— 它包含渠道配置、上游密钥与管理员凭据。'
}