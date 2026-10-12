import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import anchor from "@coral-xyz/anchor";
import {
  createAccount,
  createMint,
  freezeAccount,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  thawAccount,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  escrowInvocations,
  solanaAwardId,
  solanaPaymentAdapter,
} from "../.local/adapter.mjs";
import { expectedDeployment } from "./deployment.mjs";

const { AnchorProvider, Program, BN } = anchor;
const provider = AnchorProvider.env();
const payer = provider.wallet.payer;
const program = new Program(
  JSON.parse(readFileSync("target/idl/slop_escrow.json")),
  provider,
);
const hash = (s) => [...createHash("sha256").update(s).digest()];
// A public test cluster keeps accounts between runs; a run salt gives each
// run new project accounts. Local runs leave it empty.
const RUN = process.env.SLOP_E2E_RUN ?? "";
const network = hash("solana:localnet:escrow-v2");
const bn = (x) => new BN(String(x));
const pda = (...seeds) =>
  PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const key = (x) => x.toBuffer();
const seed = (s) => Buffer.from(s);
const actorSeed = (id) => bn(id).toArrayLike(Buffer, "le", 8);
const DELAY = 8;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The validator clock follows wall time; wait past the binding delay.
const activate = () => sleep((DELAY + 2) * 1000);
const authority = Keypair.generate();
const feeOwner = Keypair.generate();
const recipient = Keypair.generate();
const late = Keypair.generate();
let mint, source, feeAccount, destination, lateDestination, project, vault;
const binding = (id) =>
  pda(
    seed("wallet"),
    key(authority.publicKey),
    Buffer.from(network),
    actorSeed(id),
  );
const awardOf = (origin) =>
  Buffer.from(
    solanaAwardId(
      project.toBase58(),
      Buffer.from(hash(`source:${origin}`)).toString("hex"),
    ),
    "hex",
  );
const obligation = (id) => pda(seed("award"), key(project), awardOf(id));
// Submission expiry for bind_wallet; the binding itself never expires.
const expiry = () => bn(Math.floor(Date.now() / 1000) + 3600);
const ledger = (actor) =>
  pda(seed("veto-count"), key(project), actorSeed(actor));
// The veto accounts always follow the stored latest and active versions, whatever
// version the payer names.
async function versionsOf(actor, named) {
  try {
    const b = await program.account.walletBinding.fetch(binding(actor));
    return { latest: b.version, active: b.activeVersion };
  } catch {
    return { latest: bn(named), active: bn(0) };
  }
}
async function commit(
  id,
  actor,
  principal,
  origin = id,
  awardId = awardOf(origin),
) {
  return program.methods
    .commit([...awardId], hash(`source:${origin}`), bn(actor), bn(principal))
    .accountsStrict({
      owner: payer.publicKey,
      project,
      vault,
      obligation: pda(seed("award"), key(project), awardId),
      origin: pda(
        seed("origin"),
        key(project),
        Buffer.from(hash(`source:${origin}`)),
      ),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}
async function bind(
  actor,
  address,
  expected = 0,
  domain = network,
  claim = hash(`claim:${actor}:${expected}`),
  expiresAt = expiry(),
) {
  return program.methods
    .bindWallet(bn(actor), domain, bn(expected), address, claim, expiresAt)
    .accountsStrict({
      payer: payer.publicKey,
      identityAuthority: authority.publicKey,
      project,
      binding: binding(actor),
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();
}
const veto = (actor, version) =>
  pda(seed("veto"), key(project), actorSeed(actor), actorSeed(version));
async function payInstruction(id, actor, address, version = 1) {
  const versions = await versionsOf(actor, version);
  return program.methods.pay(bn(version)).accountsStrict({
    project,
    obligation: obligation(id),
    binding: binding(actor),
    mint,
    vault,
    destination: address,
    feeAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
    veto: veto(actor, versions.latest),
    activeVeto: veto(actor, versions.active),
  });
}
async function pay(id, actor, address, version = 1) {
  return (await payInstruction(id, actor, address, version)).rpc();
}
// `award` names an unpaid award whose commit delay extends the veto window.
function vetoBinding(actor, version, signer = payer, award = null) {
  return program.methods
    .vetoBinding(bn(actor), bn(version))
    .accountsStrict({
      owner: signer.publicKey,
      project,
      binding: binding(actor),
      veto: veto(actor, version),
      ledger: ledger(actor),
      obligation: award ? obligation(award) : null,
      systemProgram: SystemProgram.programId,
    })
    .signers(signer === payer ? [] : [signer])
    .rpc();
}
async function parsedTransaction(signature) {
  const response = await fetch(provider.connection.rpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        {
          commitment: "finalized",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        },
      ],
    }),
  });
  return (await response.json()).result;
}
function withdraw(amount) {
  return program.methods
    .withdraw(bn(amount))
    .accountsStrict({
      owner: payer.publicKey,
      project,
      mint,
      vault,
      destination: source,
      feeAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}
const service = (digest) =>
  pda(seed("service"), key(project), Buffer.from(digest));
function chargeService(amount, digest, signer = payer) {
  return program.methods
    .chargeService(bn(amount), digest)
    .accountsStrict({
      owner: signer.publicKey,
      project,
      mint,
      vault,
      feeAccount,
      charge: service(digest),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers(signer === payer ? [] : [signer])
    .rpc();
}
const balance = async (address) =>
  (await getAccount(provider.connection, address)).amount;
test("actual SPL escrow lifecycle, late wallet claim, reserve and authority attacks", async () => {
  mint = await createMint(
    provider.connection,
    payer,
    payer.publicKey,
    payer.publicKey,
    6,
  );
  source = await createAccount(
    provider.connection,
    payer,
    mint,
    payer.publicKey,
  );
  feeAccount = await createAccount(
    provider.connection,
    payer,
    mint,
    feeOwner.publicKey,
  );
  destination = await createAccount(
    provider.connection,
    payer,
    mint,
    recipient.publicKey,
  );
  lateDestination = await createAccount(
    provider.connection,
    payer,
    mint,
    late.publicKey,
  );
  await mintTo(provider.connection, payer, mint, source, payer, 1_000_000_000n);
  project = pda(
    seed("project"),
    key(payer.publicKey),
    Buffer.from(hash(`project${RUN}`)),
  );
  vault = pda(seed("vault"), key(project));
  await program.methods
    .initialize(
      hash(`project${RUN}`),
      network,
      authority.publicKey,
      feeOwner.publicKey,
      bn(DELAY),
    )
    .accountsStrict({
      owner: payer.publicKey,
      project,
      mint,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await program.methods
    .deposit(bn(1_000_000_000))
    .accountsStrict({
      owner: payer.publicKey,
      project,
      mint,
      source,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  const firstCommit = await commit("first", 101, 100_000_000);
  await commit("late", 102, 50_000_000);
  assert.equal(
    (await program.account.project.fetch(project)).reserved.toString(),
    "150000000",
  );
  await assert.rejects(withdraw(1_000_000_000), /InsufficientFreeBalance/);
  await assert.rejects(
    commit("overspend", 103, 1_000_000_000),
    /InsufficientFreeBalance/,
  );
  await assert.rejects(
    pay("late", 102, lateDestination),
    /AccountNotInitialized/,
  );
  // Let both awards pass their commit delay so the binding delay is what rejects.
  await activate();
  await bind(101, recipient.publicKey);
  await assert.rejects(pay("first", 101, destination), /BindingPending/);
  await activate();
  await assert.rejects(vetoBinding(101, 1), /BindingActive/);
  await assert.rejects(bind(101, late.publicKey), /StaleBinding/);
  await assert.rejects(bind(102, late.publicKey, 0, hash("different-network")));
  await assert.rejects(
    pay("first", 101, lateDestination),
    /ConstraintRaw|WrongDestination/,
  );
  await assert.rejects(
    program.methods
      .bindWallet(
        bn(101),
        network,
        bn(1),
        late.publicKey,
        hash("bad-claim"),
        expiry(),
      )
      .accountsStrict({
        payer: payer.publicKey,
        identityAuthority: payer.publicKey,
        project,
        binding: binding(101),
        systemProgram: SystemProgram.programId,
      })
      .rpc(),
  );
  await freezeAccount(provider.connection, payer, destination, mint, payer);
  await assert.rejects(pay("first", 101, destination));
  assert.equal(await balance(feeAccount), 0n);
  assert.equal(
    (await program.account.obligation.fetch(obligation("first"))).paid,
    false,
  );
  await thawAccount(provider.connection, payer, destination, mint, payer);
  const firstPayment = await pay("first", 101, destination);
  assert.equal(await balance(destination), 98_000_000n);
  assert.equal(await balance(feeAccount), 2_000_000n);
  await assert.rejects(pay("first", 101, destination), /AlreadyPaid/);
  await assert.rejects(commit("first", 101, 100_000_000));
  // An award ID that is not bound to this project and source is rejected.
  await assert.rejects(
    commit("forged", 101, 1, "forged", Buffer.from(hash("forged-id"))),
    /InvalidAward/,
  );
  await assert.rejects(
    program.methods
      .withdraw(bn(1))
      .accountsStrict({
        owner: authority.publicKey,
        project,
        mint,
        vault,
        destination: source,
        feeAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc(),
    /ConstraintHasOne/,
  );
  const wrongMint = await createMint(
    provider.connection,
    payer,
    payer.publicKey,
    null,
    6,
  );
  const wrongDestination = await createAccount(
    provider.connection,
    payer,
    wrongMint,
    late.publicKey,
  );
  await bind(102, late.publicKey);
  await activate();
  await assert.rejects(
    pay("late", 102, wrongDestination),
    /ConstraintTokenMint|WrongDestination/,
  );
  // PAY-10: the owner pays one Slopbot invoice from free funds only. The 50
  // reserved for actor 102 cannot be charged, and an invoice pays once.
  const invoice = hash("invoice:local:2026-10");
  await assert.rejects(
    chargeService(850_000_001, invoice),
    /InsufficientFreeBalance/,
  );
  await assert.rejects(chargeService(1, Array(32).fill(0)), /InvalidAmount/);
  const stranger = Keypair.generate();
  await sendAndConfirmTransaction(
    provider.connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: stranger.publicKey,
        lamports: 100_000_000,
      }),
    ),
    [payer],
  );
  await assert.rejects(chargeService(1, invoice, stranger), /ConstraintHasOne/);
  await chargeService(20_000_000, invoice);
  assert.equal(await balance(feeAccount), 22_000_000n);
  await assert.rejects(chargeService(20_000_000, invoice));
  const charged = await program.account.serviceCharge.fetch(service(invoice));
  assert.equal(charged.amount.toString(), "20000000");
  assert.equal(await balance(feeAccount), 22_000_000n);
  // Split withdrawals cannot avoid the cumulative 10% charge.
  await withdraw(1);
  await withdraw(829_999_999);
  assert.equal(await balance(source), 747_000_000n);
  assert.equal(await balance(feeAccount), 105_000_000n);
  await assert.rejects(withdraw(1), /InsufficientFreeBalance/);
  // A stolen authority key rebinds actor 102 to a thief. Only the owner can
  // veto it, and only while it is pending; the vetoed version never pays.
  const thief = Keypair.generate();
  const thiefDestination = await createAccount(
    provider.connection,
    payer,
    mint,
    thief.publicKey,
  );
  await bind(102, thief.publicKey, 1);
  // Fund the identity key so the owner check, not rent, rejects its veto.
  await sendAndConfirmTransaction(
    provider.connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: authority.publicKey,
        lamports: 100_000_000,
      }),
    ),
    [payer],
  );
  await assert.rejects(vetoBinding(102, 2, authority), /ConstraintHasOne/);
  await vetoBinding(102, 2);
  await activate();
  await assert.rejects(pay("late", 102, thiefDestination, 2), /BindingVetoed/);
  assert.equal(await balance(thiefDestination), 0n);
  await bind(102, recipient.publicKey, 2);
  // Actor 102 has never been paid, so nothing pays while version 3 is pending.
  await assert.rejects(pay("late", 102, destination, 2), /BindingPending/);
  await activate();
  await assert.rejects(pay("late", 102, destination, 2), /StaleBinding/);
  // A third party pays with unrelated token movements in the same transaction.
  // The adapter must still verify this payment from its own instruction.
  const polluted = await sendAndConfirmTransaction(
    provider.connection,
    new Transaction().add(
      await (await payInstruction("late", 102, destination, 3)).instruction(),
      (await import("@solana/spl-token")).createTransferInstruction(
        source,
        destination,
        payer.publicKey,
        1n,
      ),
    ),
    [payer],
  );
  assert.equal(await balance(destination), 147_000_001n);
  assert.equal(await balance(feeAccount), 106_000_000n);
  assert.equal(await balance(vault), 0n);
  const state = await program.account.project.fetch(project);
  assert.equal(state.reserved.toString(), "0");
  assert.equal(state.paid.toString(), "147000000");
  assert.equal(state.payoutFees.toString(), "3000000");
  assert.equal(state.withdrawalFees.toString(), "83000000");
  assert.equal(state.serviceFees.toString(), "20000000");
  assert.equal(
    (await balance(source)) +
      (await balance(destination)) +
      (await balance(feeAccount)) +
      (await balance(vault)),
    1_000_000_000n,
  );
  await provider.connection.confirmTransaction(firstPayment, "finalized");
  await provider.connection.confirmTransaction(polluted, "finalized");
  const evidence = {
    programId: program.programId.toBase58(),
    genesisHash: await provider.connection.getGenesisHash(),
    signature: firstPayment,
    project: project.toBase58(),
    awardId: awardOf("first").toString("hex"),
    sourceDigest: Buffer.from(hash("source:first")).toString("hex"),
    actorId: 101,
    gross: "100000000",
    principal: "98000000",
    fee: "2000000",
    walletVersion: 1,
    destinationOwner: recipient.publicKey.toBase58(),
    destinationAccount: destination.toBase58(),
    vault: vault.toBase58(),
    feeAccount: feeAccount.toBase58(),
    mint: mint.toBase58(),
    network: Buffer.from(network).toString("hex"),
  };
  const workerAdapter = solanaPaymentAdapter({
    rpcUrl: provider.connection.rpcEndpoint,
    genesisHash: evidence.genesisHash,
    programId: evidence.programId,
    projectPda: evidence.project,
    projectId: "local-project",
    network: "solana:localnet",
    networkDomain: evidence.network,
    vault: evidence.vault,
    mint: evidence.mint,
    owner: payer.publicKey.toBase58(),
    identityAuthority: authority.publicKey.toBase58(),
    feeRecipient: feeOwner.publicKey.toBase58(),
    ...expectedDeployment,
    bindingDelaySeconds: String(DELAY),
  });
  for (const [signature, kind] of [
    [firstCommit, "reserved"],
    [firstPayment, "paid"],
  ]) {
    const [invocation] = escrowInvocations(
      await parsedTransaction(signature),
      evidence.programId,
    );
    const input = {
      transactionId: signature,
      eventIndex: invocation.index,
      kind,
      obligationId: evidence.awardId,
    };
    const normalized = await workerAdapter.verifyFinalized(input);
    assert.equal(normalized.grossMicro, "100000000");
    assert.equal(normalized.netMicro, "98000000");
    assert.equal(normalized.githubUserId, "101");
    if (kind === "paid")
      assert.equal(normalized.destination, recipient.publicKey.toBase58());
    await assert.rejects(
      workerAdapter.verifyFinalized({
        ...input,
        eventIndex: invocation.index + 1,
      }),
      /Exact escrow instruction/,
    );
  }
  const [pollutedPay] = escrowInvocations(
    await parsedTransaction(polluted),
    evidence.programId,
  );
  const pollutedEvidence = await workerAdapter.verifyFinalized({
    transactionId: polluted,
    eventIndex: pollutedPay.index,
    kind: "paid",
    obligationId: awardOf("late").toString("hex"),
  });
  assert.equal(pollutedEvidence.netMicro, "49000000");
  assert.equal(pollutedEvidence.destination, recipient.publicKey.toBase58());
  await mintTo(provider.connection, payer, mint, vault, payer, 1_000_000n);
  await assert.rejects(withdraw(1), /InsufficientFreeBalance/);
  await assert.rejects(
    commit("unsolicited", 105, 1),
    /InsufficientFreeBalance/,
  );
  assert.equal(await balance(vault), 1_000_000n);
});

// Binding lifecycle after the 12 October 2026 review (M-1, M-2, L-1 to L-5).
test("commit delay, active binding through rotation, veto cap, bounded delay, bind and fee checks", async () => {
  const ata = async (owner) =>
    createAccount(provider.connection, payer, mint, owner);
  const walletA = Keypair.generate(),
    walletB = Keypair.generate(),
    walletC = Keypair.generate(),
    walletD = Keypair.generate();
  const [ataA, ataB, ataC, ataD] = await Promise.all(
    [walletA, walletB, walletC, walletD].map((k) => ata(k.publicKey)),
  );
  await mintTo(provider.connection, payer, mint, source, payer, 100_000_000n);
  await program.methods
    .deposit(bn(100_000_000))
    .accountsStrict({
      owner: payer.publicKey,
      project,
      mint,
      source,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  // M-1: a binding armed before any award pays only after the award's own delay, and
  // the owner can veto it inside that window by naming the unpaid award.
  await bind(201, walletA.publicKey);
  await activate();
  await commit("m1", 201, 10_000_000);
  await assert.rejects(pay("m1", 201, ataA), /AwardPending/);
  await assert.rejects(vetoBinding(201, 1), /BindingActive/);
  await vetoBinding(201, 1, payer, "m1");
  await activate();
  await assert.rejects(pay("m1", 201, ataA), /BindingVetoed/);
  assert.equal(await balance(ataA), 0n);
  await bind(201, walletA.publicKey, 1);
  await activate();
  await pay("m1", 201, ataA, 2);
  assert.equal(await balance(ataA), 9_800_000n);
  // A binding that has paid cannot be vetoed, even while a new award is in its window.
  await commit("m1b", 201, 1_000_000);
  await assert.rejects(vetoBinding(201, 2, payer, "m1b"), /BindingActive/);
  assert.equal(
    (
      await program.account.walletBinding.fetch(binding(201))
    ).activeVersion.toString(),
    "2",
  );
  // M-2: a rotation leaves the active binding payable, and a veto of the pending
  // rotation only keeps payments on the active binding.
  await commit("m2", 201, 10_000_000);
  await activate();
  await bind(201, walletB.publicKey, 2);
  await assert.rejects(pay("m2", 201, ataB, 3), /BindingPending/);
  await pay("m2", 201, ataA, 2);
  await pay("m1b", 201, ataA, 2);
  await commit("m3", 201, 10_000_000);
  await vetoBinding(201, 3);
  await activate();
  await assert.rejects(pay("m3", 201, ataB, 3), /BindingVetoed/);
  await pay("m3", 201, ataA, 2);
  assert.equal(await balance(ataA), 30_380_000n);
  assert.equal(await balance(ataB), 0n);
  // The cap does not apply once the actor has an active binding.
  await bind(201, walletB.publicKey, 3);
  await vetoBinding(201, 4);
  await bind(201, walletB.publicKey, 4);
  await vetoBinding(201, 5);
  await bind(201, walletB.publicKey, 5);
  await vetoBinding(201, 6);
  // A rotation that is not vetoed moves the destination once its delay passes.
  await commit("m4", 201, 10_000_000);
  await bind(201, walletB.publicKey, 6);
  await activate();
  await assert.rejects(pay("m4", 201, ataA, 2), /StaleBinding/);
  await pay("m4", 201, ataB, 7);
  assert.equal(await balance(ataB), 9_800_000n);
  // Veto cap: before the actor's first payment the owner gets three vetoes.
  await commit("c1", 202, 10_000_000);
  for (let version = 1; version <= 3; version++) {
    await bind(202, walletC.publicKey, version - 1);
    await vetoBinding(202, version);
  }
  assert.equal((await program.account.vetoLedger.fetch(ledger(202))).count, 3);
  await bind(202, walletC.publicKey, 3);
  await assert.rejects(vetoBinding(202, 4), /VetoLimit/);
  await activate();
  await pay("c1", 202, ataC, 4);
  assert.equal(await balance(ataC), 9_800_000n);
  // L-4: bind_wallet rejects the project and vault PDAs, a zero claim digest and an
  // expired submission.
  await assert.rejects(bind(203, project), /InvalidIdentity/);
  await assert.rejects(bind(203, vault), /InvalidIdentity/);
  await assert.rejects(
    bind(203, walletD.publicKey, 0, network, Array(32).fill(0)),
    /InvalidIdentity/,
  );
  await assert.rejects(
    bind(203, walletD.publicKey, 0, network, hash("claim"), bn(1)),
    /BindingExpired/,
  );
  // L-2: a 49-unit award has a zero fee, so a frozen fee account does not stop it.
  await commit("zero-fee", 204, 49);
  await bind(204, walletD.publicKey);
  await activate();
  await freezeAccount(provider.connection, payer, feeAccount, mint, payer);
  const zeroFee = await pay("zero-fee", 204, ataD);
  await thawAccount(provider.connection, payer, feeAccount, mint, payer);
  assert.equal(await balance(ataD), 49n);
  await provider.connection.confirmTransaction(zeroFee, "finalized");
  const [zeroFeePay] = escrowInvocations(
    await parsedTransaction(zeroFee),
    program.programId.toBase58(),
  );
  assert.equal(zeroFeePay.children.length, 1);
  const zeroFeeAdapter = solanaPaymentAdapter({
    rpcUrl: provider.connection.rpcEndpoint,
    genesisHash: await provider.connection.getGenesisHash(),
    programId: program.programId.toBase58(),
    projectPda: project.toBase58(),
    projectId: "local-project",
    network: "solana:localnet",
    networkDomain: Buffer.from(network).toString("hex"),
    vault: vault.toBase58(),
    mint: mint.toBase58(),
    owner: payer.publicKey.toBase58(),
    identityAuthority: authority.publicKey.toBase58(),
    feeRecipient: feeOwner.publicKey.toBase58(),
    ...expectedDeployment,
    bindingDelaySeconds: String(DELAY),
  });
  const zeroFeeEvidence = await zeroFeeAdapter.verifyFinalized({
    transactionId: zeroFee,
    eventIndex: zeroFeePay.index,
    kind: "paid",
    obligationId: awardOf("zero-fee").toString("hex"),
  });
  assert.equal(zeroFeeEvidence.feeMicro, "0");
  assert.equal(zeroFeeEvidence.netMicro, "49");
  // L-1 and L-3: initialize rejects an out-of-range delay and a fee recipient equal to
  // the owner or the project.
  const initialize = (
    delay,
    feeRecipient = feeOwner.publicKey,
    label = "x",
  ) => {
    const id = hash(`bounds:${label}:${delay}${RUN}`);
    const p = pda(seed("project"), key(payer.publicKey), Buffer.from(id));
    return program.methods
      .initialize(id, network, authority.publicKey, feeRecipient, bn(delay))
      .accountsStrict({
        owner: payer.publicKey,
        project: p,
        mint,
        vault: pda(seed("vault"), key(p)),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  };
  await assert.rejects(initialize(0), /InvalidDelay/);
  await assert.rejects(initialize(30 * 86400 + 1), /InvalidDelay/);
  await assert.rejects(initialize(DELAY, payer.publicKey), /InvalidIdentity/);
  const selfId = hash(`bounds:self:${DELAY}${RUN}`);
  await assert.rejects(
    initialize(
      DELAY,
      pda(seed("project"), key(payer.publicKey), Buffer.from(selfId)),
      "self",
    ),
    /InvalidIdentity/,
  );
  await initialize(30 * 86400, feeOwner.publicKey, "max");
});
