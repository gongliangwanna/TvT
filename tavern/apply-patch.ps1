# 酒馆互通补丁：把 tavern/ 文件夹里的外挂接进 yuan。
# 用法：yuan 更新（用新文件覆盖）后，双击同目录的“打补丁.bat”。重复运行没有副作用。
#
# 做三件事：
#   1. yuan 自带的 manifest.json（网页安装用）改名为 pwa-manifest.json，给酒馆扩展腾位置
#   2. 把 tavern/st-manifest.json 复制为根目录的 manifest.json（酒馆靠它识别这是个扩展）
#   3. 修改 index.html：引用改名后的 pwa-manifest.json；在 99-mount.js 之后插入外挂的加载行

$ErrorActionPreference = 'Stop'
$tavernDir = $PSScriptRoot
$root = Split-Path $tavernDir -Parent
$utf8 = New-Object System.Text.UTF8Encoding($false)
$problems = 0

function Say($msg, $color = 'White') { Write-Host $msg -ForegroundColor $color }

Say "小手机目录：$root" 'Cyan'

# ---------- 1 & 2. manifest ----------
$manifestPath = Join-Path $root 'manifest.json'
$pwaPath = Join-Path $root 'pwa-manifest.json'
$stManifestPath = Join-Path $tavernDir 'st-manifest.json'

if (Test-Path $manifestPath) {
    $manifestText = [IO.File]::ReadAllText($manifestPath, $utf8)
    if ($manifestText -match '"loading_order"') {
        Say '[跳过] manifest.json 已经是酒馆扩展用的版本' 'DarkGray'
    } else {
        Move-Item -Force $manifestPath $pwaPath
        Say '[完成] yuan 的 manifest.json 已改名为 pwa-manifest.json' 'Green'
    }
}
Copy-Item -Force $stManifestPath $manifestPath
Say '[完成] 已放入酒馆扩展用的 manifest.json' 'Green'

# ---------- 3. index.html ----------
$indexPath = Join-Path $root 'index.html'
if (-not (Test-Path $indexPath)) {
    Say '[失败] 找不到 index.html，请确认 tavern 文件夹放在 yuan 根目录下' 'Red'
    exit 1
}
$html = [IO.File]::ReadAllText($indexPath, $utf8)
$original = $html
$nl = if ($html.Contains("`r`n")) { "`r`n" } else { "`n" }

# 3a. manifest 引用
if ($html.Contains('href="pwa-manifest.json"')) {
    Say '[跳过] index.html 已经引用 pwa-manifest.json' 'DarkGray'
} else {
    $linkPattern = '(<link[^>]*rel="manifest"[^>]*href=")manifest\.json("[^>]*>)'
    if ([regex]::IsMatch($html, $linkPattern)) {
        $html = [regex]::Replace($html, $linkPattern, '${1}pwa-manifest.json" crossorigin="use-credentials${2}')
        Say '[完成] index.html 改为引用 pwa-manifest.json' 'Green'
    } else {
        Say '[警告] index.html 里找不到 manifest.json 的引用（不影响酒馆互通，只影响“添加到主屏幕”）' 'Yellow'
    }
}

# 3b. 外挂加载行
if ($html.Contains('tavern/tavern_hooks.js')) {
    Say '[跳过] index.html 里已有外挂加载行' 'DarkGray'
} else {
    $mountPattern = '(?m)^([ \t]*)(<script[^>]*js/generated/html/99-mount\.js[^>]*></script>)(?=[ \t]*\r?$)'
    $m = [regex]::Match($html, $mountPattern)
    if (-not $m.Success) {
        Say '[失败] index.html 里找不到 99-mount.js 那一行，yuan 可能改了页面加载方式，需要调整补丁' 'Red'
        $problems++
    } else {
        $indent = $m.Groups[1].Value
        $block = @(
            "$indent<!-- ===== 酒馆互通外挂 开始（由 tavern/apply-patch.ps1 自动添加，位置必须在 99-mount.js 之后、ui.js 之前）===== -->",
            "$indent<script src=`"tavern/tavern_sync.js`"></script>",
            "$indent<script src=`"tavern/tavern_hooks.js`"></script>",
            "$indent<!-- ===== 酒馆互通外挂 结束 ===== -->"
        ) -join $nl
        $insertAt = $m.Index + $m.Length
        $html = $html.Substring(0, $insertAt) + $nl + $block + $html.Substring($insertAt)
        Say '[完成] index.html 已加入外挂加载行' 'Green'
    }
}

if ($html -ne $original) {
    [IO.File]::WriteAllText($indexPath, $html, $utf8)
}

Say ''
if ($problems -eq 0) {
    Say '补丁完成。' 'Green'
} else {
    Say "补丁有 $problems 处没能完成，请看上面的红字。" 'Red'
    exit 1
}
