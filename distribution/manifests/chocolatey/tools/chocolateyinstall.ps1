$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = 'https://github.com/zhitongblog/solomd/releases/download/v1.1.0/SoloMD_1.1.0_x64-setup.exe'
  checksum64     = '834d362515178c249e927ef9eb00531744b030d84f161ebde474fa82b8212aa5'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
