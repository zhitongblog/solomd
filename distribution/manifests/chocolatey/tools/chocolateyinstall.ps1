$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = 'https://github.com/zhitongblog/solomd/releases/download/v1.1.5/SoloMD_1.1.5_x64-setup.exe'
  checksum64     = '0dc5576948bda8f509d303928d817612e6f98e3c03759e23d7fb0d37f810b534'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
