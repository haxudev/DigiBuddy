#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import {
  applyProfileTransaction, approveProfileProposal, proposeProfileChange, recoverProfileLock,
  proposeProfileInitialization, rejectProfileProposal, rollbackProfileTransaction, verifyDeliveredSource,
} from './profile-transaction.mjs';

const [command, inputFile] = process.argv.slice(2);
if (!command || !inputFile) {
  console.error('usage: profile-transaction-cli.mjs <verify-source|initialize|propose|approve|reject|apply|rollback|recover-lock> <input.json>');
  process.exit(1);
}

const input = JSON.parse(readFileSync(inputFile, 'utf8'));
const commands = {
  'verify-source': verifyDeliveredSource,
  initialize: proposeProfileInitialization,
  propose: proposeProfileChange,
  approve: approveProfileProposal,
  reject: rejectProfileProposal,
  apply: applyProfileTransaction,
  rollback: rollbackProfileTransaction,
  'recover-lock': recoverProfileLock,
};
if (!commands[command]) throw new Error(`unknown command: ${command}`);
const result = commands[command](input);
process.stdout.write(`${JSON.stringify(result ?? { ok: true })}\n`);
