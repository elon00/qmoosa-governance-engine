import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  GovernanceEngine,
  ProposalState,
  VoteType
} from '../dist/index.js';

const GUARDIAN = '0x8888888888888888888888888888888888888888';
const PROPOSER = '0x1111111111111111111111111111111111111111';
const VOTER1 = '0x2222222222222222222222222222222222222222';
const VOTER2 = '0x3333333333333333333333333333333333333333';
const ATTACKER = '0x9999999999999999999999999999999999999999';

function signProposeIntent(proposer, description) {
  return createHash('sha256').update(`${proposer}:PROPOSE:${description}`).digest('hex');
}

function signVoteIntent(voter, proposalId, support) {
  return createHash('sha256').update(`${voter}:VOTE:${proposalId}:${support}`).digest('hex');
}

test('Governance Engine: Full Lifecycle from Propose to Execution', () => {
  const engine = new GovernanceEngine({
    votingDelay: 1,
    votingPeriod: 10,
    proposalThreshold: 100_000n * 10n ** 18n,
    timelockDelay: 86400,
    guardianAddress: GUARDIAN
  });

  const totalSupply = 10_000_000n * 10n ** 18n;
  engine.recordTotalSupply(1, totalSupply);
  engine.recordVotingPower(PROPOSER, 1, 500_000n * 10n ** 18n); // 500k > 100k
  engine.recordVotingPower(VOTER1, 1, 1_000_000n * 10n ** 18n); // 1M > 4% quorum (400k)
  engine.recordVotingPower(VOTER2, 1, 200_000n * 10n ** 18n);

  let block = 10;
  let time = 1000;

  // Step 1: Create proposal
  const sig = signProposeIntent(PROPOSER, 'Upgrade Core Logic');
  const proposalId = engine.createProposal({
    proposer: PROPOSER,
    description: 'Upgrade Core Logic',
    actions: [{ target: '0xTarget', value: 0n, signature: 'execute()', calldata: '0x' }],
    currentBlock: block,
    currentTime: time,
    signature: sig
  });

  assert.equal(proposalId, '1');
  assert.equal(engine.getProposalState(proposalId, block, time), ProposalState.Pending);

  // Step 2: Advance past voting delay (startBlock = 11)
  block = 12;
  assert.equal(engine.getProposalState(proposalId, block, time), ProposalState.Active);

  // Step 3: Cast votes with signed intents
  const voteSig1 = signVoteIntent(VOTER1, proposalId, VoteType.For);
  const weight1 = engine.castVote({
    voter: VOTER1,
    proposalId,
    support: VoteType.For,
    currentBlock: block,
    currentTime: time,
    reason: 'Approved by community',
    signature: voteSig1
  });
  assert.equal(weight1, 1_000_000n * 10n ** 18n);

  const voteSig2 = signVoteIntent(VOTER2, proposalId, VoteType.Against);
  const weight2 = engine.castVote({
    voter: VOTER2,
    proposalId,
    support: VoteType.Against,
    currentBlock: block,
    currentTime: time,
    signature: voteSig2
  });
  assert.equal(weight2, 200_000n * 10n ** 18n);

  // Step 4: Advance past endBlock (endBlock = 11 + 10 = 21)
  block = 22;
  assert.equal(engine.getProposalState(proposalId, block, time), ProposalState.Succeeded);

  // Step 5: Queue proposal in timelock
  const eta = engine.queueProposal(proposalId, block, time);
  assert.equal(eta, time + 86400);
  assert.equal(engine.getProposalState(proposalId, block, time), ProposalState.Queued);

  // Step 6: Attempt premature execution
  assert.throws(
    () => engine.executeProposal(proposalId, block, time + 5000),
    /TIMELOCK_NOT_MET/
  );

  // Step 7: Execute after timelock delay
  time = eta + 10;
  const executedActions = engine.executeProposal(proposalId, block, time);
  assert.equal(executedActions.length, 1);
  assert.equal(executedActions[0].target, '0xTarget');
  assert.equal(engine.getProposalState(proposalId, block, time), ProposalState.Executed);
});

test('Governance Engine: Flash-Loan Vote Borrowing Mitigation', () => {
  const engine = new GovernanceEngine({
    votingDelay: 1,
    votingPeriod: 10,
    proposalThreshold: 100_000n * 10n ** 18n,
    guardianAddress: GUARDIAN
  });

  engine.recordTotalSupply(1, 10_000_000n * 10n ** 18n);
  engine.recordVotingPower(PROPOSER, 1, 500_000n * 10n ** 18n);

  const block = 10;
  const time = 1000;

  const proposalId = engine.createProposal({
    proposer: PROPOSER,
    description: 'Security parameter change',
    actions: [{ target: '0xTarget', value: 0n, signature: 'update()', calldata: '0x' }],
    currentBlock: block,
    currentTime: time
  });

  // Proposal startBlock is 11.
  // In block 15, an attacker flash-borrows 5,000,000 tokens!
  engine.recordVotingPower(ATTACKER, 15, 5_000_000n * 10n ** 18n);

  // Attacker attempts to vote on proposal in block 15
  assert.throws(
    () =>
      engine.castVote({
        voter: ATTACKER,
        proposalId,
        support: VoteType.For,
        currentBlock: 15,
        currentTime: time + 50
      }),
    /ZERO_VOTING_POWER/
  );
});

test('Governance Engine: Double Voting Rejection', () => {
  const engine = new GovernanceEngine({ votingDelay: 1, votingPeriod: 10, proposalThreshold: 100_000n * 10n ** 18n });
  engine.recordTotalSupply(1, 10_000_000n * 10n ** 18n);
  engine.recordVotingPower(PROPOSER, 1, 500_000n * 10n ** 18n);
  engine.recordVotingPower(VOTER1, 1, 1_000_000n * 10n ** 18n);

  const proposalId = engine.createProposal({
    proposer: PROPOSER,
    description: 'Prop',
    actions: [{ target: '0xTarget', value: 0n, signature: 'test()', calldata: '0x' }],
    currentBlock: 10,
    currentTime: 1000
  });

  engine.castVote({
    voter: VOTER1,
    proposalId,
    support: VoteType.For,
    currentBlock: 12,
    currentTime: 1000
  });

  assert.throws(
    () =>
      engine.castVote({
        voter: VOTER1,
        proposalId,
        support: VoteType.For,
        currentBlock: 12,
        currentTime: 1000
      }),
    /ALREADY_VOTED/
  );
});

test('Governance Engine: Emergency Guardian Veto and Pause', () => {
  const engine = new GovernanceEngine({
    votingDelay: 1,
    votingPeriod: 10,
    proposalThreshold: 100_000n * 10n ** 18n,
    guardianAddress: GUARDIAN
  });

  engine.recordTotalSupply(1, 10_000_000n * 10n ** 18n);
  engine.recordVotingPower(PROPOSER, 1, 500_000n * 10n ** 18n);

  const proposalId = engine.createProposal({
    proposer: PROPOSER,
    description: 'Potentially malicious proposal',
    actions: [{ target: '0xTarget', value: 0n, signature: 'drain()', calldata: '0x' }],
    currentBlock: 10,
    currentTime: 1000
  });

  // Guardian vetoes proposal
  engine.vetoProposal(proposalId, GUARDIAN, 'Malicious payload signature detected');
  assert.equal(engine.getProposalState(proposalId, 12, 1000), ProposalState.Vetoed);

  // Unauthorized non-guardian cannot veto
  assert.throws(
    () => engine.vetoProposal(proposalId, VOTER1, 'fake'),
    /UNAUTHORIZED_GUARDIAN/
  );

  // Guardian pauses governance
  engine.pause(GUARDIAN, 1000);
  assert.equal(engine.isPaused(1000), true);

  // New proposal rejected while paused
  assert.throws(
    () =>
      engine.createProposal({
        proposer: PROPOSER,
        description: 'New while paused',
        actions: [{ target: '0xTarget', value: 0n, signature: 'test()', calldata: '0x' }],
        currentBlock: 12,
        currentTime: 1000
      }),
    /GOVERNANCE_PAUSED/
  );

  // Guardian unpauses
  engine.unpause(GUARDIAN);
  assert.equal(engine.isPaused(1000), false);
});

test('Governance Engine: Defensive Immutability & Deep Freezing', () => {
  const engine = new GovernanceEngine({ proposalThreshold: 100_000n * 10n ** 18n });
  engine.recordVotingPower(PROPOSER, 1, 500_000n * 10n ** 18n);

  const proposalId = engine.createProposal({
    proposer: PROPOSER,
    description: 'Immutability Check',
    actions: [{ target: '0xTarget', value: 0n, signature: 'test()', calldata: '0x' }],
    currentBlock: 10,
    currentTime: 1000
  });

  const prop = engine.getProposal(proposalId);
  assert.ok(prop);
  assert.ok(Object.isFrozen(prop));
  assert.throws(() => {
    // Attempting to mutate returned proposal property must throw in strict mode
    prop.canceled = true;
  });
});
