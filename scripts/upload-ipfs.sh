#!/bin/bash
# Add the token assets to IPFS and write metadata pointing at them, ending
# with the base URI to set on the contract:
#
#   1. previews          (runs gen-previews.js unless previews/png is populated)
#   2. app/           -> APP_CID     (whole app dir, so the pages' relative
#                                     js/css/data paths resolve on IPFS)
#   3. previews/png/  -> IMAGES_CID
#   4. metadata/         (gen-metadata.js with those CIDs)
#   5. metadata/      -> META_CID; base URI is ipfs://META_CID/
#
# A real run records the CIDs in ipfs-cids.env (committable, and sourceable
# by later tooling); a dry run only prints them, since nothing was added.
#
# Flags:
#   --dry-run       compute the same CIDs and write the same metadata without
#                   adding anything to the node (ipfs add --only-hash)
#   --car[=FILE]    also wrap app + previews + metadata under one root and
#                   export it as a CAR file (default grinding.car), ready to
#                   upload to a pinning service such as pinata.cloud. Adding
#                   is deterministic, so the wrapped subdirectories keep the
#                   exact CIDs the metadata references — pinning the CAR's
#                   root pins every block the tokens need. Needs a real run.
#
# `ipfs add` writes to (and pins on) the local node; content is fetchable by
# others once the daemon is online, and should be pinned somewhere durable
# before minting for real. SHOW_URL_BASE is passed through to gen-metadata.js
# if set. IPFS overrides the binary.

set -euo pipefail
cd "$(dirname "$0")/.."

IPFS="${IPFS:-ipfs}"

ONLY_HASH=""
CAR_OUT=""
for arg in "$@"; do
    case "$arg" in
        --dry-run) ONLY_HASH="-n" ;;
        --car) CAR_OUT="grinding.car" ;;
        --car=*) CAR_OUT="${arg#--car=}" ;;
        *) echo "unknown flag $arg (want --dry-run, --car[=FILE])" >&2; exit 1 ;;
    esac
done
if [ -n "$CAR_OUT" ] && [ -n "$ONLY_HASH" ]; then
    echo "--car needs a real run: a dry run stores no blocks to export" >&2
    exit 1
fi

add_dir() {
    "$IPFS" add -r -Q --cid-version 1 $ONLY_HASH "$1"
}

if [ -z "$(ls previews/png/*.png 2>/dev/null)" ]; then
    node scripts/gen-previews.js
fi

APP_CID=$(add_dir app)
echo "app       ipfs://$APP_CID/"

IMAGES_CID=$(add_dir previews/png)
echo "previews  ipfs://$IMAGES_CID/"

APP_CID="$APP_CID" IMAGES_CID="$IMAGES_CID" node scripts/gen-metadata.js

META_CID=$(add_dir metadata)
echo "metadata  ipfs://$META_CID/"

ROOT_CID=""
if [ -n "$CAR_OUT" ]; then
    # one root over the three trees; cp into a staging dir rather than MFS
    # tricks so the wrapper is one plain deterministic add
    stage=$(mktemp -d)
    trap 'rm -rf "$stage"' EXIT
    mkdir "$stage/grinding"
    cp -r app "$stage/grinding/app"
    cp -r previews/png "$stage/grinding/previews"
    cp -r metadata "$stage/grinding/metadata"
    ROOT_CID=$(add_dir "$stage/grinding")
    "$IPFS" dag export "$ROOT_CID" > "$CAR_OUT"
    echo "car       $CAR_OUT ($(du -h "$CAR_OUT" | cut -f1)) root $ROOT_CID"
fi

if [ -z "$ONLY_HASH" ]; then
    {
        echo "# written by scripts/upload-ipfs.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "APP_CID=$APP_CID"
        echo "IMAGES_CID=$IMAGES_CID"
        echo "META_CID=$META_CID"
        echo "BASE_URI=ipfs://$META_CID/"
        [ -n "$ROOT_CID" ] && echo "CAR_ROOT_CID=$ROOT_CID"
    } > ipfs-cids.env
    echo "recorded in ipfs-cids.env"
fi

echo
echo "base URI: ipfs://$META_CID/"
echo "set it with:"
echo "  cast send \$PROXY 'setBaseURI(string)' 'ipfs://$META_CID/' --rpc-url \$RPC ..."
