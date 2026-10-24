#!/usr/bin/env bash
# Deploy backend/ to the lumen-api Lambda. Runs only from a clean main that matches origin/main.
# Needs: AWS CLI credentials for the team account, and DEMO_KEY set in the shell.
set -euo pipefail

FUNCTION=lumen-api
export AWS_REGION="${AWS_REGION:-us-east-2}"
cd "$(git rev-parse --show-toplevel)"

fail() { echo "deploy refused: $1" >&2; exit 1; }

: "${DEMO_KEY:?set DEMO_KEY first (the demo key from Discord)}"
git fetch -q origin main
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || fail "you are on $(git rev-parse --abbrev-ref HEAD), not main"
[ -z "$(git status --porcelain)" ] || fail "your working tree has uncommitted changes"
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "local main does not match origin/main (run git pull)"

SHA="$(git rev-parse --short HEAD)"
rm -rf build/lambda build/lambda.zip
mkdir -p build/lambda
cp backend/lambda_function.py build/lambda/
cp -R backend/lumen build/lambda/
find build/lambda -name __pycache__ -prune -exec rm -rf {} +
echo "VERSION = \"$SHA\"" > build/lambda/lumen/_version.py
(cd build/lambda && zip -qr ../lambda.zip .)

echo "deploying $SHA to $FUNCTION in $AWS_REGION"
aws lambda update-function-code --function-name "$FUNCTION" --zip-file fileb://build/lambda.zip --query CodeSha256 --output text
aws lambda wait function-updated --function-name "$FUNCTION"

URL="$(aws lambda get-function-url-config --function-name "$FUNCTION" --query FunctionUrl --output text)"
BODY="$(curl -s -m 60 -H "x-demo-key: $DEMO_KEY" "${URL}state")"
echo "GET /state version: $(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("version", "(none yet)"))' "$BODY")"
