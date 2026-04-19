$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = 'https://github.com/zhitongblog/solomd/releases/download/v1.0.0/SoloMD_1.0.0_x64-setup.exe'
  checksum64     = 'b06f603b1fc8b81fcccf953c646428fee2b378f064a85909577ee12a9e6a3e21'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
