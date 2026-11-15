# Copies mods/file-explorer into the Herdr home and checks it. Copies rather than links:
# Herdr doesn't load SVGs or hot-reload through a linked mod folder.
#   -IconTheme seti      VS Code's default icons (the default)
#   -IconTheme material  Material Icon Theme
#   -EditorFont vscode   VS Code's default font (the default); "terminal" or a font name for others
#   -EditorFontSize 14   12 to 16; without it, VS Code's default size
# Options left out keep what an existing install has. The gear menu's choices override them all.
param(
    [ValidateSet('seti', 'material')][string]$IconTheme,
    [string]$EditorFont,
    [ValidateRange(12, 16)][int]$EditorFontSize
)
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
$old = if (Test-Path $config) { Get-Content -Raw $config | ConvertFrom-Json } else { $null }
$settings = [ordered]@{
    iconTheme  = if ($IconTheme) { $IconTheme } elseif ($old.iconTheme) { $old.iconTheme } else { 'seti' }
    editorFont = if ($EditorFont) { $EditorFont } elseif ($old.editorFont) { $old.editorFont } else { 'vscode' }
}
$size = if ($EditorFontSize) { $EditorFontSize } else { $old.editorFontSize }
if ($size) { $settings.editorFontSize = [int]$size }
# WriteAllText writes UTF-8 without a BOM in both Windows PowerShell and PowerShell 7.
[IO.File]::WriteAllText($config, ($settings | ConvertTo-Json))
"icon theme: $($settings.iconTheme), editor font: $($settings.editorFont)$(if ($size) { " $size" })"
# herdr-app.exe is a GUI program: PowerShell waits for it and shows its output only when piped.
herdr-app check $dest 2>&1 | Write-Output
exit $LASTEXITCODE
