<#
.SYNOPSIS
    API Hub 部署自检（Windows PowerShell / PowerShell Core，零依赖）。

.DESCRIPTION
    与 Linux 的 scripts/verify-deploy.sh 对等的检查项，用于装完确认「服务真的可用」，
    而不只是「进程在跑」。覆盖：Node 版本、端口监听、健康检查、鉴权保护、
    Windows 服务状态、数据库目录可写性。

    退出码：0 = 全部通过；1 = 有检查项失败（可直接用于部署流水线判定）

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File verify-deploy.ps1
    powershell -ExecutionPolicy Bypass -File verify-deploy.ps1 -BaseUrl http://127.0.0.1:8080

.NOTES
    兼容 Windows PowerShell 5.1与 PowerShell 7+。
#>
[CmdletBinding()]
param(
    # 要检查的服务地址；默认读环境变量 PORT，回落 3000
    [string]$BaseUrl = $(if ($env:PORT) { "http://127.0.0.1:$($env:PORT)" } else { 'http://127.0.0.1:3000' }),
    # Windows 服务名，默认 api-hub
    [string]$ServiceName = 'api-hub'
)

$ErrorActionPreference = 'Continue'
$BaseUrl = $BaseUrl.TrimEnd('/')

$script:Pass = 0
$script:Fail = 0

function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [ OK ] $msg" -ForegroundColor Green;  $script:Pass++ }
function Write-Bad($msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red;   $script:Fail++ }
function Write-Warn2($msg){ Write-Host "  [ ! ] $msg" -ForegroundColor Yellow }

Write-Host "API Hub 部署自检  目标：$BaseUrl" -ForegroundColor White

# 从 BaseUrl 里取出端口，供监听检查使用（PowerShell 的 URI 类不直接给端口）
$Port = ([uri]$BaseUrl).Port

# ---------- 1. 运行环境 ----------
Write-Step '1. 运行环境'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $ver = (& node -v) 2>$null
    $major = [int](($ver -replace '^v(\d+).*','$1'))
    if ($major -ge 20) {
        Write-Ok "Node $ver"
    } else {
        Write-Bad "Node $ver 版本过低，需要 20+（standalone 产物用了 Node 20+ 特性）"
    }
} else {
    Write-Warn2 '未找到 node（若用二进制/tarball 部署可忽略此项）'
}

# ---------- 2. 端口监听 ----------
Write-Step '2. 端口监听'
$listening = $false
# Get-NetTCPConnection 仅 Windows 8+/Server2012+ 有；缺失时回落到 netstat
if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        $listening = ($null -ne $conn)
    } catch {
        $listening = $false
    }
}
if (-not $listening -and (Get-Command netstat -ErrorAction SilentlyContinue)) {
    $listening = ($null -ne (netstat -ano 2>$null | Select-String -Pattern ":$Port\s+.*LISTENING"))
}
if ($listening) {
    Write-Ok "端口 $Port 处于监听状态"
} else {
    Write-Warn2 "未在 $Port 上侦听到进程（若走了反向代理，服务可能只绑在其它地址）"
}

# ---------- 3. 健康检查 ----------
Write-Step '3. 健康检查（最关键的一项）'
try {
    $resp = Invoke-WebRequest -Uri "$BaseUrl/api/health" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    $body = $resp.Content
    if ($body -match '"db"\s*:\s*\{') {
        Write-Ok '响应含 db 字段（版本正确）'
    } else {
        Write-Bad '响应缺少 db 字段，可能跑的是旧版本'
    }
    if ($body -match '"ok"\s*:\s*true') {
        Write-Ok '数据库可用（status=ok）'
    } elseif ($body -match 'degraded') {
        Write-Bad '数据库不可用（status=degraded）—— 进程活着但不能接流量'
        Write-Host '      排查：检查 db 目录权限（icacls）、磁盘是否已满' -ForegroundColor DarkGray
    } else {
        Write-Warn2 "健康检查返回了预期外的内容：$($body.Substring(0, [Math]::Min(160, $body.Length)))"
    }
} catch {
    Write-Bad "无法连接 $BaseUrl/api/health —— 服务没起来，或端口/地址不对"
    Write-Host '      排查：Get-Service ' + $ServiceName + '  |  Get-Content <安装目录>\logs\stdout.log -Tail 50' -ForegroundColor DarkGray
}

# ---------- 4. 鉴权保护 ----------
Write-Step '4. 鉴权保护'
try {
    Invoke-WebRequest -Uri "$BaseUrl/api/overview" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null
    Write-Bad '管理接口无需鉴权即可访问 —— 危险！请检查会话配置'
} catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 401 -or $code -eq 403) {
        Write-Ok "管理接口未授权访问被拒绝（HTTP $code，符合预期）"
    } else {
        Write-Warn2 "管理接口探测结果异常（HTTP $code，预期 401/403）"
    }
}

# ---------- 5. 服务状态 ----------
Write-Step '5. 服务状态'
# Get-Service / Get-CimInstance 是 Windows 专用 cmdlet，在 PowerShell 7 for Linux 上
# 并不存在，直接调用会抛终止性错误让脚本中断。先探测可用性，不可用就跳过并提示。
if (-not (Get-Command Get-Service -ErrorAction SilentlyContinue)) {
    Write-Warn2 '当前环境无 Get-Service（非 Windows 环境），跳过服务状态检查'
} else {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) {
        if ($svc.Status -eq 'Running') { Write-Ok "服务 $ServiceName 正在运行" }
        else { Write-Bad "服务 $ServiceName 状态为 $($svc.Status)（未运行）" }

        # 开机自启：StartMode=Automatic。Get-CimInstance 在精简环境可能缺失，需兜底
        $cim = $null
        if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
            $cim = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
        }
        if ($cim -and $cim.StartMode -eq 'Auto') {
            Write-Ok '已设为开机自启（Automatic）'
        } elseif ($cim) {
            Write-Warn2 "启动类型为 $($cim.StartMode)（建议设为 Automatic 以便开机自启）"
        } else {
            Write-Warn2 '无法读取服务启动类型（需管理员权限，或系统不支持 WMI）'
        }
    } else {
        Write-Warn2 "未检测到服务 $ServiceName（若用 node 直接跑可忽略此项）"
    }
}

# ---------- 6. 数据与数据库 ----------
Write-Step '6. 数据与数据库'
# 仅在 Windows 上拼 C:\ 路径：Linux/macOS 没有盘符概念，Join-Path 'C:\...' 会抛
# "Cannot find drive with name C"，把整个检查流程打断。
$dbCandidates = @()
if ($IsWindows -or $env:OS -eq 'Windows_NT' -or $null -eq $IsWindows) {
    $dbCandidates += "$env:ProgramFiles\api-hub\db"
    $dbCandidates += 'C:\api-hub\db'
}
$dbCandidates += (Join-Path (Get-Location) 'db')

foreach ($d in $dbCandidates) {
    if (Test-Path $d) {
        # 用实际写文件验证可写性（ACL 才是决定因素，Attributes 不可靠）
        $probe = Join-Path $d '.write-probe'
        try {
            New-Item -ItemType File -Path $probe -Force -ErrorAction Stop | Out-Null
            Remove-Item $probe -Force -ErrorAction SilentlyContinue
            Write-Ok "$d 存在且可写"
        } catch {
            Write-Bad "$d 存在但不可写 —— 服务将无法落库"
        }
        break
    }
}
foreach ($d in $dbCandidates) {
    $f = Join-Path $d 'custom.db'
    if (Test-Path $f) {
        $mb = [Math]::Round((Get-Item $f).Length / 1MB, 1)
        Write-Ok "数据库文件存在（$mb MB）"
        break
    }
}

# ---------- 汇总 ----------
Write-Host ''
if ($script:Fail -gt 0) {
    Write-Host "检查结果：$($script:Pass) 项通过，$($script:Fail) 项失败" -ForegroundColor Red
    Write-Host '失败项请对照 INSTALL.md 的「常见问题 FAQ」处理。' -ForegroundColor Red
    exit 1
} else {
    Write-Host "检查结果：$($script:Pass) 项通过，$($script:Fail) 项失败" -ForegroundColor Green
    Write-Host '部署正常。' -ForegroundColor Green
    exit 0
}