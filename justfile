# byob - bring your own binge

# Build all packages
build: sync-version chrome firefox

# Build Chrome extension (.crx + unpacked)
chrome: sync-version
    nix build .#chrome-extension -o result-chrome
    chmod -R u+w build/chrome-unpacked 2>/dev/null || true
    rm -rf build/chrome-unpacked
    mkdir -p build
    cp -rL result-chrome/unpacked build/chrome-unpacked
    chmod -R u+w build/chrome-unpacked
    @echo "Chrome extension:"
    @echo "  .crx:     result-chrome/byob-chrome.crx"
    @echo "  .zip:     result-chrome/byob-chrome.zip"
    @echo "  unpacked: build/chrome-unpacked/"

# Build Firefox extension (.xpi)
firefox: sync-version
    nix build .#firefox-extension -o result-firefox
    @echo "Firefox extension: result-firefox/byob-firefox.xpi"
    @echo "Install via about:addons"

# Native Worker development server
dev:
    cd workers && corepack pnpm dev

# Syntax, version consistency and native regression tests
test:
    cd workers && corepack pnpm precommit

# Sync VERSION file into extension manifests
sync-version:
    #!/usr/bin/env bash
    V=$(cat VERSION | tr -d '\n')
    for f in extension/manifest.json extension/manifest.firefox.json workers/package.json; do
      sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$V\"/" "$f"
    done
    echo "Synced version $V to manifests"

# Bump version everywhere: just bump 0.7.0
bump NEW_VERSION:
    echo "{{NEW_VERSION}}" > VERSION
    just sync-version

# Build and deploy the native Worker after all release checks pass.
deploy:
    cd workers && corepack pnpm build:web && corepack pnpm exec wrangler deploy --config wrangler.production.jsonc && node scripts/verify-deployment.mjs

# Clean build artifacts
clean:
    rm -f result-chrome result-firefox
    rm -rf workers/dist
