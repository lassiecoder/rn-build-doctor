#!/usr/bin/env node
import { main } from "./index.js";

main().then((code) => {
  process.exitCode = code;
});
