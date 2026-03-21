const INTERVIEW_PATTERNS = [
  /interview/i, /面接/i, /面談.*選考/i, /選考.*面談/i,
  /indeed/i, /hiring/i, /recruiter/i, /recruitment/i,
  /応募/i, /採用.*面/i, /candidate/i, /job\s*application/i,
];

function isInterviewRelated(text) {
  if (!text) return false;
  return INTERVIEW_PATTERNS.some(p => p.test(text));
}

module.exports = { isInterviewRelated };
