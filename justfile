# byob - bring your own binge

# Build all packages
build: chrome firefox docker

# Build Chrome extension (.crx + unpacked)
chrome:
    nix build .#chrome-extension -o result-chrome
    @echo "Chrome extension:"
    @echo "  .crx:     result-chrome/byob-chrome.crx"
    @echo "  .zip:     result-chrome/byob-chrome.zip"
    @echo "  unpacked: result-chrome/unpacked/"

# Build Firefox extension (.xpi)
firefox:
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

# Clean build artifacts
clean:
    rm -f result-chrome result-firefox
    rm -rf _build
