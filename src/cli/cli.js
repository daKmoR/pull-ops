#!/usr/bin/env node

import { PullOpsCli } from './PullOpsCli.js';

const cli = new PullOpsCli();
await cli.start();
