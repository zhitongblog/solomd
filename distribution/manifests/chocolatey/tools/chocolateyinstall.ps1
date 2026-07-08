$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = 'https://github.com/zhitongblog/solomd/releases/download/v1.2.1/SoloMD_1.2.1_x64-setup.exe'
  checksum64     = '7177315e349e0a7ea7c0f1a405141e8cad3861da9164d156daf1d2004f84b1dc'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
