@echo off
chcp 65001 >nul
title Restaurant Ordering - Firewall Setup

REM ---- 沒有系統管理員權限就自我提權（會跳出 UAC 視窗）----
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo 需要系統管理員權限，正在請求授權...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo ============================================
echo   餐廳點餐系統 - 開放區網連線設定
echo ============================================
echo.

echo [1/3] 移除封鎖 Node.js 的舊規則...
powershell -NoProfile -Command "$b = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*node.exe*' } | Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' }; if ($b) { $b | Remove-NetFirewallRule; Write-Host ('  已移除 ' + @($b).Count + ' 條封鎖規則') } else { Write-Host '  沒有封鎖規則' }"

echo [2/3] 把店內 WiFi 設為私人網路...
powershell -NoProfile -Command "Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private; Write-Host '  完成'"

echo [3/3] 開放 3001 埠（僅限同一區網的裝置）...
powershell -NoProfile -Command "Remove-NetFirewallRule -DisplayName 'Restaurant Ordering 3001' -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName 'Restaurant Ordering 3001' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3001 -Profile Any -RemoteAddress LocalSubnet | Out-Null; Write-Host '  完成'"

echo.
echo ================ 設定結果 ================
powershell -NoProfile -Command "$cat = (Get-NetConnectionProfile | Select-Object -First 1).NetworkCategory; $fw = Get-NetFirewallRule -DisplayName 'Restaurant Ordering 3001' -ErrorAction SilentlyContinue; $blk = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*node.exe*' } | Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' }).Count; Write-Host ('  網路類別   : ' + $cat); Write-Host ('  3001 放行  : ' + $(if ($fw) { '已建立' } else { '失敗' })); Write-Host ('  殘留封鎖   : ' + $blk + ' 條'); Write-Host ''; if ($cat -eq 'Private' -and $fw -and $blk -eq 0) { Write-Host '  >> 設定成功！' -ForegroundColor Green } else { Write-Host '  >> 設定未完全成功，請把畫面截圖給 Claude' -ForegroundColor Yellow }"
powershell -NoProfile -Command "$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' } | Select-Object -First 1).IPAddress; Write-Host ''; Write-Host ('  手機請開: http://' + $ip + ':3001/t/1') -ForegroundColor Cyan"

echo.
echo 設定完成，可以關閉這個視窗，然後用手機再試一次。
pause
