$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = 'https://github.com/zhitongblog/solomd/releases/download/v1.1.1/SoloMD_1.1.1_x64-setup.exe'
  checksum64     = '266b3350aee8c8d768b120b7f49f714ecd6c2b7cb01430ec4817ec84b7fe65af'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
