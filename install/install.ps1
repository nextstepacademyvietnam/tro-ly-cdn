# Bộ cài Trợ lý CDN cho Windows 10/11.
# Người dùng bấm đúp file Cai-dat-Tro-ly-CDN.cmd; file đó tải script này về và chạy.
#
# Việc bộ cài làm (chạy lại lần nữa = sửa chữa / lên bản mới nhất, dữ liệu giữ nguyên):
#   1. Tải Node.js riêng cho app vào thư mục cài (không cần quyền quản trị, không đụng phần mềm khác)
#   2. Tải bản Trợ lý CDN mới nhất từ GitHub Releases, kiểm tra SHA256, cài vào versions\<số bản>
#   3. Cài Codex (công cụ nối gói ChatGPT)
#   4. Tạo biểu tượng "Trợ lý CDN" trên Màn hình nền + Start, cho app tự chạy nền khi mở máy
#   5. Mời đăng nhập ChatGPT, rồi mở app trên trình duyệt
#
# Biến môi trường để thử nghiệm: CDN_INSTALL_DIR, CDN_RELEASE_URL, CDN_NODE_DIST, CDN_PORT,
# CDN_SKIP_CODEX=1, CDN_NO_SERVICE=1, CDN_NO_OPEN=1, CDN_YES=1 (không hỏi gì).
# Viết cho Windows PowerShell 5.1 (có sẵn trên mọi máy Windows 10/11).

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$Repo = "nextstepacademyvietnam/tro-ly-cdn"
function EnvOr($name, $fallback) { $v = [Environment]::GetEnvironmentVariable($name); if ($v) { $v } else { $fallback } }
$ReleaseUrl = EnvOr "CDN_RELEASE_URL" "https://api.github.com/repos/$Repo/releases/latest"
$NodeDist = EnvOr "CDN_NODE_DIST" "https://nodejs.org/dist/latest-v22.x"
$Port = EnvOr "CDN_PORT" "3000"
$Dir = EnvOr "CDN_INSTALL_DIR" (Join-Path $env:LOCALAPPDATA "TroLyCDN")
$Yes = [bool](EnvOr "CDN_YES" "")
$Headers = @{ "User-Agent" = "tro-ly-cdn-installer"; "Accept" = "application/vnd.github+json" }

function Say($t) { Write-Host ""; Write-Host "> $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  [v] $t" -ForegroundColor Green }
function Note($t) { Write-Host "  $t" }
function Fail($t) { throw $t }
function Sha256($f) { (Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower() }
function Get-File($url, $out) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out -Headers @{ "User-Agent" = "tro-ly-cdn-installer" } }

try {
  Write-Host ""
  Write-Host "Bộ cài Trợ lý CDN — cài vào: $Dir" -ForegroundColor White
  New-Item -ItemType Directory -Force -Path (Join-Path $Dir "versions"), (Join-Path $Dir "data\logs") | Out-Null
  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("tro-ly-cdn-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
  $Arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $Tar = Join-Path $env:SystemRoot "System32\tar.exe"
  if (-not (Test-Path $Tar)) { Fail "Windows thiếu công cụ giải nén tar (cần Windows 10 bản 1803 trở lên)." }

  # ---------- 1. Node.js riêng cho app ----------
  Say "1/5 Node.js (chạy riêng cho Trợ lý CDN)"
  $Node = Join-Path $Dir "node\node.exe"
  $haveNode = $false
  if (Test-Path $Node) {
    $v = (& $Node -v) -replace "^v", ""
    $p = $v.Split(".")
    if ([int]$p[0] -gt 22 -or ([int]$p[0] -eq 22 -and [int]$p[1] -ge 13)) { $haveNode = $true; Ok "Đã có Node.js v$v" }
  }
  if (-not $haveNode) {
    $sums = Join-Path $Tmp "SHASUMS256.txt"
    try { Get-File "$NodeDist/SHASUMS256.txt" $sums } catch { Fail "Không tải được danh sách Node.js. Kiểm tra mạng rồi chạy lại." }
    $line = Select-String -LiteralPath $sums -Pattern "  (node-v[0-9.]+-win-$Arch\.zip)$" | Select-Object -First 1
    if (-not $line) { Fail "Không tìm thấy Node.js cho máy win-$Arch." }
    $file = $line.Matches[0].Groups[1].Value
    $expect = ($line.Line -split "\s+")[0].ToLower()
    Note "Đang tải $file…"
    $zip = Join-Path $Tmp $file
    try { Get-File "$NodeDist/$file" $zip } catch { Fail "Tải Node.js bị lỗi. Kiểm tra mạng rồi chạy lại." }
    if ((Sha256 $zip) -ne $expect) { Fail "File Node.js tải về bị hỏng (sai mã kiểm tra). Chạy lại bộ cài." }
    $unz = Join-Path $Tmp "node"
    Expand-Archive -LiteralPath $zip -DestinationPath $unz -Force
    $inner = Get-ChildItem -LiteralPath $unz -Directory | Select-Object -First 1
    $nodeDir = Join-Path $Dir "node"
    if (Test-Path $nodeDir) { Remove-Item -Recurse -Force -LiteralPath $nodeDir }
    Move-Item -LiteralPath $inner.FullName -Destination $nodeDir
    Ok "Đã cài Node.js $(& $Node -v)"
  }
  $env:Path = (Join-Path $Dir "node") + ";" + $env:Path
  $env:npm_config_prefix = Join-Path $Dir "node"
  $env:npm_config_update_notifier = "false"
  $env:npm_config_fund = "false"
  $env:npm_config_audit = "false"
  $Npm = Join-Path $Dir "node\npm.cmd"

  # ---------- 2. Trợ lý CDN ----------
  # Đang chạy (cài lại / lên bản mới) thì tắt trước; bước 4 bật lại.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Dir) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Say "2/5 Tải Trợ lý CDN bản mới nhất"
  try { $rel = Invoke-RestMethod -UseBasicParsing -Uri $ReleaseUrl -Headers $Headers } catch { Fail "Không hỏi được GitHub bản mới nhất. Kiểm tra mạng rồi chạy lại." }
  $tarAsset = $rel.assets | Where-Object { $_.name -like "*.tar.gz" } | Select-Object -First 1
  $sumAsset = $rel.assets | Where-Object { $_.name -eq "SHA256SUMS" } | Select-Object -First 1
  if (-not $rel.tag_name -or -not $tarAsset -or -not $sumAsset) { Fail "GitHub chưa có bản phát hành dùng được." }
  $Version = $rel.tag_name -replace "^v", ""
  $Target = Join-Path $Dir "versions\$Version"
  $currentFile = Join-Path $Dir "current.json"
  $Current = ""
  if (Test-Path $currentFile) { try { $Current = (Get-Content -Raw -LiteralPath $currentFile | ConvertFrom-Json).version } catch {} }
  if ($Current -eq $Version -and (Test-Path (Join-Path $Target "dist\server\index.js")) -and (Test-Path (Join-Path $Target "node_modules"))) {
    Ok "Đang dùng bản mới nhất v$Version"
  } else {
    Note "Đang tải v$Version…"
    $pkg = Join-Path $Tmp $tarAsset.name
    $sumFile = Join-Path $Tmp "SHA256SUMS"
    try { Get-File $tarAsset.browser_download_url $pkg; Get-File $sumAsset.browser_download_url $sumFile } catch { Fail "Tải gói cài bị lỗi. Kiểm tra mạng rồi chạy lại." }
    $expect = ""
    foreach ($l in Get-Content -LiteralPath $sumFile) { $parts = $l -split "\s+\*?"; if ($parts.Count -ge 2 -and $parts[1] -eq $tarAsset.name) { $expect = $parts[0].ToLower() } }
    if (-not $expect -or (Sha256 $pkg) -ne $expect) { Fail "Gói cài tải về bị hỏng (sai mã kiểm tra). Chạy lại bộ cài." }
    $stage = Join-Path $Dir "versions\.cai-$Version"
    if (Test-Path $stage) { Remove-Item -Recurse -Force -LiteralPath $stage }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    # tar.exe của Windows không đọc được đường dẫn có dấu (VD: C:\Users\Hiếu): chép gói vào thư mục đích
    # rồi chạy tar ngay trong đó, chỉ truyền tên file không dấu.
    Copy-Item -LiteralPath $pkg -Destination (Join-Path $stage "goi-cai.tar.gz")
    $tp = Start-Process -FilePath $Tar -ArgumentList "-xzf", "goi-cai.tar.gz" -WorkingDirectory $stage -NoNewWindow -Wait -PassThru
    Remove-Item -Force -LiteralPath (Join-Path $stage "goi-cai.tar.gz")
    if ($tp.ExitCode -ne 0) { Fail "Giải nén gói cài bị lỗi." }
    Note "Đang cài thư viện (1–3 phút)…"
    Push-Location -LiteralPath $stage
    try { & $Npm ci --omit=dev --no-audit --no-fund --loglevel=error; if ($LASTEXITCODE -ne 0) { Fail "Cài thư viện bị lỗi." } } finally { Pop-Location }
    if (Test-Path $Target) { Remove-Item -Recurse -Force -LiteralPath $Target }
    Move-Item -LiteralPath $stage -Destination $Target
    $prev = if ($Current -and $Current -ne $Version) { $Current } else { $null }
    [IO.File]::WriteAllText($currentFile, (@{ version = $Version; previous = $prev } | ConvertTo-Json))
    Ok "Đã cài Trợ lý CDN v$Version"
  }
  Copy-Item -Force -LiteralPath (Join-Path $Target "launcher.mjs") -Destination (Join-Path $Dir "launcher.mjs")

  # ---------- 3. Codex (gói ChatGPT) ----------
  Say "3/5 Codex (công cụ nối gói ChatGPT)"
  $Codex = Join-Path $Dir "node\codex.cmd"
  if (EnvOr "CDN_SKIP_CODEX" "") { Note "Bỏ qua (CDN_SKIP_CODEX)." }
  elseif (Test-Path $Codex) { Ok "Đã có Codex" }
  else {
    & $Npm install -g "@openai/codex" --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { Fail "Cài Codex bị lỗi." }
    Ok "Đã cài Codex"
  }

  # ---------- 4. Biểu tượng + chạy nền ----------
  Say "4/5 Biểu tượng và tự chạy khi mở máy"

  $run = @"
' Bật Trợ lý CDN chạy nền, không hiện cửa sổ (bộ cài tạo file này).
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
Set env = sh.Environment("Process")
env("PATH") = dir & "\node;" & env("PATH")
env("CDN_DATA_DIR") = dir & "\data"
env("PORT") = "$Port"
env("npm_config_prefix") = dir & "\node"
sh.CurrentDirectory = dir
sh.Run "cmd /c node """ & dir & "\launcher.mjs"" >> """ & dir & "\data\logs\tro-ly-cdn.log"" 2>&1", 0, False
"@
  $open = @"
' Mở Trợ lý CDN: chưa chạy thì bật, rồi mở trình duyệt (bộ cài tạo file này).
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
Function Running()
  On Error Resume Next
  Set h = CreateObject("MSXML2.ServerXMLHTTP")
  h.setTimeouts 1000, 1000, 1000, 1000
  h.Open "GET", "http://127.0.0.1:$Port/api/status", False
  h.Send
  Running = (Err.Number = 0 And h.Status = 200)
End Function
If Not Running() Then
  sh.Run "wscript """ & dir & "\chay-nen.vbs""", 0, False
  For i = 1 To 40
    WScript.Sleep 1000
    If Running() Then Exit For
  Next
End If
sh.Run "http://localhost:$Port"
"@
  $dirQuoted = $Dir -replace "'", "''"
  $stop = @"
@echo off
chcp 65001 >nul
rem Tắt Trợ lý CDN (bộ cài tạo file này).
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { `$_.CommandLine -and `$_.CommandLine.Contains('$dirQuoted') } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force }"
echo Đã tắt Trợ lý CDN.
ping -n 3 127.0.0.1 >nul
"@
  # VBScript đọc được đường dẫn có dấu tiếng Việt khi lưu UTF-16 (Unicode).
  [IO.File]::WriteAllText((Join-Path $Dir "chay-nen.vbs"), $run, [Text.Encoding]::Unicode)
  [IO.File]::WriteAllText((Join-Path $Dir "mo-tro-ly-cdn.vbs"), $open, [Text.Encoding]::Unicode)
  [IO.File]::WriteAllText((Join-Path $Dir "tat-tro-ly-cdn.cmd"), ($stop -replace "`r?`n", "`r`n"), (New-Object Text.UTF8Encoding $false))

  $reset = @"
@echo off
chcp 65001 >nul
title Đặt lại mật khẩu Trợ lý CDN
rem Quên mật khẩu đăng nhập web: đặt lại ngay trên máy này (bộ cài tạo file này).
set "CDN_DATA_DIR=%~dp0data"
"%~dp0node\node.exe" "%~dp0launcher.mjs" --dat-lai-mat-khau %*
echo.
pause
"@
  [IO.File]::WriteAllText((Join-Path $Dir "Dat-lai-mat-khau.cmd"), ($reset -replace "`r?`n", "`r`n"), (New-Object Text.UTF8Encoding $false))

  $uninstall = @"
@echo off
chcp 65001 >nul
rem Gỡ Trợ lý CDN (bộ cài tạo file này).
echo Gỡ Trợ lý CDN khỏi máy này.
call "%~dp0tat-tro-ly-cdn.cmd" >nul
del /q "%USERPROFILE%\Desktop\Trợ lý CDN.lnk" 2>nul
del /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Trợ lý CDN.lnk" 2>nul
del /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Tắt Trợ lý CDN.lnk" 2>nul
del /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Đặt lại mật khẩu Trợ lý CDN.lnk" 2>nul
del /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Trợ lý CDN.lnk" 2>nul
set /p XOA=Xoá cả dữ liệu (hộp thư, tính cách, đăng nhập Zalo)? Gõ XOA rồi Enter để xoá, Enter để giữ:
set "D=%~dp0"
cd /d "%TEMP%"
if /i "%XOA%"=="XOA" (echo Đã gỡ và xoá dữ liệu.) else (echo Đã gỡ. Dữ liệu vẫn giữ ở %D%data)
pause
rem File này tự xoá chính nó: "(goto)" thoát khỏi file trước khi xoá để cmd không báo lỗi.
if /i "%XOA%"=="XOA" ((goto) 2>nul & rmdir /s /q "%D%") else ((goto) 2>nul & rmdir /s /q "%D%node" & rmdir /s /q "%D%versions" & del /q "%D%launcher.mjs" "%D%current.json" "%D%chay-nen.vbs" "%D%mo-tro-ly-cdn.vbs" "%D%tat-tro-ly-cdn.cmd" "%D%Dat-lai-mat-khau.cmd" "%D%go-cai-dat.cmd")
"@
  [IO.File]::WriteAllText((Join-Path $Dir "go-cai-dat.cmd"), ($uninstall -replace "`r?`n", "`r`n"), (New-Object Text.UTF8Encoding $false))

  if (-not (EnvOr "CDN_NO_SERVICE" "")) {
    $ws = New-Object -ComObject WScript.Shell
    $fso = New-Object -ComObject Scripting.FileSystemObject
    # Đường dẫn 8.3 (chỉ chữ không dấu) của file / thư mục; không lấy được thì giữ nguyên.
    function Short($p) {
      try { if (Test-Path -LiteralPath $p -PathType Container) { $fso.GetFolder($p).ShortPath } else { $fso.GetFile($p).ShortPath } } catch { $p }
    }
    function NoMarks($t) {
      $d = $t.Normalize([Text.NormalizationForm]::FormD)
      $o = -join ($d.ToCharArray() | Where-Object { [Globalization.CharUnicodeInfo]::GetUnicodeCategory($_) -ne "NonSpacingMark" })
      $o -replace "đ", "d" -replace "Đ", "D"
    }
    # WScript lưu lối tắt theo bảng mã ANSI: tên hay đường dẫn có chữ như "ợ" thành "?" và báo
    # "Unable to save shortcut" (VD: Màn hình nền OneDrive "Máy tính", tên "Trợ lý CDN.lnk",
    # người dùng C:\Users\Hiếu). Nên tạo bằng tên tạm không dấu, mọi đường dẫn bên trong dạng 8.3,
    # mô tả bỏ dấu, rồi đổi sang tên tiếng Việt bằng PowerShell (đọc đúng Unicode).
    function New-Shortcut($path, $target, $arguments, $desc) {
      $folder = Split-Path -Parent $path
      New-Item -ItemType Directory -Force -Path $folder | Out-Null
      $tmp = Join-Path (Short $folder) ("tro-ly-cdn-" + [Guid]::NewGuid().ToString("N").Substring(0, 8) + ".lnk")
      if ($arguments -match '^"(.+)"$') { $arguments = '"' + (Short $Matches[1]) + '"' }
      $s = $ws.CreateShortcut($tmp)
      $s.TargetPath = (Short $target)
      $s.Arguments = $arguments
      $s.WorkingDirectory = (Short $Dir)
      $s.Description = (NoMarks $desc)
      $s.IconLocation = (Short (Join-Path $Dir "node\node.exe")) + ",0"
      $s.Save()
      if (Test-Path -LiteralPath $path) { Remove-Item -Force -LiteralPath $path }
      Move-Item -LiteralPath $tmp -Destination $path
    }
    $wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
    $programs = [Environment]::GetFolderPath("Programs")
    New-Shortcut (Join-Path ([Environment]::GetFolderPath("Desktop")) "Trợ lý CDN.lnk") $wscript "`"$Dir\mo-tro-ly-cdn.vbs`"" "Mở Trợ lý CDN"
    New-Shortcut (Join-Path $programs "Trợ lý CDN.lnk") $wscript "`"$Dir\mo-tro-ly-cdn.vbs`"" "Mở Trợ lý CDN"
    New-Shortcut (Join-Path $programs "Tắt Trợ lý CDN.lnk") (Join-Path $Dir "tat-tro-ly-cdn.cmd") "" "Tắt Trợ lý CDN"
    New-Shortcut (Join-Path $programs "Đặt lại mật khẩu Trợ lý CDN.lnk") (Join-Path $Dir "Dat-lai-mat-khau.cmd") "" "Quên mật khẩu đăng nhập Trợ lý CDN"
    New-Shortcut (Join-Path ([Environment]::GetFolderPath("Startup")) "Trợ lý CDN.lnk") $wscript "`"$Dir\chay-nen.vbs`"" "Bật Trợ lý CDN khi mở máy"
    Ok "Đã tạo biểu tượng `"Trợ lý CDN`" trên Màn hình nền và menu Start; app tự chạy khi mở máy."
  } else {
    Note "Không tạo biểu tượng (CDN_NO_SERVICE)."
  }
  Start-Process -FilePath (Join-Path $env:SystemRoot "System32\wscript.exe") -ArgumentList "`"$Dir\chay-nen.vbs`""

  # ---------- 5. Đăng nhập ChatGPT, mở app ----------
  Say "5/5 Hoàn tất"
  $up = $false
  for ($i = 0; $i -lt 60; $i++) {
    try { $s = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 2; if ($s.version) { $up = $true; break } } catch {}
    Start-Sleep -Seconds 1
  }
  if (-not $up) { Fail "App chưa chạy được. Xem nhật ký: $Dir\data\logs\tro-ly-cdn.log" }
  Ok "Trợ lý CDN đang chạy: http://localhost:$Port"

  if (-not (EnvOr "CDN_SKIP_CODEX" "") -and -not $Yes) {
    $ans = Read-Host "  Đăng nhập gói ChatGPT ngay? Bấm Enter để đăng nhập, gõ k rồi Enter để làm sau"
    if ($ans -ne "k" -and $ans -ne "K") {
      Note "Trình duyệt sẽ mở trang đăng nhập ChatGPT. Đăng nhập đúng tài khoản trả phí rồi quay lại đây."
      & $Codex login
      if ($LASTEXITCODE -ne 0) { Note "Chưa đăng nhập được. Làm lại sau: mở menu Start, gõ cmd, chạy lệnh `"$Codex`" login" }
    }
  }
  if (-not (EnvOr "CDN_NO_OPEN" "")) { Start-Process "http://localhost:$Port" }

  Write-Host ""
  Write-Host "Xong! Mở trình duyệt vào http://localhost:$Port để thiết lập." -ForegroundColor Green
  Note "Lần sau bấm biểu tượng `"Trợ lý CDN`" trên Màn hình nền để mở app."
  Note "Nơi cài và dữ liệu: $Dir"
  Note "Gỡ cài đặt: chạy file go-cai-dat.cmd trong thư mục trên."
  Write-Host ""
  exit 0
} catch {
  Write-Host ""
  Write-Host "[x] $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  Chụp màn hình cửa sổ này gửi người hỗ trợ."
  exit 1
} finally {
  if ($Tmp -and (Test-Path $Tmp)) { Remove-Item -Recurse -Force -LiteralPath $Tmp -ErrorAction SilentlyContinue }
}
