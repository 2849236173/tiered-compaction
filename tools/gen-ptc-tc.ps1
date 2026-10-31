<#
.SYNOPSIS
    从当前 DSH 的 ptc preset 生成 ptc-tc（只替换压缩引擎为 tiered-compaction）。

.DESCRIPTION
    用途：dsh-tiered-compaction 在 desktop profile 里通过「自有 preset」方式接管压缩。
    ptc-tc 是 ptc 的精确副本，只把 compaction 组里的 compaction-basic 换成
    dsh-tiered-compaction（npm 包名，固定）。上游 DSH 升级会改动 ptc，此时必须重跑本脚本
    重新生成 ptc-tc，否则 ptc-tc 会固化成老配置（漂移）。

    本脚本是薄封装：实际生成与自检在 tools/gen-ptc-tc.mjs 里做（Node，全程 UTF-8）。
    不用 PowerShell 处理文本的原因：preset 配置含大段中文与 !!js 自定义标量，
    PowerShell 的 Set-Content -Encoding UTF8 在 5.1 / 7 之间行为不一致（BOM、管道编码），
    实测会造成中文乱码与产物不幂等。

    内置自检（由 Node 侧执行，失败即退出且不写产物）：
    生成后与 ptc 做递归结构 diff，首次应用差异必须恰好是以下 9 项叶子（含 description），否则报错：
      (root).id                                    preset-ptc         -> preset-ptc-tc
      (root).config.id                             ptc                -> ptc-tc
      (root).config.order                          2                  -> <Order>
      (root).config.plugins[N].config[0].id        compaction-basic   -> tiered-compaction
      (root).config.plugins[N].config[0].name      @deepseek-ai/...   -> dsh-tiered-compaction
      (root).config.plugins[N].config[0].config.enabled               -> true
      (root).config.plugins[N].config[0].config.archiveDir            -> <ArchiveDir>
      (root).config.plugins[N].config[0].config.scopeId               -> ptc-tc
    已应用过（源 ptc 里已是 tiered-compaction）时合并而非覆盖，只校验最终形态。
    其中 N = compaction 组在 plugins 里的下标（按 id 查找，不写死）。

.PARAMETER Profile
    要读取的 DSH profile 名，默认 desktop。

.PARAMETER Order
    ptc-tc 的 order 值，默认 5（排在宿主自带 preset 之后）。

.PARAMETER Apply
    生成并自检通过后，把产物写回 profile 的 cordis.patch.yml
    （替换起止标记之间的内容）。不加则只生成不落地，先看自检输出。

.PARAMETER ArchiveDir
    写进 tiered-compaction 配置的落盘目录，默认 $env:USERPROFILE\.dsh\tiered-archive。

.PARAMETER PluginName
    仅用于探测本机已装包；产物里的 name 始终是 dsh-tiered-compaction，探测结果不同只告警。

.EXAMPLE
    pwsh tools/gen-ptc-tc.ps1
    只生成并自检，产物到 tools/out/preset-ptc-tc.yml

.EXAMPLE
    pwsh tools/gen-ptc-tc.ps1 -Apply
    生成、自检，然后写回 desktop 的 cordis.patch.yml（自动备份）

.NOTES
    DSH 升级后的重同步步骤：
      1. pwsh tools/gen-ptc-tc.ps1            # 看自检是否通过
      2. pwsh tools/gen-ptc-tc.ps1 -Apply     # 通过后落地
      3. 重启 DSH Desktop 或新建会话使之生效
#>
[CmdletBinding()]
param(
    [string]$Profile = "desktop",
    [int]$Order = 5,
    [switch]$Apply,
    [string]$ArchiveDir = "",
    [string]$PluginName = ""
)

$ErrorActionPreference = "Stop"

# ── 路径与前置检查 ─────────────────────────────────────────────
$repoRoot = Split-Path -Parent $PSScriptRoot
$generator = Join-Path $PSScriptRoot "gen-ptc-tc.mjs"
$outDir = Join-Path $PSScriptRoot "out"
$outFile = Join-Path $outDir "preset-ptc-tc.yml"
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
if (-not $ArchiveDir) { $ArchiveDir = Join-Path $env:USERPROFILE ".dsh\tiered-archive" }

if (-not (Test-Path $generator)) { Write-Error "缺少生成器：$generator" }
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
    Write-Error "找不到 dsh 命令。本脚本需要 DSH Desktop 的 dsh CLI 读取 profile 合成配置。"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "找不到 node 命令。生成与自检由 Node 执行。"
}
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

# ── 1) 读 profile 合成配置 ─────────────────────────────────────
Write-Host "[1/3] 读取 profile '$Profile' 的合成配置 ..." -ForegroundColor Cyan
$dumpFile = Join-Path $outDir "dump.yml"
# 用 cmd 重定向而不是 PowerShell 管道：避免 PS 的编码转换破坏中文
$prevEnc = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
    cmd /c "dsh --profile $Profile --dump-config 2>nul > `"$dumpFile`""
} finally {
    [Console]::OutputEncoding = $prevEnc
}
if (-not (Test-Path $dumpFile)) { Write-Error "dump-config 未产生输出。" }
Write-Host "      已写入 $dumpFile（$((Get-Content $dumpFile).Count) 行）"

# ── 2) 生成 + 自检（Node 侧，失败即退且不写产物）──────────────
Write-Host "[2/3] 生成 ptc-tc 并自检 ..." -ForegroundColor Cyan
$genArgs = @($dumpFile, $outFile, $Order, $ArchiveDir, "--profile-dir", $profileDir)
if ($PluginName) { $genArgs += @("--plugin-name", $PluginName) }
Push-Location $repoRoot
try {
    & node $generator @genArgs
    $genExit = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($genExit -ne 0) {
    Write-Error "生成或自检未通过，未产生可用产物。请核对 ptc 结构是否变化（见上面差异明细）。"
}

# ── 3) 可选写回 profile 补丁 ───────────────────────────────────
if ($Apply) {
    Write-Host "[3/3] 写回 profile 补丁 ..." -ForegroundColor Cyan
    $patchPath = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\cordis.patch.yml"
    if (-not (Test-Path $patchPath)) { Write-Error "找不到 profile 补丁：$patchPath" }

    $patchLines = Get-Content $patchPath -Encoding UTF8
    $beginMarker = '# ══ D15 B 路线：自有 ptc-tc preset'
    $endMarker = '# ══ 切到新 preset ══'
    $b = -1; $t = -1
    for ($i = 0; $i -lt $patchLines.Count; $i++) {
        if ($patchLines[$i] -like "$beginMarker*") { $b = $i }
        if ($patchLines[$i] -like "$endMarker*") { $t = $i; break }
    }
    if ($b -lt 0 -or $t -lt 0 -or $t -lt $b) {
        Write-Error "补丁里找不到生成区块的起止标记（'$beginMarker' / '$endMarker'）。首次落地需手工插入一次，之后交给本脚本维护。"
    }

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backup = "$patchPath.gen-bak-$stamp"
    Copy-Item $patchPath $backup -Force
    Write-Host "      已备份 $backup"

    $newPatch = @()
    if ($b -gt 0) { $newPatch += $patchLines[0..($b - 1)] }
    $newPatch += Get-Content $outFile -Encoding UTF8
    $newPatch += $patchLines[$t..($patchLines.Count - 1)]
    # 用 .NET 直写 UTF-8 无 BOM，避免 PS 版本差异
    [System.IO.File]::WriteAllLines($patchPath, [string[]]$newPatch, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "      已写回 $patchPath（$($newPatch.Count) 行）"
    Write-Host "      生效方式：重启 DSH Desktop 或新建会话" -ForegroundColor Yellow
    Write-Host "[自检] 校验补丁里的插件名能否解析 ..." -ForegroundColor Cyan
    & node (Join-Path $PSScriptRoot "check-install.mjs") --profile-dir $profileDir
    if ($LASTEXITCODE -ne 0) {
        Write-Error "自检失败：补丁里的插件名解析不到，宿主挂载 preset 会报 never started。请按上面提示修正后重跑。"
    }
}

# 清理中间文件
Remove-Item $dumpFile -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "完成。" -ForegroundColor Green
