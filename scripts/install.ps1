# Copies mods/file-explorer into the Herdr home and checks it. Copies rather than links:
# Herdr doesn't load SVGs or hot-reload through a linked mod folder.
#   -IconTheme seti      VS Code's default icons (the default)
#   -IconTheme material  Material Icon Theme
# Without -IconTheme, an existing install keeps the theme it has.
param([ValidateSet('seti', 'material')][string]$IconTheme)
$ErrorActionPreference = 'Stop'
# robocopy exits 1-7 on success; only 8+ is a failure.
$PSNativeCommandUseErrorActionPreference = $false
$repo = Split-Path -Parent $PSScriptRoot
$home_ = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME '.config\herdr-app' }
$src = Join-Path $repo 'mods\file-explorer'
$dest = Join-Path $home_ 'mods\file-explorer'
# Herdr docks a new mod folder into the shown layout unless its mod.json ("place": "none") is already there.
if (-not (Test-Path $dest)) {
    New-Item -ItemType Directory -Path $dest | Out-Null
    Copy-Item -LiteralPath (Join-Path $src 'mod.json') -Destination $dest
}
robocopy $src $dest /MIR /XF jsconfig.json *.d.ts config.json /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }
$config = Join-Path $dest 'config.json'
if ($IconTheme -or -not (Test-Path $config)) {
    $theme = if ($IconTheme) { $IconTheme } else { 'seti' }
    Set-Content -LiteralPath $config -Value "{ `"iconTheme`": `"$theme`" }" -Encoding utf8NoBOM
}
"icon theme: $((Get-Content -Raw $config | ConvertFrom-Json).iconTheme)"
# herdr-app.exe is a GUI program: PowerShell waits for it and shows its output only when piped.
herdr-app check $dest 2>&1 | Write-Output
exit $LASTEXITCODE
