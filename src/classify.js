// THE LINKAGE CLASS, COMPUTED FROM EVIDENCE.
//
// The fleet spent a year saying "tamper-evident" about logs that are not.
// The correction, worked out and swept across six repos, was that the
// strong word needs THREE legs:
//
//   1. RE-DERIVES      -- the chain recomputes from its own bodies
//   2. SIGNED          -- the head carries a signature from a key we trust
//   3. PUBLISHED OOB   -- the head is published somewhere the log writer
//                         does not control
//
// Leg 3 is the one nobody in the fleet holds. So this module does NOT ask
// the publisher what class their chain is. It takes the EVIDENCE and
// computes the class, and it REFUSES the strong word when the evidence
// does not support it.
//
// THE HEADLINE CASE. A Worker deployed to the fleet's OWN Cloudflare
// account is not out of band -- the log writer can push to it. So a head
// published by the same account that wrote the log is SELF-ANCHORED, and
// the class is `attested`, not `tamper-evident`, no matter what the
// publisher says. That single rule is the difference between a vocabulary
// and a slogan.

// The three legs, named the way the fleet's docs name them.
export const LEGS = ['rederives', 'signed', 'outOfBand'];

export const CLASSES = ['tamper-evident', 'attested', 'attestable'];

/**
 * Compute the linkage class of a published chain.
 *
 * @param {object} e
 * @param {boolean} e.rederives        the chain re-derives from its own bodies
 * @param {boolean} e.signed           the head's signature verifies against a trusted key
 * @param {string}  [e.publisherAccount] the account that published the head
 * @param {string}  [e.logAccount]      the account that wrote the log
 * @param {string}  [e.linkage]       'chain' | 'row-checksum' | 'none'
 * @param {string}  [e.claimedClass]  what the publisher CLAIMED, if anything
 * @returns {{legs: object, label: string, why: string, refused: string|null, linkage: string}}
 */
export function classify(e) {
  const linkage = e.linkage || 'none';
  const publisher = e.publisherAccount || null;
  const log = e.logAccount || null;

  const legs = {
    // A ROW-CHECKSUM log is not a chain at all: the rows carry checksums
    // and the linkage is in the row order, so there is nothing to re-derive
    // FROM and nothing to truncate-and-detect. It re-derives its own
    // checksums, which is not the same thing.
    rederives: linkage === 'chain' ? !!e.rederives : false,
    signed: !!e.signed,
    // OUT OF BAND MEANS A DIFFERENT ACCOUNT. Not "a different worker", not
    // "a different bucket", not "a different service on the same
    // account" -- a different ACCOUNT, because the account is the unit
    // of control. If the log writer can push to the anchor, the anchor
    // is not out of band.
    //
    // AND THE EVIDENCE MATTERS. A request that SAYS "my log account is X"
    // is an ASSERTION, and an assertion cannot establish a security
    // property -- the publisher asserting it is not the same as anyone
    // else observing it. So an ASSERTED log account caps the class at
    // `attested`, and says so. Only an OBSERVED account -- one the anchor
    // saw for itself, by a route only that account can use -- can earn
    // `tamper-evident`.
    //
    // This is why the fleet can hold NO tamper-evident log today: nobody
    // has built the second account and the route to it. Saying so is the
    // whole point.
    outOfBand: !!(publisher && log && publisher !== log &&
                  e.logAccountEvidence === 'observed'),
  };

  // The order matters: the strongest word needs the most legs.
  let label = 'attestable';
  if (legs.outOfBand && legs.signed && legs.rederives) label = 'tamper-evident';
  else if (legs.signed && legs.rederives) label = 'attested';

  const missing = LEGS.filter((l) => !legs[l]);
  // An ASSERTED account is a different kind of gap: the leg might be
  // reachable, but nobody has proved it.
  if (e.logAccountEvidence === 'asserted' && publisher && log && publisher !== log) {
    // REPLACE, not push: the leg is missing, and the reason it is missing
    // is that nobody OBSERVED it. Saying "missing outOfBand and
    // outOfBand(observed)" is the same fact said twice.
    const i = missing.indexOf('outOfBand');
    if (i >= 0) missing[i] = 'outOfBand(observed)';
    else missing.push('outOfBand(observed)');
  }
  const why =
    missing.length === 0
      ? 'all three legs hold: the chain re-derives, the head is signed by a trusted key, and the head is published by an account the log writer does not control'
      : `missing ${missing.join(' and ')}`;

  // THE REFUSAL. If the publisher claimed a stronger class than the
  // evidence supports, say so -- out loud, in the response, and stored.
  let refused = null;
  if (e.claimedClass && e.claimedClass !== label) {
    refused =
      `the publisher claimed "${e.claimedClass}" but the evidence supports ` +
      `"${label}" (${why})`;
  }

  // A same-account publication is worth calling out specifically, because
  // it is the mistake everybody makes: the chain looks anchored, and the
  // anchor is in the same hands as the log.
  if (publisher && log && publisher === log) {
    refused = (refused ? refused + '; ' : '') +
      'the head was published by the SAME account that wrote the log, so it is ' +
      'self-anchored, not out of band: the log writer can re-publish it';
  }
  if (e.logAccountEvidence === 'asserted') {
    refused = (refused ? refused + '; ' : '') +
      "the log's account is ASSERTED by the publisher, not OBSERVED by the " +
      'anchor, so no security property can rest on it';
  }

  return { legs, label, why, refused, linkage };
}

// The words a chain may be DESCRIBED as, and which ones are earned.
// Kept next to classify() on purpose: the vocabulary and the mechanism
// live in the same file, so they cannot drift apart silently.
export const ALLOWED_WORDS = new Set([
  'attestable', 'attested', 'tamper-evident',
  // and the plain, non-security words, which are always true
  're-derivable', 'replayable', 'self-consistent', 'checksummed',
]);
