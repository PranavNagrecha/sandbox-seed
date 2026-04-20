#!/usr/bin/env node
// Dev runner: runs compiled dist/ output. Build first with `npm run build`.
import { execute } from "@oclif/core";

await execute({ dir: import.meta.url, development: true });
