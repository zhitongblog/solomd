$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = 'https://github.com/zhitongblog/solomd/releases/download/v1.1.4/SoloMD_1.1.4_x64-setup.exe'
  checksum64     = '545661a7e1ad4200befd26cd9601ae061e2bccf81f7c65b1d2588996c6841619'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
