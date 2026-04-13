$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = 'https://github.com/zhitongblog/solomd/releases/download/v0.1.8/SoloMD_0.1.8_x64-setup.exe'
  checksum64     = '868a9351eaf52b3cb204037ba592204d887950172ea7a982449b51ee81dd9e62'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
