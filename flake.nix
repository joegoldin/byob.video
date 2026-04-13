{
  description = "byob - bring your own binge";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Extension packaging
        version = builtins.replaceStrings [ "\n" ] [ "" ] (builtins.readFile ./VERSION);
        extensionSrc = ./extension;

        chromeExtension = pkgs.stdenv.mkDerivation {
          pname = "byob-chrome-extension";
          inherit version;
          src = extensionSrc;
          nativeBuildInputs = [
            pkgs.zip
            pkgs.chromium
          ];
          phases = [
            "unpackPhase"
            "buildPhase"
            "installPhase"
          ];
          buildPhase = ''
            ${pkgs.gnused}/bin/sed -i 's/"version": "[^"]*"/"version": "${version}"/' manifest.json
            rm -f manifest.firefox.json
            mkdir -p $TMPDIR/ext
            cp -r . $TMPDIR/ext/src
            zip -r $TMPDIR/byob-chrome.zip .
            # Pack as .crx
            HOME=$TMPDIR chromium --pack-extension=$TMPDIR/ext/src --no-sandbox 2>/dev/null || true
          '';
          installPhase = ''
            mkdir -p $out/unpacked
            cp -r background.js content.js manifest.json lib $out/unpacked/
            cp $TMPDIR/byob-chrome.zip $out/
            if [ -f $TMPDIR/ext/src.crx ]; then
              cp $TMPDIR/ext/src.crx $out/byob-chrome.crx
              cp $TMPDIR/ext/src.pem $out/byob-chrome.pem
            fi
          '';
        };

        firefoxExtension = pkgs.stdenv.mkDerivation {
          pname = "byob-firefox-extension";
          inherit version;
          src = extensionSrc;
          nativeBuildInputs = [ pkgs.zip ];
          phases = [
            "unpackPhase"
            "buildPhase"
            "installPhase"
          ];
          buildPhase = ''
            cp manifest.firefox.json manifest.json
            ${pkgs.gnused}/bin/sed -i 's/"version": "[^"]*"/"version": "${version}"/' manifest.json
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
            Cmd = [
              "${pkgs.bash}/bin/bash"
              "-c"
              "echo 'Use the Dockerfile for the server image'"
            ];
            ExposedPorts = {
              "4000/tcp" = { };
            };
          };
        };

      in
      {
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
      }
    );
}
