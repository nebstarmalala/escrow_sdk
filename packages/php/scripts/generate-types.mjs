// Generates src/Types.php - PHPStan array shapes for every schema in the spec.
//
// Why not openapi-generator, which the TypeScript side's equivalent uses?
//
// Its PHP models are not self-contained: they extend ModelInterface and call
// into an ObjectSerializer that only exists if you also generate the whole
// client, which is exactly the unidiomatic bag of *Api classes this package
// exists instead of. Generating "just the models" produces files that do not
// autoload. It also needs a Java toolchain to run, which a PHP contributor
// should not have to install to change a comment.
//
// So the generated artefact here is types rather than classes. The API is
// arrays - which is what a PHP integrator expects, and what json_decode gives
// them anyway - and PHPStan checks those arrays against shapes derived from the
// same frozen spec the TypeScript types come from. Level 8 then catches a typo
// in an array key exactly as it would catch a typo in a property name.
//
// Run from packages/php:  node scripts/generate-types.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(here, '../../../shared/partner-openapi.yaml');
const outPath = resolve(here, '../src/Types.php');

const spec = yaml.load(readFileSync(specPath, 'utf8'));
const schemas = spec.components.schemas;

/** OpenAPI type -> PHPStan type. */
function phpType(schema, depth = 0) {
  if (schema === undefined || schema === null) return 'mixed';

  if (schema.$ref !== undefined) {
    return schema.$ref.replace('#/components/schemas/', '');
  }

  if (schema.allOf !== undefined) {
    // Only used for the list envelopes, which merge a base into a data array.
    // Flattened rather than intersected, because PHPStan intersections of array
    // shapes are harder to read in an error message than the merged shape.
    const merged = { type: 'object', properties: {}, required: [] };
    for (const part of schema.allOf) {
      const resolved = part.$ref !== undefined ? schemas[part.$ref.split('/').pop()] : part;
      Object.assign(merged.properties, resolved.properties ?? {});
      merged.required.push(...(resolved.required ?? []));
    }
    return phpType(merged, depth);
  }

  const nullable = schema.nullable === true;
  let base;

  switch (schema.type) {
    case 'string':
      // An enum becomes a union of literals, so a typo in a status string is a
      // static error rather than a filter that silently matches nothing.
      base =
        Array.isArray(schema.enum) && schema.enum.length > 0
          ? schema.enum.map((v) => `'${v}'`).join('|')
          : 'string';
      break;
    case 'integer':
      base = 'int';
      break;
    case 'number':
      base = 'float';
      break;
    case 'boolean':
      base = 'bool';
      break;
    case 'array':
      base = `list<${phpType(schema.items, depth + 1)}>`;
      break;
    case 'object':
    case undefined:
      base = objectShape(schema, depth);
      break;
    default:
      base = 'mixed';
  }

  return nullable ? `${base}|null` : base;
}

function objectShape(schema, depth) {
  const props = schema.properties;
  if (props === undefined || Object.keys(props).length === 0) {
    return 'array<string, mixed>';
  }

  const required = new Set(schema.required ?? []);
  const indent = '  '.repeat(depth + 2);
  const closeIndent = '  '.repeat(depth + 1);

  const lines = Object.entries(props).map(([name, sub]) => {
    // PHPStan spells an optional key `name?:`. That distinction is the whole
    // value of generating this: it is the difference between a field the API
    // always sends and one a merchant must null-check.
    const key = required.has(name) ? name : `${name}?`;
    return `${indent}${key}: ${phpType(sub, depth + 1)},`;
  });

  return `array{\n${lines.join('\n')}\n${closeIndent}}`;
}

const order = Object.keys(schemas);
const aliases = order.map((name) => {
  const shape = phpType(schemas[name], 0);
  const body = shape
    .split('\n')
    .map((line, i) => (i === 0 ? line : ` * ${line}`))
    .join('\n');
  return ` * @phpstan-type ${name} ${body}`;
});

// The event catalog and error codes, emitted as real constants rather than
// only as types: a merchant switching on an event type wants a constant they
// can reference, and a typo in a string literal is not something PHPStan can
// catch inside a match arm.
const eventTypes = schemas.WebhookEventType?.enum ?? [];
const errorCodes = schemas.Error?.properties?.error?.properties?.code?.enum ?? [];
const statuses = schemas.TransactionStatus?.enum ?? [];

const constBlock = (name, values) =>
  `    public const ${name} = [\n${values.map((v) => `        '${v}',`).join('\n')}\n    ];`;

const php = `<?php

declare(strict_types=1);

namespace Aminitrust\\Escrow;

/**
 * GENERATED FROM shared/partner-openapi.yaml - DO NOT EDIT BY HAND.
 *
 * Regenerate with:  node scripts/generate-types.mjs
 *
 * These are PHPStan shapes, not classes. The API surface is arrays, which is
 * what json_decode produces and what a PHP integrator expects; the shapes are
 * what make those arrays checkable at level 8, so a mistyped key is a static
 * error rather than a null at runtime.
 *
 * Spec version ${spec.info.version}.
 *
${aliases.join('\n *\n')}
 */
final class Types
{
    /** The API version these shapes were generated from. */
    public const API_VERSION = '${spec.info.version}';

${constBlock('EVENT_TYPES', eventTypes)}

${constBlock('ERROR_CODES', errorCodes)}

${constBlock('TRANSACTION_STATUSES', statuses)}

    private function __construct()
    {
    }
}
`;

writeFileSync(outPath, php.replace(/\r\n/g, '\n'), 'utf8');
console.log(`wrote ${outPath} (${order.length} shapes, ${eventTypes.length} event types)`);
