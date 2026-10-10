#!/usr/bin/env bash
# Encrypt / decrypt the test fixtures. They contain real hidden tests and a fully correct notebook,
# so only the encrypted archive (fixtures.tar.gz.enc) is committed; fixtures/ itself is gitignored.
#
#   scripts/fixtures.sh decrypt    # before running tests on a fresh clone
#   scripts/fixtures.sh encrypt    # after changing anything in fixtures/
#
# The password comes from $FIXTURES_PASSWORD, or from FIXTURES_PASSWORD=... in the repo's .env file.
# In GitHub Actions it is the repository secret FIXTURES_PASSWORD.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE="$REPO_ROOT/fixtures.tar.gz.enc"
OPENSSL_ARGS=(-aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:FIXTURES_PASSWORD)

if [[ -z "${FIXTURES_PASSWORD:-}" && -f "$REPO_ROOT/.env" ]]; then
  FIXTURES_PASSWORD="$(sed -n 's/^FIXTURES_PASSWORD=//p' "$REPO_ROOT/.env" | head -n 1)"
fi
if [[ -z "${FIXTURES_PASSWORD:-}" ]]; then
  echo "FIXTURES_PASSWORD is not set (export it, or put FIXTURES_PASSWORD=... in $REPO_ROOT/.env)." >&2
  exit 1
fi
export FIXTURES_PASSWORD

case "${1:-}" in
  encrypt)
    [[ -d "$REPO_ROOT/fixtures" ]] || { echo "Nothing to encrypt: $REPO_ROOT/fixtures does not exist." >&2; exit 1; }
    tar -czf - -C "$REPO_ROOT" --exclude='*:Zone.Identifier' fixtures | openssl enc "${OPENSSL_ARGS[@]}" -out "$ARCHIVE"
    echo "Wrote $ARCHIVE"
    ;;
  decrypt)
    [[ -f "$ARCHIVE" ]] || { echo "Missing $ARCHIVE." >&2; exit 1; }
    plain="$(mktemp)"
    trap 'rm -f "$plain"' EXIT
    # Decrypt fully before touching fixtures/, so a wrong password never leaves a half-extracted folder.
    if ! openssl enc -d "${OPENSSL_ARGS[@]}" -in "$ARCHIVE" -out "$plain" 2>/dev/null || ! gzip -t "$plain" 2>/dev/null; then
      echo "Could not decrypt $ARCHIVE: wrong FIXTURES_PASSWORD?" >&2
      exit 1
    fi
    tar -xzf "$plain" -C "$REPO_ROOT"
    echo "Restored $REPO_ROOT/fixtures"
    ;;
  *)
    echo "Usage: $0 encrypt|decrypt" >&2
    exit 2
    ;;
esac
