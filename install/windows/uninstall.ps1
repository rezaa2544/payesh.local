# حذف سامانه از ویندوز (داده‌ها حفظ می‌شوند مگر با -Purge)
param([switch]$Purge)
$ErrorActionPreference = 'Continue'
schtasks /Delete /TN 'PayeshLocal' /F 2>$null
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*Payesh*server*index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-NetFirewallRule -DisplayName 'Payesh Local' -ErrorAction SilentlyContinue
if ($Purge) {
    Remove-Item 'C:\Payesh' -Recurse -Force
    Write-Host 'برنامه و داده‌ها حذف شدند.' -ForegroundColor Yellow
} else {
    Write-Host 'سرویس حذف شد. پوشهٔ C:\Payesh (و داده‌ها) باقی ماند.' -ForegroundColor Green
}
