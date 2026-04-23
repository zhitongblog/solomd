cask "solomd" do
  version "1.1.6"
  sha256 "8f6c9aedfe8a81e62d2d453e44d532454642942e7737ba5736f1a96ee4dd9d92"

  url "https://github.com/zhitongblog/solomd/releases/download/v#{version}/SoloMD_#{version}_universal.dmg"
  name "SoloMD"
  desc "Lightweight Markdown editor with live preview"
  homepage "https://solomd.app/"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :big_sur"

  app "SoloMD.app"

  zap trash: [
    "~/Library/Application Support/app.solomd",
    "~/Library/Caches/app.solomd",
    "~/Library/Preferences/app.solomd.plist",
    "~/Library/Saved Application State/app.solomd.savedState",
  ]
end
