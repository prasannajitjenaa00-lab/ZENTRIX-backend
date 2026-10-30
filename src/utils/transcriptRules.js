'use strict';

const NUM_MAP = {
  '0': 'Zero', '1': 'One', '2': 'Two', '3': 'Three', '4': 'Four',
  '5': 'Five', '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Nine',
  '10': 'Ten', '11': 'Eleven', '12': 'Twelve', '13': 'Thirteen',
  '14': 'Fourteen', '15': 'Fifteen', '16': 'Sixteen', '17': 'Seventeen',
  '18': 'Eighteen', '19': 'Nineteen', '20': 'Twenty',
  '30': 'Thirty', '40': 'Forty', '50': 'Fifty', '60': 'Sixty',
  '70': 'Seventy', '80': 'Eighty', '90': 'Ninety', '100': 'Hundred',
  '1000': 'Thousand', '1000000': 'Million',
};

function numberToWords(numStr) {
  const n = parseInt(numStr, 10);
  if (isNaN(n)) return numStr;
  if (NUM_MAP[String(n)]) return NUM_MAP[String(n)];
  if (n < 100) {
    const tens = Math.floor(n / 10) * 10;
    const ones = n % 10;
    return `${NUM_MAP[String(tens)] || ''} ${NUM_MAP[String(ones)] || ''}`.trim();
  }
  return numStr.split('').map((d) => NUM_MAP[d] || d).join(' ');
}

// Broad dictionary of valid English and transcription vocabulary
const DICTIONARY = new Set([
  // Special rule keywords
  'at', 'the', 'rate', 'hassh', 'comma', 'zero', 'one', 'two', 'three', 'four',
  'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
  'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred',
  'thousand', 'million', 'billion', 'trillion', 'first', 'second', 'third',

  // Common pronouns, prepositions, articles, conjunctions
  'a', 'an', 'and', 'as', 'by', 'for', 'from', 'in', 'into', 'of', 'off', 'on',
  'onto', 'or', 'out', 'over', 'to', 'up', 'with', 'within', 'without', 'about',
  'above', 'across', 'after', 'against', 'along', 'among', 'around', 'before',
  'behind', 'below', 'beneath', 'beside', 'between', 'beyond', 'during', 'except',
  'inside', 'near', 'outside', 'since', 'through', 'throughout', 'toward', 'towards',
  'under', 'underneath', 'until', 'upon', 'via',
  'i', 'me', 'my', 'mine', 'myself', 'you', 'your', 'yours', 'yourself', 'he',
  'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself',
  'we', 'us', 'our', 'ours', 'ourselves', 'they', 'them', 'their', 'theirs',
  'themselves', 'what', 'which', 'who', 'whom', 'whose', 'this', 'that', 'these',
  'those', 'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have',
  'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'will', 'would', 'shall',
  'should', 'can', 'could', 'may', 'might', 'must',

  // Common speech & transcription words
  'yes', 'no', 'not', 'okay', 'ok', 'yeah', 'yep', 'nope', 'hello', 'hi',
  'hey', 'good', 'morning', 'afternoon', 'evening', 'night', 'bye', 'goodbye',
  'please', 'thank', 'thanks', 'welcome', 'sorry', 'excuse', 'pardon',
  'name', 'call', 'called', 'calling', 'speak', 'speaking', 'spoke', 'listen',
  'listening', 'talk', 'talking', 'hear', 'hearing', 'heard', 'say', 'said',
  'saying', 'tell', 'told', 'telling', 'ask', 'asked', 'asking', 'answer',
  'answered', 'help', 'helping', 'support', 'service', 'customer', 'agent',
  'representative', 'client', 'company', 'office', 'work', 'working', 'job',
  'team', 'leader', 'manager', 'employee', 'staff', 'department', 'project',
  'task', 'audio', 'sound', 'file', 'track', 'record', 'recording', 'note',
  'notebook', 'text', 'transcribe', 'transcription', 'write', 'writing', 'written',
  'read', 'reading', 'time', 'day', 'week', 'month', 'year', 'today', 'tomorrow',
  'yesterday', 'now', 'then', 'here', 'there', 'where', 'when', 'why', 'how',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'also', 'again',
  'further', 'once', 'always', 'never', 'sometimes', 'usually', 'often',
  'account', 'number', 'code', 'card', 'payment', 'money', 'dollar', 'dollars',
  'cent', 'cents', 'rupee', 'rupees', 'address', 'city', 'state', 'country',
  'street', 'road', 'place', 'house', 'building', 'floor', 'room', 'email',
  'phone', 'mobile', 'website', 'online', 'system', 'device', 'computer',
  'screen', 'keyboard', 'mouse', 'portal', 'app', 'application', 'password',
  'username', 'id', 'login', 'logout', 'sign', 'date', 'month', 'year',
  'start', 'stop', 'begin', 'end', 'pause', 'play', 'resume', 'continue',
  'finish', 'complete', 'completed', 'done', 'check', 'verify', 'confirm',
  'information', 'detail', 'details', 'problem', 'issue', 'solve', 'solution',
  'status', 'progress', 'pending', 'approved', 'review', 'revision', 'submit',
  'submitted', 'great', 'fine', 'well', 'sure', 'true', 'right', 'correct',
  'wrong', 'false', 'accurate', 'clear', 'loud', 'quiet', 'fast', 'slow',
  'high', 'low', 'big', 'small', 'large', 'little', 'long', 'short',
  'zentrix', 'pulse',
]);

/**
 * Validates text against all 6 transcription rules:
 * Rule 1: Every Word's First Letter Must Be In Capital Letter.
 * Rule 2: There should be space between two words. (Single space, no consecutive spaces).
 * Rule 3: All numbers or some symbols should be written in words. (1 = One, , = Comma).
 * Rule 4: All mathematical symbols will be written in symbol form only (+, -, *, /, %).
 * Rule 5: There should be no spelling mistake.
 * Rule 6: @ = At The Rate, # = Hassh.
 */
function validateTranscriptRules(text) {
  const failures = [];
  const trimmed = (text || '').trim();

  if (!trimmed) {
    return {
      passed: false,
      failures: ['Transcription is empty. Please enter your transcription.'],
      feedback: 'Pending: Transcription text is empty.',
    };
  }

  // ---- Rule 2: There should be space between two words (no double/multiple spaces) ----
  if (/[ \t]{2,}/.test(trimmed)) {
    failures.push('Rule 2: There must be a single space between two words (found multiple spaces).');
  }

  // ---- Rule 3: All numbers must be written in words (1 = One) & Commas in words (, = Comma) ----
  if (/\d/.test(trimmed)) {
    failures.push('Rule 3: All numbers must be written in words (e.g., 1 = One). Numbers in digit form are not allowed.');
  }
  if (/,/.test(trimmed)) {
    failures.push("Rule 3: Commas must be written in words as 'Comma'. Literal ',' is not allowed.");
  }

  // ---- Rule 4: All mathematical symbols will be written in symbol form only (+, -, *, /, %) ----
  // Words like 'Plus', 'Minus', etc. representing math symbols are not allowed in word form.
  const mathWordMatch = trimmed.match(/\b(Plus|Minus|Multiplied By|Multiply|Divided By|Divide|Percentage|Percent)\b/i);
  if (mathWordMatch) {
    failures.push(`Rule 4: Mathematical symbols must be written in symbol form only (+, -, *, /, %). Found word '${mathWordMatch[0]}'.`);
  }

  // ---- Rule 6: @ = At The Rate, # = Hassh ----
  if (/@/.test(trimmed)) {
    failures.push("Rule 6: '@' symbol must be written in words as 'At The Rate'.");
  }
  if (/#/.test(trimmed)) {
    failures.push("Rule 6: '#' symbol must be written in words as 'Hassh'.");
  }

  // Split into individual words
  const words = trimmed.split(/\s+/).filter(Boolean);

  // ---- Rule 1: Every Word's First Letter Must Be In Capital Letter ----
  const failedCapitalWords = [];
  for (const w of words) {
    const clean = w.replace(/^[^\w+*/%-]+/, '');
    if (clean.length > 0 && /[a-zA-Z]/.test(clean[0])) {
      if (clean[0] !== clean[0].toUpperCase()) {
        failedCapitalWords.push(w);
      }
    }
  }
  if (failedCapitalWords.length > 0) {
    const sample = failedCapitalWords.slice(0, 3).join(', ');
    failures.push(`Rule 1: Every word's first letter must be a capital letter (Failed on: ${sample}${failedCapitalWords.length > 3 ? '...' : ''}).`);
  }

  // ---- Rule 5: There should be no spelling mistake ----
  const failedSpellingWords = [];
  for (const w of words) {
    // Strip leading and trailing punctuation (except math symbols)
    const clean = w.replace(/^[^\w]+|[^\w]+$/g, '');
    if (!clean) continue;

    // Check 1: 3 or more of the same letter in a row (e.g., 'heeeello', 'soooo')
    if (/(.)\1{2,}/i.test(clean)) {
      failedSpellingWords.push(w);
      continue;
    }

    // Check 2: Mixed-case errors inside the word (e.g., 'HeLLo', 'wOrD')
    if (clean.length > 2 && /[A-Z]/.test(clean[0]) && /[a-z]/.test(clean)) {
      const rest = clean.slice(1);
      if (/[A-Z]/.test(rest)) {
        failedSpellingWords.push(w);
        continue;
      }
    }

    // Check 3: Check purely alphabetic words against vocabulary if long enough
    const lower = clean.toLowerCase();
    if (/^[a-z]{3,}$/.test(lower)) {
      // Must have at least one vowel
      if (!/[aeiouy]/.test(lower)) {
        failedSpellingWords.push(w);
        continue;
      }
      // If recognized in dictionary or common word structure
      if (!DICTIONARY.has(lower) && !isCommonValidWord(lower)) {
        failedSpellingWords.push(w);
      }
    }
  }

  if (failedSpellingWords.length > 0) {
    const sample = failedSpellingWords.slice(0, 3).join(', ');
    failures.push(`Rule 5: There should be no spelling mistakes (Suspected words: ${sample}${failedSpellingWords.length > 3 ? '...' : ''}).`);
  }

  const passed = failures.length === 0;
  return {
    passed,
    failures,
    feedback: passed
      ? 'Auto-approved: All transcription rules passed successfully.'
      : `Pending: ${failures.join(' ')}`,
  };
}

/** Helper heuristic for valid English word structures */
function isCommonValidWord(lower) {
  // Allow common suffixes: ing, ed, er, est, ly, tion, sion, ness, ment, ful, less, able, ible, s, es
  const suffixes = ['ing', 'ed', 'er', 'est', 'ly', 'tion', 'sion', 'ness', 'ment', 'ful', 'less', 'able', 'ible', 's', 'es'];
  for (const suf of suffixes) {
    if (lower.endsWith(suf)) {
      const stem = lower.slice(0, -suf.length);
      if (DICTIONARY.has(stem) || DICTIONARY.has(stem + 'e')) return true;
    }
  }
  // Allow common prefixes: un, re, in, im, dis, non, pre, post, over, under
  const prefixes = ['un', 're', 'in', 'im', 'dis', 'non', 'pre', 'post', 'over', 'under'];
  for (const pre of prefixes) {
    if (lower.startsWith(pre)) {
      const stem = lower.slice(pre.length);
      if (DICTIONARY.has(stem)) return true;
    }
  }
  // Basic plausibility: valid vowel/consonant distribution
  if (/^[a-z]+$/.test(lower) && lower.length <= 15 && /[aeiouy]/.test(lower)) {
    // No impossible 5-consonant clusters
    if (!/[^aeiouy]{5,}/.test(lower)) return true;
  }
  return false;
}

/** Formats a string to automatically satisfy transcription rules */
function formatToTranscriptRules(str) {
  if (!str) return '';
  let res = str;

  // Rule 6: @ = At The Rate, # = Hassh
  res = res.replace(/@/g, ' At The Rate ');
  res = res.replace(/#/g, ' Hassh ');

  // Rule 3: , = Comma
  res = res.replace(/,/g, ' Comma ');

  // Rule 4: Mathematical symbols written in symbol form only (+, -, *, /, %)
  res = res.replace(/\bplus\b/gi, '+');
  res = res.replace(/\bminus\b/gi, '-');
  res = res.replace(/\b(multiplied\s+by|multiply)\b/gi, '*');
  res = res.replace(/\b(divided\s+by|divide)\b/gi, '/');
  res = res.replace(/\b(percentage|percent)\b/gi, '%');

  // Rule 3: Numbers to words (e.g. 1 = One)
  res = res.replace(/\b\d+\b/g, (match) => numberToWords(match));
  res = res.replace(/\d/g, (d) => NUM_MAP[d] || d);

  // Rule 2: Single space between words
  res = res.replace(/[ \t]+/g, ' ');

  // Rule 1: Every Word's First Letter Must Be In Capital Letter
  res = res.replace(/(^|[\s\n\r])([a-z])/g, (_, space, char) => space + char.toUpperCase());

  return res.trim();
}

module.exports = {
  validateTranscriptRules,
  formatToTranscriptRules,
  numberToWords,
};
