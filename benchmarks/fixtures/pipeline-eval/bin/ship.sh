#!/bin/sh
# Ship the current version: dispatches the docs-and-package release workflow.
set -e
gh workflow run ship-docs.yml --ref main -f version="$(node -p "require('./package.json').version")"
