{ pkgs, ... }:

{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_26;
  };

  packages = [
    pkgs.corepack
    pkgs.inotify-tools
  ];
}
