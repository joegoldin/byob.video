defmodule Byob.Links do
  @moduledoc "Central config for external links"

  def source_code, do: "https://github.com/joegoldin/byob.video"
  def privacy_policy, do: "https://github.com/joegoldin/byob.video/blob/main/PRIVACY.md"
  def sponsor_block, do: "https://sponsor.ajay.app"
  def chrome_extension, do: "https://chromewebstore.google.com/detail/jlpogmjckejgpbbfhafgjgkbnocjfbmb"
  def firefox_extension, do: "https://addons.mozilla.org/en-US/firefox/addon/byob-bring-your-own-binge/"

  @doc "Returns JS expression that navigates to the right extension page based on browser"
  def extension_js do
    "window.open(/Firefox/.test(navigator.userAgent) ? '#{firefox_extension()}' : '#{chrome_extension()}', '_blank')"
  end
end
