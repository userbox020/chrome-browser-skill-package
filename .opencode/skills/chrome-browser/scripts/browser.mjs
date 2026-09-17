#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { main, reportError } from '../src/cli.mjs';

main(process.argv.slice(2), fileURLToPath(import.meta.url)).catch(error => reportError(error, process.argv.slice(2)));
