import { createHash } from 'node:crypto';

export enum ProposalState {
  Pending = 'Pending',
  Active = 'Active',
  Canceled = 'Canceled',
  Defeated = 'Defeated',
  Succeeded = 'Succeeded',
  Queued = 'Queued',
  Expired = 'Expired',
  Executed = 'Executed',
  Vetoed = 'Vetoed'
}

export enum VoteType {
  Against = 0,
  For = 1,
  Abstain = 2
}

export interface ActionCall {
  readonly target: string;
  readonly value: bigint;
  readonly signature: string;
  readonly calldata: string;
}

export interface VoteReceipt {
  readonly voter: string;
  readonly support: VoteType;
  readonly votes: bigint;
  readonly timestamp: number;
  readonly reason?: string;
}

export interface Proposal {
  readonly id: string;
  readonly proposer: string;
  readonly description: string;
  readonly actions: readonly ActionCall[];
  readonly startBlock: number;
  readonly endBlock: number;
  forVotes: bigint;
  againstVotes: bigint;
  abstainVotes: bigint;
  eta: number;
  canceled: boolean;
  executed: boolean;
  vetoed: boolean;
  vetoReason?: string;
  readonly receipts: Map<string, VoteReceipt>;
}

export interface VoterCheckpoint {
  readonly fromBlock: number;
  readonly votes: bigint;
}

export interface GovernanceEngineConfig {
  readonly votingDelay: number; // in blocks
  readonly votingPeriod: number; // in blocks
  readonly proposalThreshold: bigint;
  readonly quorumNumerator: bigint;
  readonly quorumDenominator: bigint;
  readonly timelockDelay: number; // in seconds
  readonly gracePeriod: number; // in seconds
  readonly guardianAddress: string;
}

export const DEFAULT_ENGINE_CONFIG: Readonly<GovernanceEngineConfig> = Object.freeze({
  votingDelay: 1,
  votingPeriod: 50400,
  proposalThreshold: 100_000n * 10n ** 18n,
  quorumNumerator: 4n,
  quorumDenominator: 100n,
  timelockDelay: 86400,
  gracePeriod: 14 * 86400,
  guardianAddress: '0x8888888888888888888888888888888888888888'
});

export class GovernanceEngine {
  private readonly config: GovernanceEngineConfig;
  private readonly proposals: Map<string, Proposal> = new Map();
  private readonly checkpoints: Map<string, VoterCheckpoint[]> = new Map();
  private readonly totalSupplyCheckpoints: VoterCheckpoint[] = [];
  private proposalSequence = 0;
  private paused = false;
  private pausedAt = 0;
  private readonly MAX_PAUSE_DURATION = 7 * 86400;

  constructor(config: Partial<GovernanceEngineConfig> = {}) {
    this.config = Object.freeze({
      ...DEFAULT_ENGINE_CONFIG,
      ...config
    });
  }

  public recordVotingPower(voter: string, blockNumber: number, votes: bigint): void {
    const list = this.checkpoints.get(voter) ?? [];
    if (list.length > 0 && list[list.length - 1].fromBlock === blockNumber) {
      list[list.length - 1] = { fromBlock: blockNumber, votes };
    } else {
      list.push({ fromBlock: blockNumber, votes });
    }
    this.checkpoints.set(voter, list);
  }

  public recordTotalSupply(blockNumber: number, totalSupply: bigint): void {
    if (
      this.totalSupplyCheckpoints.length > 0 &&
      this.totalSupplyCheckpoints[this.totalSupplyCheckpoints.length - 1].fromBlock === blockNumber
    ) {
      this.totalSupplyCheckpoints[this.totalSupplyCheckpoints.length - 1] = {
        fromBlock: blockNumber,
        votes: totalSupply
      };
    } else {
      this.totalSupplyCheckpoints.push({ fromBlock: blockNumber, votes: totalSupply });
    }
  }

  public getPastVotes(voter: string, blockNumber: number): bigint {
    const list = this.checkpoints.get(voter) ?? [];
    return this.lookupPastCheckpoint(list, blockNumber);
  }

  public getPastTotalSupply(blockNumber: number): bigint {
    return this.lookupPastCheckpoint(this.totalSupplyCheckpoints, blockNumber);
  }

  private lookupPastCheckpoint(checkpoints: readonly VoterCheckpoint[], blockNumber: number): bigint {
    const n = checkpoints.length;
    if (n === 0 || checkpoints[0].fromBlock > blockNumber) {
      return 0n;
    }

    let lower = 0;
    let upper = n - 1;

    while (upper > lower) {
      const center = Math.ceil((upper + lower) / 2);
      const cp = checkpoints[center];
      if (cp.fromBlock === blockNumber) {
        return cp.votes;
      } else if (cp.fromBlock < blockNumber) {
        lower = center;
      } else {
        upper = center - 1;
      }
    }

    return checkpoints[lower].votes;
  }

  public pause(by: string, currentTime: number): void {
    if (by.toLowerCase() !== this.config.guardianAddress.toLowerCase()) {
      throw new Error('UNAUTHORIZED_GUARDIAN');
    }
    if (this.isPaused(currentTime)) {
      throw new Error('ALREADY_PAUSED');
    }
    this.paused = true;
    this.pausedAt = currentTime;
  }

  public unpause(by: string): void {
    if (by.toLowerCase() !== this.config.guardianAddress.toLowerCase()) {
      throw new Error('UNAUTHORIZED_GUARDIAN');
    }
    if (!this.paused) {
      throw new Error('NOT_PAUSED');
    }
    this.paused = false;
    this.pausedAt = 0;
  }

  public isPaused(currentTime: number): boolean {
    if (!this.paused) return false;
    if (currentTime > this.pausedAt + this.MAX_PAUSE_DURATION) {
      return false; // Automatically unpauses after MAX_PAUSE_DURATION
    }
    return true;
  }

  public vetoProposal(proposalId: string, by: string, reason: string): void {
    if (by.toLowerCase() !== this.config.guardianAddress.toLowerCase()) {
      throw new Error('UNAUTHORIZED_GUARDIAN');
    }
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('PROPOSAL_NOT_FOUND');
    }
    if (proposal.executed) {
      throw new Error('CANNOT_VETO_EXECUTED_PROPOSAL');
    }
    proposal.vetoed = true;
    proposal.vetoReason = reason;
  }

  public createProposal(params: {
    proposer: string;
    description: string;
    actions: ActionCall[];
    currentBlock: number;
    currentTime: number;
    signature?: string;
  }): string {
    if (this.isPaused(params.currentTime)) {
      throw new Error('GOVERNANCE_PAUSED');
    }

    if (params.actions.length === 0) {
      throw new Error('EMPTY_PROPOSAL_ACTIONS');
    }

    const pastVotes = this.getPastVotes(params.proposer, params.currentBlock - 1);
    if (pastVotes < this.config.proposalThreshold) {
      throw new Error('PROPOSAL_THRESHOLD_NOT_MET');
    }

    if (params.signature) {
      const intentPayload = `${params.proposer}:PROPOSE:${params.description}`;
      const expectedSig = createHash('sha256').update(intentPayload).digest('hex');
      if (params.signature !== expectedSig) {
        throw new Error('INVALID_INTENT_SIGNATURE');
      }
    }

    this.proposalSequence++;
    const proposalId = String(this.proposalSequence);

    const startBlock = params.currentBlock + this.config.votingDelay;
    const endBlock = startBlock + this.config.votingPeriod;

    const proposal: Proposal = {
      id: proposalId,
      proposer: params.proposer,
      description: params.description,
      actions: params.actions.map(a => Object.freeze({ ...a })),
      startBlock,
      endBlock,
      forVotes: 0n,
      againstVotes: 0n,
      abstainVotes: 0n,
      eta: 0,
      canceled: false,
      executed: false,
      vetoed: false,
      receipts: new Map()
    };

    this.proposals.set(proposalId, proposal);
    return proposalId;
  }

  public castVote(params: {
    voter: string;
    proposalId: string;
    support: VoteType;
    currentBlock: number;
    currentTime: number;
    reason?: string;
    signature?: string;
  }): bigint {
    if (this.isPaused(params.currentTime)) {
      throw new Error('GOVERNANCE_PAUSED');
    }

    const proposal = this.proposals.get(params.proposalId);
    if (!proposal) {
      throw new Error('PROPOSAL_NOT_FOUND');
    }

    const currentState = this.getProposalState(params.proposalId, params.currentBlock, params.currentTime);
    if (currentState !== ProposalState.Active) {
      throw new Error(`PROPOSAL_NOT_ACTIVE: Current state is ${currentState}`);
    }

    if (proposal.receipts.has(params.voter.toLowerCase())) {
      throw new Error('ALREADY_VOTED');
    }

    if (params.support !== VoteType.Against && params.support !== VoteType.For && params.support !== VoteType.Abstain) {
      throw new Error('INVALID_VOTE_TYPE');
    }

    if (params.signature) {
      const intentPayload = `${params.voter}:VOTE:${params.proposalId}:${params.support}`;
      const expectedSig = createHash('sha256').update(intentPayload).digest('hex');
      if (params.signature !== expectedSig) {
        throw new Error('INVALID_INTENT_SIGNATURE');
      }
    }

    // Historical checkpoint voting weight evaluated strictly at startBlock snapshot
    const weight = this.getPastVotes(params.voter, proposal.startBlock);
    if (weight === 0n) {
      throw new Error('ZERO_VOTING_POWER');
    }

    if (params.support === VoteType.For) {
      proposal.forVotes += weight;
    } else if (params.support === VoteType.Against) {
      proposal.againstVotes += weight;
    } else {
      proposal.abstainVotes += weight;
    }

    proposal.receipts.set(params.voter.toLowerCase(), {
      voter: params.voter,
      support: params.support,
      votes: weight,
      timestamp: params.currentTime,
      reason: params.reason
    });

    return weight;
  }

  public queueProposal(proposalId: string, currentBlock: number, currentTime: number): number {
    if (this.isPaused(currentTime)) {
      throw new Error('GOVERNANCE_PAUSED');
    }

    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('PROPOSAL_NOT_FOUND');
    }

    const currentState = this.getProposalState(proposalId, currentBlock, currentTime);
    if (currentState !== ProposalState.Succeeded) {
      throw new Error(`CANNOT_QUEUE_UNSUCCEEDED_PROPOSAL: Current state is ${currentState}`);
    }

    const eta = currentTime + this.config.timelockDelay;
    proposal.eta = eta;
    return eta;
  }

  public executeProposal(proposalId: string, currentBlock: number, currentTime: number): readonly ActionCall[] {
    if (this.isPaused(currentTime)) {
      throw new Error('GOVERNANCE_PAUSED');
    }

    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('PROPOSAL_NOT_FOUND');
    }

    const currentState = this.getProposalState(proposalId, currentBlock, currentTime);
    if (currentState !== ProposalState.Queued) {
      throw new Error(`CANNOT_EXECUTE_PROPOSAL: Current state is ${currentState}`);
    }

    if (currentTime < proposal.eta) {
      throw new Error('TIMELOCK_NOT_MET');
    }

    if (currentTime > proposal.eta + this.config.gracePeriod) {
      throw new Error('TRANSACTION_EXPIRED');
    }

    proposal.executed = true;
    return Object.freeze([...proposal.actions]);
  }

  public cancelProposal(proposalId: string, by: string, currentBlock: number): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('PROPOSAL_NOT_FOUND');
    }

    if (proposal.executed || proposal.canceled) {
      throw new Error('PROPOSAL_TERMINAL_STATE');
    }

    const isGuardian = by.toLowerCase() === this.config.guardianAddress.toLowerCase();
    const isProposer = by.toLowerCase() === proposal.proposer.toLowerCase();
    const proposerLostThreshold = this.getPastVotes(proposal.proposer, currentBlock - 1) < this.config.proposalThreshold;

    if (!isGuardian && (!isProposer || !proposerLostThreshold)) {
      throw new Error('UNAUTHORIZED_CANCELLATION');
    }

    proposal.canceled = true;
  }

  public getProposalState(proposalId: string, currentBlock: number, currentTime: number): ProposalState {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('PROPOSAL_NOT_FOUND');
    }

    if (proposal.vetoed) return ProposalState.Vetoed;
    if (proposal.canceled) return ProposalState.Canceled;
    if (proposal.executed) return ProposalState.Executed;

    if (currentBlock <= proposal.startBlock) {
      return ProposalState.Pending;
    }

    if (currentBlock <= proposal.endBlock) {
      return ProposalState.Active;
    }

    const totalSupp = this.getPastTotalSupply(proposal.startBlock);
    const quorum = (totalSupp * this.config.quorumNumerator) / this.config.quorumDenominator;

    const quorumReached = proposal.forVotes + proposal.abstainVotes >= quorum;
    const voteSucceeded = proposal.forVotes > proposal.againstVotes;

    if (!quorumReached || !voteSucceeded) {
      return ProposalState.Defeated;
    }

    if (proposal.eta === 0) {
      return ProposalState.Succeeded;
    }

    if (currentTime > proposal.eta + this.config.gracePeriod) {
      return ProposalState.Expired;
    }

    return ProposalState.Queued;
  }

  public getProposal(proposalId: string): Readonly<Proposal> | undefined {
    const p = this.proposals.get(proposalId);
    if (!p) return undefined;

    return Object.freeze({
      ...p,
      actions: p.actions.map(a => Object.freeze({ ...a })),
      receipts: new Map(p.receipts)
    });
  }

  public getAllProposals(): readonly Readonly<Proposal>[] {
    return Object.freeze(
      Array.from(this.proposals.values()).map(p =>
        Object.freeze({
          ...p,
          actions: p.actions.map(a => Object.freeze({ ...a })),
          receipts: new Map(p.receipts)
        })
      )
    );
  }
}
