#!/usr/bin/env bash
# Upload data/seed/ to the demo bucket. Only Vi runs this (team rules, Rule 5).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
"$( [ -x .venv/bin/python ] && echo .venv/bin/python || echo python3 )" scripts/validate_seed.py
aws s3 sync data/seed/ "s3://${BUCKET:-lumen-2e6e7e}/seed/" --region "${AWS_REGION:-us-east-2}"
