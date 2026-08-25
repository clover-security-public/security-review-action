'use strict';

const fs = require('node:fs');

// Minimal replacements for @actions/core so the action ships with zero dependencies.

function getInput(name, { required = false } = {}) {
  const value = (process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();

  if (required && value === '') {
    throw new Error(`Input required and not supplied: ${name}`);
  }

  return value;
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;

  if (!outputFile) {
    return;
  }

  const delimiter = `ghadelimiter_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

// ::error/::warning/::notice payloads must not contain raw line breaks.
function escapeData(message) {
  return String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function info(message) {
  process.stdout.write(`${message}\n`);
}

function notice(message) {
  process.stdout.write(`::notice::${escapeData(message)}\n`);
}

function warning(message) {
  process.stdout.write(`::warning::${escapeData(message)}\n`);
}

function setFailed(message) {
  process.stdout.write(`::error::${escapeData(message)}\n`);
  process.exitCode = 1;
}

module.exports = { getInput, info, notice, setFailed, setOutput, warning };
