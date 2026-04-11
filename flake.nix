{
  description = "byob - bring your own binge";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Extension packaging
        extensionSrc = ./extension;

        chromeExtension = pkgs.stdenv.mkDerivation {
          pname = "byob-chrome-extension";
          version = "0.1.0";
          src = extensionSrc;
          installPhase = ''
            mkdir -p $out
            cp -r $src/* $out/
            # Use the MV3 manifest (already in place)
          '';
        };

        firefoxExtension = pkgs.stdenv.mkDerivation {
          pname = "byob-firefox-extension";
          version = "0.1.0";
          src = extensionSrc;
          nativeBuildInputs = [ pkgs.zip ];
          phases = [ "unpackPhase" "buildPhase" "installPhase" ];
          buildPhase = ''
            cp manifest.firefox.json manifest.json
            rm manifest.firefox.json
            zip -r byob-firefox.xpi .
          '';
          installPhase = ''
            mkdir -p $out/unpacked
            cp byob-firefox.xpi $out/
            cp -r background.js content.js manifest.json lib $out/unpacked/
          '';
        };

        # Docker image via Nix
        dockerImage = pkgs.dockerTools.buildLayeredImage {
          name = "byob";
          tag = "latest";
          contents = with pkgs; [
            coreutils
            bash
            cacert
            openssl
          ];
          config = {
            Cmd = [ "${pkgs.bash}/bin/bash" "-c" "echo 'Use the Dockerfile for the server image'" ];
            ExposedPorts = { "4000/tcp" = {}; };
          };
        };

      in {
        packages = {
          chrome-extension = chromeExtension;
          firefox-extension = firefoxExtension;
          docker = dockerImage;
          default = chromeExtension;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            elixir_1_18
            nodejs_22
            inotify-tools
          ];
        };
      });
}
