/**
 * @typedef {import('./types.js').FieldSpec} FieldSpec
 * @typedef {import('./types.js').OperationOutputContract} OperationOutputContract
 * @typedef {import('./types.js').InvalidOperationOutput} InvalidOperationOutput
 * @typedef {import('./types.js').OperationOutputValidationResult} OperationOutputValidationResult
 * @typedef {import('./types.js').ParsedOperationOutputResult} ParsedOperationOutputResult
 * @typedef {import('./types.js').FieldValidationResult} FieldValidationResult
 */

/**
 * @param {unknown} input
 * @param {OperationOutputContract} [contract]
 * @returns {OperationOutputValidationResult}
 */
export function validateOperationOutput(input, contract = {}) {
  const parsed = parseOperationOutput(input);
  if (!parsed.valid) {
    return parsed;
  }

  if (!isPlainObject(parsed.value)) {
    return invalid('Operation Output must be a JSON object.');
  }

  return validateContract(parsed.value, contract);
}

/**
 * @param {unknown} input
 * @returns {ParsedOperationOutputResult}
 */
function parseOperationOutput(input) {
  if (typeof input !== 'string') {
    return { valid: true, value: input };
  }

  try {
    return { valid: true, value: JSON.parse(input) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalid(`Operation Output must be valid JSON: ${message}`);
  }
}

/**
 * @param {Record<string, unknown>} value
 * @param {OperationOutputContract} contract
 * @returns {OperationOutputValidationResult}
 */
function validateContract(value, contract) {
  const required = contract.required ?? {};

  for (const [field, spec] of Object.entries(required)) {
    if (!(field in value)) {
      return invalid(`Operation Output.${field} is required.`);
    }

    const result = validateSpec(value[field], `Operation Output.${field}`, spec);
    if (!result.valid) {
      return result;
    }
  }

  return { valid: true, value };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {FieldSpec} spec
 * @returns {FieldValidationResult}
 */
function validateSpec(value, path, spec) {
  if (Array.isArray(spec)) {
    if (!spec.includes(value)) {
      return invalid(
        `${path} must be one of: ${spec.map(item => JSON.stringify(item)).join(', ')}.`,
      );
    }
    return { valid: true };
  }

  if (typeof spec === 'string') {
    if (spec === 'array') {
      if (!Array.isArray(value)) {
        return invalid(`${path} must be an array.`);
      }
      return { valid: true };
    }

    if (typeof value !== spec) {
      return invalid(`${path} must be a ${spec}.`);
    }
    return { valid: true };
  }

  if (isPlainObject(spec)) {
    if (spec.type !== undefined) {
      return validateSpec(value, path, spec.type);
    }
  }

  return invalid(`${path} has an unsupported validation contract.`);
}

/**
 * @param {string} reason
 * @returns {InvalidOperationOutput}
 */
function invalid(reason) {
  return { valid: false, reason };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
