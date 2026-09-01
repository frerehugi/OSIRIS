#!/usr/bin/env bash
# Quick Squid /token-price lookup for a Celo Mainnet token — reads
# SQUID_INTEGRATOR_ID from this directory's .env automatically instead of
# requiring it typed in each time. Uses `node` to parse the JSON response
# instead of `jq`, since node is already a required part of this project's
# toolchain and jq is not guaranteed to be installed (e.g. plain Git Bash).
#
# Usage:
#   ./price.sh 0x471EcE3750Da237f93B8E339c536989b8978a438        (raw address)
#   ./price.sh CELO                                              (known symbol)
#
# Run from the keeper/ directory (or anywhere — it locates its own .env by
# script path, not by current working directory).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found." >&2
  exit 1
fi

SQUID_ID=$(grep '^SQUID_INTEGRATOR_ID=' "$ENV_FILE" | cut -d '=' -f2-)
if [ -z "$SQUID_ID" ] || [ "$SQUID_ID" = "PENDING" ]; then
  echo "Error: SQUID_INTEGRATOR_ID is missing or still 'PENDING' in $ENV_FILE." >&2
  exit 1
fi

INPUT="${1:?Usage: ./price.sh <token-address-or-symbol>}"

# A few known Celo Mainnet addresses from src/config.ts, so common lookups
# don't require pasting a raw address — extend this list as needed.
case "${INPUT^^}" in
  CELO) TOKEN="0x471EcE3750Da237f93B8E339c536989b8978a438" ;;
  USDC) TOKEN="0xcebA9300f2b948710d2653dD7B07f33A8B32118C" ;;
  USDT) TOKEN="0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" ;;
  WETH) TOKEN="0xD221812de1BD094f35587EE8E174B07B6167D9Af" ;;
  WBTC) TOKEN="0x8aC2901Dd8A1F17a1A4768A6bA4C3751e3995B2D" ;;
  *)    TOKEN="$INPUT" ;;
esac

RESPONSE=$(curl -s "https://apiplus.squidrouter.com/v2/token-price?chainId=42220&tokenAddress=$TOKEN" \
  -H "x-integrator-id: $SQUID_ID")

node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const price = data.token && data.token.usdPrice;
  if (typeof price !== "number") {
    console.error("Unexpected response:", JSON.stringify(data));
    process.exit(1);
  }
  console.log("$" + price);
' <<< "$RESPONSE"
