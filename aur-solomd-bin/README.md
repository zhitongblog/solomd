# SoloMD AUR Package

This directory contains the source for the **`solomd-bin`** package on the
[Arch User Repository (AUR)](https://aur.archlinux.org/packages/solomd-bin).

## Published package

[![AUR](https://img.shields.io/aur/version/solomd-bin)](https://aur.archlinux.org/packages/solomd-bin)

The package is published on AUR and kept in sync with the latest SoloMD release
via a daily auto-update job that checks GitHub releases.

## Install

```sh
# With an AUR helper (yay / paru)
yay -S solomd-bin

# Or manually
git clone https://aur.archlinux.org/solomd-bin.git
cd solomd-bin
makepkg -si
```

## Maintainership

Maintained by [@gonwe](https://github.com/gonwe). Contributions welcome — open
an issue on the AUR package page or submit a PR here to update this directory.
