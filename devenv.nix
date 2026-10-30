{ pkgs, ... }:

{
  languages.elixir = {
    enable = true;
    package = pkgs.elixir_1_19;
  };
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
  };

  packages = [
    pkgs.inotify-tools
  ];
}
