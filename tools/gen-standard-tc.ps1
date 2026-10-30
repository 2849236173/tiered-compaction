<#
.SYNOPSIS
    在当前 DSH 的 standard preset 内原地替换压缩引擎为 tiered-compaction。

.DESCRIPTION
    为什么需要这个脚本（D17 实测结论）：
      ds-bot 创建所有 Bot / 群会话时硬编码 `agentPreset: 'standard'`
      （src/host/roster.js:36-41，原因是 ptc 只准调 run_code，会把群聊用的
      group_relay 废掉）。因此：
        1. `agent-preset-registry.selectedDefault: ptc-tc` 对 Bot 会话完全无效；
        2. 根域的 `compaction-basic` 早已是 disabled: true，但会话里的压缩照常
           工作——因为每个 preset 内部自带一个 `isolate: compaction` 的隔离域，
           根域接管根本不在那个域里。
      要让压缩真正换引擎，只能改 preset 内部的 compaction 组。

    为什么整块重写 preset-standard 的 config：
      实测 patch 的 `- id` 只在顶层（bundle 根层）按 id 定位。写
      `- id: compaction-basic` 完全命中不了 preset 内部的嵌套条目；写
      `- id: preset-standard` + `config:` 是**整体替换** config 对象
      （实测：只写 plugins[0] 时其余插件全部消失）。
      所以产物是 preset-standard 的完整 config，只把引擎一项换掉。

    护栏：
      - 生成后与原 dump 做递归 diff，差异必须恰好 4 项叶子，否则报错不落地；
      - config.id 必须仍是 "standard"（改名会让 ds-bot 与存量会话全部 not-found）；
      - 写回前自动备份 cordis.patch.yml。

.PARAMETER Profile
    要处理的 profile 名，默认 desktop。

.PARAMETER Apply
    不带本开关时只生成并自检，产物到 tools/out/；带上才写回 profile 补丁。

.PARAMETER ArchiveDir
    第 2 层落盘目录，默认 $env:USERPROFILE\.dsh\tiered-archive。

.EXAMPLE
    pwsh tools/gen-standard-tc.ps1
    只生成并自检。

.EXAMPLE
    pwsh tools/gen-standard-tc.ps1 -Apply
    通过自检后写回 profile 补丁。之后重启 DSH Desktop 生效。

.NOTES
    DSH 升级后必须重跑：上游会改 standard 的插件列表，不重跑会固化成老配置（漂移）。
    回退：删掉补丁里 "══ D17" 到 "══ D17 区块结束 ══" 之间的内容，重启即可。
#>
param(
    [string]$Profile = "desktop",
    [switch]$Apply,
    [string]$ArchiveDir = "",
    [string]$PluginName = ""
)

$ErrorActionPreference = "Stop"

# ── 路径与前置检查 ─────────────────────────────────────────────
$repoRoot = Split-Path -Parent $PSScriptRoot
$generator = Join-Path $PSScriptRoot "gen-standard-tc.mjs"
$outDir = Join-Path $PSScriptRoot "out"
$outFile = Join-Path $outDir "preset-standard-tc.yml"
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
Write-Host "[2/3] 生成 standard 覆盖块并自检 ..." -ForegroundColor Cyan
$genArgs = @($dumpFile, $outFile, $ArchiveDir, "--profile-dir", $profileDir)
if ($PluginName) { $genArgs += @("--plugin-name", $PluginName) }
Push-Location $repoRoot
try {
    & node $generator @genArgs
    $genExit = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($genExit -ne 0) {
    Write-Error "生成或自检未通过，未产生可用产物。请核对 standard 结构是否变化（见上面差异明细）。"
}

# ── 3) 可选写回 profile 补丁 ───────────────────────────────────
if ($Apply) {
    Write-Host "[3/3] 写回 profile 补丁 ..." -ForegroundColor Cyan
    $patchPath = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\cordis.patch.yml"
    if (-not (Test-Path $patchPath)) { Write-Error "找不到 profile 补丁：$patchPath" }

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backup = "$patchPath.standard-tc-bak-$stamp"
    Copy-Item $patchPath $backup -Force
    Write-Host "      已备份 $backup"

    # 用 .NET 直读，避免 PS 版本差异带来的编码问题
    $patchText = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8)
    $beginMarker = '# ══ D17：standard 原地换压缩引擎'
    $endMarker = '# ══ D17 区块结束 ══'

    $newBlock = $beginMarker + " ══`n" + ((Get-Content $outFile -Encoding UTF8) -join "`n") + "`n" + $endMarker + "`n"

    if ($patchText.Contains($beginMarker)) {
        # 已有区块：从开始标记替换到「结束标记 / 下一个顶层条目 / 文件末尾」——
        # 历史写入的块可能缺结束标记（老版本 bug），三种边界都要认，否则 Replace
        # 静默不命中、还误报「已替换」。
        # 注意：不能用 (?=^- id: )——^ 在未开启 Multiline 时只匹配字符串开头，
        # 该分支会永远失效，正则退回 \z 把块后面所有条目一并吞掉。
        $pattern = [regex]::Escape($beginMarker) + '[\s\S]*?(\r?\n' + [regex]::Escape($endMarker) + '\r?\n|\r?\n(?=- id: )|\r?\n?\z)'
        $replaced = [System.Text.RegularExpressions.Regex]::Replace($patchText, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $newBlock }, 1)
        if ($replaced -eq $patchText) {
            Write-Error "替换未命中：D17 开始标记存在但边界匹配失败，中止写回（profile 未被改动）。"
        }
        $patchText = $replaced
        Write-Host "      已替换既有 D17 区块"
    } else {
        # 首次：追加到文件末尾
        if (-not $patchText.EndsWith("`n")) { $patchText += "`n" }
        $patchText += "`n" + $newBlock
        Write-Host "      已追加 D17 区块到补丁末尾"
    }

    [System.IO.File]::WriteAllText($patchPath, $patchText, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "      已写回 $patchPath"
    Write-Host "      生效方式：重启 DSH Desktop（新会话才会重新解析 preset）" -ForegroundColor Yellow
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
