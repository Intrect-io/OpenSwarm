#!/bin/sh
exec /usr/local/bin/npm test -- src/adapters/codexResponses.test.ts src/tui/sanitize.test.ts --reporter=verbose
