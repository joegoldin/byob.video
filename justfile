# byob - bring your own binge

# Build all packages
build: sync-version chrome firefox docker

# Build Chrome extension (.crx + unpacked)
chrome: sync-version
    nix build .#chrome-extension -o result-chrome
    @echo "Chrome extension:"
    @echo "  .crx:     result-chrome/byob-chrome.crx"
    @echo "  .zip:     result-chrome/byob-chrome.zip"
    @echo "  unpacked: result-chrome/unpacked/"

# Build Firefox extension (.xpi)
firefox: sync-version
    nix build .#firefox-extension -o result-firefox
    @echo "Firefox extension: result-firefox/byob-firefox.xpi"
    @echo "Install via about:addons"

# Build Docker server image
docker:
    docker build -t byob .
    @echo "Run: docker run -p 4000:4000 -e SECRET_KEY_BASE=\$(mix phx.gen.secret) -e PHX_HOST=byob.video byob"

# Dev server
dev:
    mix phx.server

# Run tests
test:
    mix test

# Sync VERSION file into extension manifests
sync-version:
    #!/usr/bin/env bash
    V=$(cat VERSION | tr -d '\n')
    for f in extension/manifest.json extension/manifest.firefox.json; do
      sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$V\"/" "$f"
    done
    echo "Synced version $V to manifests"

# Bump version everywhere: just bump 0.7.0
bump NEW_VERSION:
    echo "{{NEW_VERSION}}" > VERSION
    just sync-version

# Clean build artifacts
clean:
    rm -f result-chrome result-firefox
    rm -rf _build
