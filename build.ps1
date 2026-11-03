<#
  build.ps1: build firefox.html (the real Gecko engine compiled to WebAssembly, packed into one HTML
  file).

  Windows: Gecko's WebAssembly build only runs on Linux, so this script runs build.sh inside
  WSL 2 (Ubuntu 24.04) and copies firefox.html back next to this script.
  Linux (PowerShell 7): it runs build.sh directly.

    powershell -ExecutionPolicy Bypass -File .\build.ps1          all stages (deps, clone, engine, pack)
    powershell -ExecutionPolicy Bypass -File .\build.ps1 pack     re-pack firefox.html from an existing build

  Stages: all, deps, clone, engine, pack.
  -WispUrl wss://relay.example.com/  bakes another default WISP relay (for websites) into
                                     firefox.html. Without it the default is wss://itcode.vip/api/.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('all', 'deps', 'clone', 'engine', 'pack')]
  [string]$Stage = 'all',
  [string]$Distro = 'Ubuntu-24.04',
  [string]$LinuxDir = '~/firefox-html-build',
  [string]$WispUrl = ''
)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Html = Join-Path $Here 'firefox.html'
$OnWindows = ($env:OS -eq 'Windows_NT')

function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function ConvertTo-BashLiteral([string]$Value) { "'" + ($Value -replace "'", "'\''") + "'" }

# ------------------------------------------------------- Linux / macOS --
if (-not $OnWindows) {
  if ($WispUrl) { $env:WISP_URL = $WispUrl }
  & bash (Join-Path $Here 'build.sh') $Stage
  exit $LASTEXITCODE
}

# ------------------------------------------------- Windows: via WSL 2 --
function Invoke-Wsl([string]$Command) {
  # -e runs bash directly (wsl.exe -- would pass the line through a second shell first).
  # Single quotes only inside $Command: Windows PowerShell 5.1 does not escape embedded
  # double quotes when it passes arguments to native programs.
  & wsl.exe -d $Distro -e bash -lc $Command
  if ($LASTEXITCODE -ne 0) { throw "Step failed inside WSL (exit code $LASTEXITCODE)." }
}

function Get-WslLines([string[]]$Arguments) {
  # Native output, with the NUL bytes older WSL versions emit (UTF-16) removed.
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    @(& wsl.exe @Arguments | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
  } finally {
    $ErrorActionPreference = $old
  }
}

$env:WSL_UTF8 = '1'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  throw "WSL is not installed. In an administrator PowerShell run:  wsl --install -d $Distro  (reboot if asked), open Ubuntu once from the Start menu to create your Linux user, then run this script again."
}
$distros = Get-WslLines @('-l', '-q')
if ($distros -notcontains $Distro) {
  $have = if ($distros.Count) { $distros -join ', ' } else { 'none' }
  throw "WSL distro '$Distro' is not installed (installed: $have). In an administrator PowerShell run:  wsl --install -d $Distro  then open it once from the Start menu to create your Linux user, and run this script again. Another Ubuntu 24.04 distro can be used with -Distro <name>."
}
$versionLine = @(Get-WslLines @('-l', '-v') | Where-Object { $_ -match "^\*?\s*$([regex]::Escape($Distro))\s" })
if ($versionLine.Count -and $versionLine[0] -match '\s1$') {
  throw "$Distro runs under WSL 1, which is far too slow for this build. Convert it with:  wsl --set-version $Distro 2"
}

# The build needs about 35 GB inside WSL (stored on the drive that holds %LOCALAPPDATA%) and
# works best with 12 GB+ of RAM given to WSL.
$drive = New-Object System.IO.DriveInfo ([System.IO.Path]::GetPathRoot($env:LOCALAPPDATA))
$freeGb = [math]::Floor($drive.AvailableFreeSpace / 1GB)
if ($freeGb -lt 40) { Write-Warning "Only $freeGb GB free on $($drive.Name). The WSL build needs about 35 GB." }
$wslRamGb = 0
try { $wslRamGb = [int](Get-WslLines @('-d', $Distro, '-e', 'awk', '/MemTotal/ {print int($2/1048576)}', '/proc/meminfo') | Select-Object -First 1) } catch { }
if ($wslRamGb -gt 0 -and $wslRamGb -lt 12) {
  Write-Warning ("WSL has $wslRamGb GB of RAM. If the build gets killed, give it more: create $env:USERPROFILE\.wslconfig with" +
    " the two lines  [wsl2]  and  memory=12GB  (plus  swap=16GB  on a 16 GB PC), run  wsl --shutdown , then rerun this script.")
}

Write-Step "Copying build files into WSL ($Distro, $LinuxDir)"
$winRoot = Get-WslLines @('-d', $Distro, '-e', 'wslpath', '-a', ($Here -replace '\\', '/')) | Select-Object -First 1
if (-not $winRoot) { throw "Could not translate $Here to a WSL path." }
$src = ConvertTo-BashLiteral $winRoot
Invoke-Wsl ("mkdir -p $LinuxDir && rm -rf $LinuxDir/resources/src && " +
  "cp -r $src/resources $src/build.sh $LinuxDir/ && sed -i 's/\r$//' $LinuxDir/build.sh $LinuxDir/resources/patches/*.patch && chmod +x $LinuxDir/build.sh")

Write-Step "Running build.sh $Stage inside WSL (the full build takes hours; sudo asks for your Linux password once)"
$wispEnv = if ($WispUrl) { 'WISP_URL=' + (ConvertTo-BashLiteral $WispUrl) + ' ' } else { '' }
Invoke-Wsl "cd $LinuxDir && $wispEnv./build.sh $Stage"

if ($Stage -eq 'all' -or $Stage -eq 'pack') {
  Write-Step "Copying firefox.html back to $Here"
  Invoke-Wsl "cp $LinuxDir/firefox.html $src/firefox.html"
  Write-Host ("firefox.html: {0:N0} bytes, ready to hand out." -f (Get-Item -LiteralPath $Html).Length) -ForegroundColor Green
}
