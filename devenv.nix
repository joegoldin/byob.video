{ pkgs, ... }:

{
  languages.elixir.enable = true;
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
  };

  packages = [
    pkgs.inotify-tools
  ];
}
