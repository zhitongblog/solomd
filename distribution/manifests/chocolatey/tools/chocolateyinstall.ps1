$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = 'https://github.com/zhitongblog/solomd/releases/download/v1.1.6/SoloMD_1.1.6_x64-setup.exe'
  checksum64     = 'b20f6f19957f22f1ca3e42ae96b795b2e0fb898c53acab46d45dcf130d75668d'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
