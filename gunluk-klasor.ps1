# Masaüstü\INSTAGRAM cosmoderm\<tarih> klasörlerini gün gün ekler: o günün 4 paylaşımı + açıklama metinleri (.txt).
# Bugüne kadarki (bugün dahil) eksik günleri tamamlar; bilgisayar birkaç gün kapalı kaldıysa açılınca hepsini ekler.
# Zamanlanmış görev çalıştırır (oturum açılınca + her gün 09:30). Elle: powershell -File gunluk-klasor.ps1
$ErrorActionPreference = 'Stop'
$repo = Join-Path $env:USERPROFILE 'Documents\cosmoderm-instagram-repo'
$hedef = Join-Path ([Environment]::GetFolderPath('Desktop')) 'INSTAGRAM cosmoderm'
$log = Join-Path $repo 'gunluk-klasor.log'

$schedule = Get-Content (Join-Path $repo 'schedule.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$bugun = (Get-Date).ToString('yyyy-MM-dd')
$eklenen = 0
foreach ($g in ($schedule | Where-Object { $_.date -le $bugun } | Group-Object date)) {
    $klasor = Join-Path $hedef $g.Name
    New-Item -ItemType Directory -Force $klasor | Out-Null
    foreach ($p in $g.Group) {
        $ad = '{0} - {1} - {2}' -f $p.time.Replace(':', '.'), $p.lang.ToUpper(), $p.file
        $hedefDosya = Join-Path $klasor $ad
        if (-not (Test-Path $hedefDosya)) {
            Copy-Item (Join-Path $repo "media\$($p.file)") $hedefDosya
            [IO.File]::WriteAllText("$hedefDosya.txt", $p.caption, [Text.UTF8Encoding]::new($false))
            $eklenen++
        }
    }
}
"$(Get-Date -Format s) eklenen dosya: $eklenen" | Add-Content $log -Encoding UTF8
