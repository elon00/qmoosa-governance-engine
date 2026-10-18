# QMOOSA Governance Engine (`qmoosa-governance-engine`)

## Overview
Part of the **QMOOSA 1,000 Crypto Projects Mission — Domain 1 (DeFi & Financial Invariants)**.
Repository ID: `047/1000`.

`qmoosa-governance-engine` delivers the state machine, checkpoint voter registry, timelock queue orchestrator, and guardian veto subsystem:
- **Proposal State Engine**: Coordinates deterministic transitions across `Pending`, `Active`, `Defeated`, `Succeeded`, `Queued`, `Executed`, `Canceled`, `Vetoed`, and `Expired`.
- **Checkpointed Historical Ledger**: Implements binary search voting power lookups based strictly on proposal snapshot blocks, extinguishing flash-loan vote borrowing.
- **Signed Intent Verification**: Enforces cryptographic intent signatures on proposal creation and vote submissions.
- **Emergency Guardian Controls**: Supports bounded duration emergency pause (max 7 days) and proposal veto mechanisms.
- **Defensive Immutability**: All proposal inspection methods return deep frozen copies (`Object.freeze`).

## Verification
- Unit & Invariant Testing: 5 Node.js engine reality tests.
- Zero-Spend Invariant: $0.00 spent on live networks. Mainnet and public testnets remain strictly locked.
