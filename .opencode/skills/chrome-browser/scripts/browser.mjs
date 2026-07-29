#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { main, UsageError } from '../src/cli.mjs';

main(process.argv.slice(2), fileURLToPath(import.meta.url)).catch(error => {
  if (error.json) console.error(JSON.stringify({ ok: false, error: { code: error.code, message: error.message, details: error.details } }, null, 2));
  else {
    console.error(error instanceof UsageError ? `Usage error: ${error.message}` : `Error${error.code ? ` [${error.code}]` : ''}: ${error.message}`);
    if (error.details) console.error(`Details: ${JSON.stringify(error.details)}`);
  }
  process.exit(1);
});
