#!/usr/bin/env bash
# Grep-based secret scan over the working tree (tracked and untracked, not ignored) AND every commit in the history.
# Used because gitleaks and trufflehog are not installed here. Prints each hit; exit 1 if any hit is not allowlisted.
# Usage: bash scripts/secret-scan.sh
set -u
cd "$(dirname "$0")/.."

# Shapes of real secrets. Test fixtures use obvious fakes, which the allowlist below names explicitly.
PATTERN='nostr\+walletconnect://[0-9a-f]{64}\?[^ "`]*secret=[0-9a-f]{64}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|sk_live_[0-9a-zA-Z]{20,}|xprv[1-9A-HJ-NP-Za-km-z]{100,}|nsec1[02-9ac-hj-np-z]{58}|JAAY_MASTER_KEY=[A-Za-z0-9+/_-]{40,}|JAAY_ENROLL_TOKEN=[^ <"$]{32,}|macaroon[^\n]{0,20}[0-9a-f]{100,}|X-Api-Key: ?[0-9a-f]{32}'
# Known test fixtures and documented placeholders (each was reviewed by hand).
ALLOW='0{64}|1{64}|a{64}|b{64}|c{64}|f{64}|e{32}|deadbeef|<[a-z-]+>|example|EXAMPLE|testkit|\.test\.ts|NOTES\.md|secret-scan\.sh'

hits=0
echo "== working tree (git grep, tracked + untracked, excluding ignored)"
tree=$(git grep -nIE --untracked "$PATTERN" -- . ':!pnpm-lock.yaml' | grep -vE "$ALLOW")
[ -n "$tree" ] && { echo "$tree"; hits=1; } || echo "no hits"

echo "== full history (git log -p --all)"
hist=$(git log -p --all --no-color | grep -nE "$PATTERN" | grep -vE "$ALLOW")
[ -n "$hist" ] && { echo "$hist" | head -50; hits=1; } || echo "no hits"

echo "== secret-bearing file names ever committed (.env, *.macaroon, *.key, *.pem, *.sqlite, master key)"
files=$(git log --all --name-only --pretty=format: | sort -u | grep -E '(^|/)\.env($|\.)|\.macaroon$|\.pem$|\.key$|\.p12$|\.sqlite3?$|\.db$|master\.key' | grep -vE '\.env\.example$')
[ -n "$files" ] && { echo "$files"; hits=1; } || echo "none"

exit $hits
