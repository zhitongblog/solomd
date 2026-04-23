$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = 'https://github.com/zhitongblog/solomd/releases/download/v1.1.2/SoloMD_1.1.2_x64-setup.exe'
  checksum64     = '1cc3e101175a3a6385836fabfddda5874c0a36b708883a5b57996e127f017fff'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
