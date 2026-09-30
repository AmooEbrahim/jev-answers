import { ErrorType, JevAnswersError } from './errors.js';

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const TYPES = ['noul', 'choice', 'score'];
const ALLOWED_FIELDS = new Set(['type', 'instructions', 'criteria']);
const MAX_CHOICE_OPTIONS = 255;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
// Jev accepts structured values (objects/arrays) wherever it accepts text.
const isValue = (v) => isText(v) || (v !== null && typeof v === 'object');

function invalid(id, message) {
  return new JevAnswersError(ErrorType.INVALID_QUESTION, id ? `Question "${id}": ${message}` : message, id ? { question: id } : undefined);
}

function checkCriteria(id, question) {
  const { type, criteria } = question;
  if (type === 'noul') {
    if (criteria === undefined) return;
    const keys = isPlainObject(criteria) ? Object.keys(criteria).sort() : [];
    if (keys.join() !== 'false,true' || !isValue(criteria.true) || !isValue(criteria.false)) {
      throw invalid(id, 'noul "criteria" is optional, but if given it must be {"true": "...", "false": "..."} with non-null values.');
    }
  } else if (type === 'choice') {
    const options = isPlainObject(criteria) ? Object.entries(criteria) : [];
    if (options.length < 2 || options.length > MAX_CHOICE_OPTIONS) {
      throw invalid(id, `choice "criteria" must be an object of 2 to ${MAX_CHOICE_OPTIONS} options (option name -> description).`);
    }
    for (const [option, description] of options) {
      if (!option.trim() || !(description === null || isValue(description))) {
        throw invalid(id, `choice option "${option}" needs a non-empty name and a string, object, array or null description.`);
      }
    }
  } else if (!Array.isArray(criteria) || criteria.length < 2 || !criteria.every(isValue)) {
    throw invalid(id, 'score "criteria" must be an array of at least 2 non-empty level descriptions, lowest level first.');
  }
}

/** Validate the `questions` argument; returns it unchanged. */
export function validateQuestions(questions) {
  if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
    throw invalid(null, '"questions" must be a non-empty object keyed by question id.');
  }
  for (const [id, question] of Object.entries(questions)) {
    if (!ID_PATTERN.test(id)) throw invalid(null, `Invalid question id "${id}": use 1-64 characters from A-Z a-z 0-9 _ . -`);
    if (!isPlainObject(question)) throw invalid(id, 'must be an object.');
    const unknown = Object.keys(question).filter((key) => !ALLOWED_FIELDS.has(key));
    if (unknown.length) throw invalid(id, `unknown field(s): ${unknown.join(', ')}. Allowed: type, instructions, criteria.`);
    if (!TYPES.includes(question.type)) throw invalid(id, `"type" must be one of ${TYPES.join(', ')}.`);
    if (!isValue(question.instructions)) throw invalid(id, '"instructions" must be a non-empty string (or a non-null object/array).');
    checkCriteria(id, question);
  }
  return questions;
}
